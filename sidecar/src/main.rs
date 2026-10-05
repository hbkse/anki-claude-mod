//! anki-claude-mod-sidecar: a one-shot CLI over Anki's Rust core (rslib).
//!
//! Each command opens the local collection, does one thing, closes it and
//! prints one JSON object on stdout. The anki-claude-mod mod runs it through
//! `$.process.run`, one call at a time: the collection is opened with an
//! exclusive lock, so two calls at once would see `busy`.
//!
//! Commands:
//!   login            stdin {"username","password"}; stores the AnkiWeb host key
//!   logout           forgets the host key (keeps the collection)
//!   status           whether we're logged in and have a collection
//!   sync [--full-download|--full-upload]
//!   decks            the collection's normal decks
//!   next [--deck NAME]
//!   answer --card ID --rating again|hard|good|easy [--ms N]

use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::LazyLock;

use anki::collection::CollectionBuilder;
use anki::error::DbErrorKind;
use anki::error::SyncErrorKind;
use anki::prelude::*;
use anki::scheduler::answering::CardAnswer;
use anki::scheduler::answering::Rating;
use anki::sync::collection::normal::SyncActionRequired;
use anki::sync::login::sync_login;
use anki::sync::login::SyncAuth;
use anki::text::decode_entities;
use anki::text::html_to_text_line;
use regex::Regex;
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use serde_json::Value;

type Out = std::result::Result<Value, Fail>;

/// An error the mod can act on: `code` is stable, `message` is for people.
struct Fail {
    code: &'static str,
    message: String,
}

fn fail(code: &'static str, message: impl Into<String>) -> Fail {
    Fail {
        code,
        message: message.into(),
    }
}

impl From<AnkiError> for Fail {
    fn from(err: AnkiError) -> Self {
        // The same plain wording Anki itself shows, rather than a bare "DbError".
        let message = html_to_text_line(&err.message(&I18n::template_only()), false).into_owned();
        match err {
            // rslib opens the collection with an exclusive lock
            AnkiError::DbError { source } => match source.kind {
                DbErrorKind::Locked => fail("busy", "the collection is open in another session"),
                DbErrorKind::FileTooNew => {
                    fail("anki", "this collection is from a newer Anki; update the anki plugin with /plugin update")
                }
                // Anki's own wording here is debug text, so say what to do instead.
                _ => fail(
                    "anki",
                    "the collection file couldn't be read and may be damaged. With AnkiWeb, /anki download \
                     replaces it with AnkiWeb's copy; with local decks, open them in Anki desktop and run \
                     Tools > Check Database",
                ),
            },
            AnkiError::SyncError { source } if matches!(source.kind, SyncErrorKind::AuthFailed) => {
                fail("auth", "AnkiWeb rejected the login; run /anki login again")
            }
            AnkiError::SyncError { .. } => fail("sync", message),
            AnkiError::NetworkError { .. } => fail("network", message),
            _ => fail("anki", message),
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Auth {
    username: String,
    hkey: String,
    /// Set when AnkiWeb redirects us to the shard that holds the account.
    endpoint: Option<String>,
    /// False until the first sync completes; a fresh local collection always
    /// takes AnkiWeb's copy when a full sync is required.
    has_synced: bool,
}

fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("ANKI_CLAUDE_MOD_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("anki-claude-mod")
}

/// The sidecar's own copy, the one it syncs with AnkiWeb.
fn own_col_path() -> PathBuf {
    data_dir().join("collection.anki2")
}

fn local_path() -> PathBuf {
    data_dir().join("local.json")
}

/// Set by `setup`: a collection on this computer (usually Anki desktop's),
/// reviewed in place instead of the AnkiWeb copy.
fn local_collection() -> Option<PathBuf> {
    #[derive(Deserialize)]
    struct Local {
        collection: PathBuf,
    }
    let local: Local = serde_json::from_slice(&fs::read(local_path()).ok()?).ok()?;
    Some(local.collection)
}

/// Anki desktop's current schema since 2.1.50. A collection on another one is
/// left alone: opening it would upgrade it under the Anki that owns it.
const SCHEMA_VERSION: i64 = 18;

/// Checks a local collection before rslib opens it, without changing it.
fn check_local(path: &std::path::Path) -> std::result::Result<(), Fail> {
    if !path.is_file() {
        return Err(fail("local_missing", format!("no collection at {}; run /anki setup again", path.display())));
    }
    // Anki desktop keeps its collection open while it runs, and SQLite then
    // blocks anyone else until it lets go, reads included. So look on a
    // thread, and take no answer within a moment to mean Anki has it open.
    let probe_path = path.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let ver = rusqlite::Connection::open_with_flags(&probe_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .and_then(|db| db.query_row("select ver from col", [], |row| row.get::<_, i64>(0)));
        let _ = tx.send(ver);
    });
    // A blocked thread is left behind; the process exits right after.
    let Ok(ver) = rx.recv_timeout(std::time::Duration::from_millis(500)) else {
        return Err(desktop_open());
    };
    match ver {
        Ok(SCHEMA_VERSION) => Ok(()),
        Ok(ver) if ver < SCHEMA_VERSION => Err(fail(
            "old_collection",
            "this collection is from an Anki older than 2.1.50; update Anki desktop and open it there once",
        )),
        Ok(_) => Err(fail("new_collection", "this collection is from a newer Anki; update the anki plugin with /plugin update")),
        Err(rusqlite::Error::SqliteFailure(e, _)) if matches!(e.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            Err(desktop_open())
        }
        Err(e) => Err(fail("anki", format!("not an Anki collection: {e}"))),
    }
}

fn desktop_open() -> Fail {
    fail("desktop_open", "Anki desktop has this collection open; anki picks up again once it's closed")
}

fn auth_path() -> PathBuf {
    data_dir().join("auth.json")
}

fn read_auth() -> Option<Auth> {
    serde_json::from_slice(&fs::read(auth_path()).ok()?).ok()
}

fn write_auth(auth: &Auth) -> std::result::Result<(), Fail> {
    let path = auth_path();
    let text = serde_json::to_vec_pretty(auth).map_err(|e| fail("io", e.to_string()))?;
    fs::write(&path, text).map_err(|e| fail("io", e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// The local collection when it's the one in use: AnkiWeb, once logged in,
/// takes priority over it.
fn active_local() -> Option<PathBuf> {
    if read_auth().is_some() {
        return None;
    }
    local_collection()
}

fn open() -> std::result::Result<Collection, Fail> {
    fs::create_dir_all(data_dir()).map_err(|e| fail("io", e.to_string()))?;
    let Some(local) = active_local() else {
        return Ok(CollectionBuilder::new(own_col_path()).build()?);
    };
    open_local(&local)
}

fn open_local(local: &std::path::Path) -> std::result::Result<Collection, Fail> {
    check_local(local)?;
    CollectionBuilder::new(local).build().map_err(|e| match Fail::from(e) {
        Fail { code: "busy", .. } => desktop_open(),
        other => other,
    })
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
}

// AnkiWeb's nginx doesn't proxy http2, so desktop Anki pins http1 too.
fn client() -> reqwest::Client {
    reqwest::Client::builder().http1_only().build().expect("http client")
}

fn sync_auth(auth: &Auth) -> std::result::Result<SyncAuth, Fail> {
    let endpoint = match &auth.endpoint {
        // join("./") gives the URL the trailing slash rslib's joins expect,
        // as desktop Anki does.
        Some(url) => Some(
            reqwest::Url::parse(url)
                .and_then(|u| u.join("./"))
                .map_err(|_| fail("anki", format!("bad endpoint {url}")))?,
        ),
        None => None,
    };
    Ok(SyncAuth {
        hkey: auth.hkey.clone(),
        endpoint,
        io_timeout_secs: None,
    })
}

fn check_endpoint(endpoint: Option<String>) -> std::result::Result<Option<String>, Fail> {
    let endpoint = endpoint.filter(|e| !e.trim().is_empty());
    if let Some(url) = &endpoint {
        url.parse::<reqwest::Url>()
            .map_err(|_| fail("usage", format!("bad sync server {url}")))?;
    }
    Ok(endpoint)
}

/// Keeps `hkey` as the login, as Anki keeps it: the password is never stored.
fn save_login(username: &str, hkey: String, endpoint: Option<String>) -> std::result::Result<(), Fail> {
    fs::create_dir_all(data_dir()).map_err(|e| fail("io", e.to_string()))?;
    // A different account's collection must never sync into this one.
    if read_auth().is_some_and(|p| p.username != username) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{suffix}", own_col_path().display()));
        }
    }
    write_auth(&Auth {
        username: username.to_string(),
        hkey,
        endpoint,
        has_synced: false,
    })
}

fn exchange(username: &str, password: String, endpoint: Option<String>) -> Out {
    let auth = runtime()
        .block_on(sync_login(username.to_string(), password, endpoint.clone(), client()))
        .map_err(|e| match Fail::from(e) {
            Fail { code: "auth", .. } => fail("auth", "AnkiWeb rejected that email or password"),
            other => other,
        })?;
    save_login(username, auth.hkey, endpoint)?;
    Ok(json!({ "username": username }))
}

/// `login`: {"username","password","endpoint"?} on stdin, for scripts and tests.
fn login() -> Out {
    #[derive(Deserialize)]
    struct Credentials {
        username: String,
        password: String,
        /// A self-hosted sync server; AnkiWeb when absent.
        endpoint: Option<String>,
    }
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| fail("io", e.to_string()))?;
    let creds: Credentials = serde_json::from_str(&input)
        .map_err(|_| fail("usage", "login reads {\"username\",\"password\"} on stdin"))?;
    exchange(&creds.username, creds.password, check_endpoint(creds.endpoint)?)
}

/// `login --interactive`: the window `/anki login` opens. Asks in the
/// terminal, the password unechoed, and talks to a person, not the mod.
fn login_interactive(endpoint: Option<String>) -> ExitCode {
    use std::io::Write;

    let endpoint = match check_endpoint(endpoint) {
        Ok(e) => e,
        Err(Fail { message, .. }) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };
    let server = endpoint.as_deref().unwrap_or("AnkiWeb (sync.ankiweb.net)");
    println!(
        "anki for Claude Code: log in to AnkiWeb to sync your decks (once)\n\n\
         Your email and password go only to {server}, the same way Anki and\n\
         AnkiDroid log in. It answers with a sync key, and that key is all\n\
         the anki plugin keeps: your password is not saved anywhere.\n\
         To use decks from Anki desktop without AnkiWeb, close this window\n\
         and run /anki setup instead.\n\
         Details: https://github.com/hbkse/anki-claude-mod#how-your-password-is-handled\n"
    );

    let close = |code: ExitCode| {
        print!("\nPress Enter to close this window.");
        let _ = std::io::stdout().flush();
        let _ = std::io::stdin().read_line(&mut String::new());
        code
    };
    for _ in 0..3 {
        print!("AnkiWeb email: ");
        let _ = std::io::stdout().flush();
        let mut username = String::new();
        if std::io::stdin().read_line(&mut username).unwrap_or(0) == 0 {
            return ExitCode::FAILURE;
        }
        let username = username.trim().to_string();
        let Ok(password) = rpassword::prompt_password("Password (not shown as you type): ") else {
            return ExitCode::FAILURE;
        };
        match exchange(&username, password, endpoint.clone()) {
            Ok(_) => {
                println!("\nLogged in as {username}. Back in Claude Code, your cards show up on your next prompt.");
                return close(ExitCode::SUCCESS);
            }
            Err(Fail { code: "auth", message }) => println!("\n{message}. Try again.\n"),
            Err(Fail { message, .. }) => {
                println!("\nCouldn't log in: {message}");
                return close(ExitCode::FAILURE);
            }
        }
    }
    close(ExitCode::FAILURE)
}

/// `local-collections`: the collection of every Anki desktop profile here.
fn local_collections() -> Out {
    let mut out = vec![];
    if let Some(Ok(entries)) = desktop_dir().map(fs::read_dir) {
        for entry in entries.flatten() {
            let path = entry.path().join("collection.anki2");
            if path.is_file() {
                out.push(json!({ "profile": entry.file_name().to_string_lossy(), "path": path }));
            }
        }
    }
    out.sort_by(|a, b| a["profile"].as_str().cmp(&b["profile"].as_str()));
    Ok(json!({ "collections": out }))
}

/// `setup --collection PATH`: review that collection in place. PATH is the
/// collection.anki2 file, its profile folder, or Anki's data folder when it
/// holds one profile.
fn setup(path: &str) -> Out {
    let given = PathBuf::from(path.trim());
    let path = if given.is_file() {
        given
    } else if given.join("collection.anki2").is_file() {
        given.join("collection.anki2")
    } else {
        let profiles: Vec<PathBuf> = fs::read_dir(&given)
            .map_err(|_| fail("local_missing", format!("no Anki collection at {}", given.display())))?
            .flatten()
            .map(|e| e.path().join("collection.anki2"))
            .filter(|p| p.is_file())
            .collect();
        match profiles.as_slice() {
            [one] => one.clone(),
            [] => return Err(fail("local_missing", format!("no Anki collection in {}", given.display()))),
            _ => return Err(fail("choose_profile", "that folder has several profiles; point at one of them")),
        }
    };
    let path = path.canonicalize().map_err(|e| fail("io", e.to_string()))?;
    // Anki desktop being open only matters when reviewing; setup can go ahead.
    let is_open = match check_local(&path) {
        Ok(()) => false,
        Err(Fail { code: "desktop_open", .. }) => true,
        Err(other) => return Err(other),
    };
    fs::create_dir_all(data_dir()).map_err(|e| fail("io", e.to_string()))?;
    fs::write(local_path(), serde_json::to_vec_pretty(&json!({ "collection": path })).unwrap())
        .map_err(|e| fail("io", e.to_string()))?;
    Ok(json!({ "collection": path, "desktopOpen": is_open, "ankiwebActive": read_auth().is_some() }))
}

/// `setup --reset`: back to the AnkiWeb copy.
fn setup_reset() -> Out {
    let _ = fs::remove_file(local_path());
    Ok(json!({}))
}

/// Anki desktop's data folder, as aqt/profiles.py finds it.
fn desktop_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("ANKI_CLAUDE_MOD_DESKTOP_DIR") {
        return Some(PathBuf::from(dir));
    }
    if cfg!(windows) || cfg!(target_os = "macos") {
        // %APPDATA% and ~/Library/Application Support
        return dirs::data_dir().map(|d| d.join("Anki2"));
    }
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".local/share")))
        .map(|d| d.join("Anki2"))
}

struct DesktopLogin {
    profile: String,
    username: String,
    hkey: String,
    endpoint: Option<String>,
}

/// The logged-in profiles in Anki desktop's prefs21.db: each row's data is a
/// pickled dict holding syncKey, syncUser and the sync URLs.
fn desktop_logins() -> Vec<DesktopLogin> {
    let Some(path) = desktop_dir().map(|d| d.join("prefs21.db")).filter(|p| p.exists()) else {
        return vec![];
    };
    let Ok(db) = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return vec![];
    };
    let Ok(mut stmt) = db.prepare("select name, cast(data as blob) from profiles where name != '_global'") else {
        return vec![];
    };
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)));
    let Ok(rows) = rows else { return vec![] };

    let text = |dict: &std::collections::BTreeMap<serde_pickle::HashableValue, serde_pickle::Value>, key: &str| {
        match dict.get(&serde_pickle::HashableValue::String(key.into())) {
            Some(serde_pickle::Value::String(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        }
    };
    rows.flatten()
        .filter_map(|(profile, data)| {
            let options = serde_pickle::DeOptions::new().replace_unresolved_globals();
            let serde_pickle::Value::Dict(dict) = serde_pickle::value_from_slice(&data, options).ok()? else {
                return None;
            };
            Some(DesktopLogin {
                profile,
                username: text(&dict, "syncUser").unwrap_or_default(),
                hkey: text(&dict, "syncKey")?,
                endpoint: text(&dict, "currentSyncUrl").or_else(|| text(&dict, "customSyncUrl")),
            })
        })
        .collect()
}

/// `desktop-logins`: who Anki desktop is logged in as. Never the keys.
fn list_desktop_logins() -> Out {
    let logins: Vec<Value> = desktop_logins()
        .into_iter()
        .map(|l| json!({ "profile": l.profile, "username": l.username }))
        .collect();
    Ok(json!({ "logins": logins }))
}

/// `login --from-desktop PROFILE`: reuses that profile's sync key, so no
/// password is asked for at all.
fn login_from_desktop(profile: &str) -> Out {
    let login = desktop_logins()
        .into_iter()
        .find(|l| l.profile == profile)
        .ok_or_else(|| fail("no_profile", format!("Anki desktop has no logged-in profile named {profile}")))?;
    save_login(&login.username, login.hkey, login.endpoint)?;
    Ok(json!({ "username": login.username }))
}

fn logout() -> Out {
    let _ = fs::remove_file(auth_path());
    Ok(json!({}))
}

fn status() -> Out {
    let auth = read_auth();
    let local = local_collection();
    Ok(json!({
        "mode": if auth.is_some() { "ankiweb" } else if local.is_some() { "local" } else { "none" },
        "collection": local,
        "loggedIn": auth.is_some(),
        "username": auth.as_ref().map(|a| a.username.clone()),
        "hasSynced": auth.as_ref().is_some_and(|a| a.has_synced),
        "dataDir": data_dir(),
    }))
}

#[derive(PartialEq)]
enum Full {
    No,
    Download,
    Upload,
}

fn sync(full: Full) -> Out {
    // A local collection syncs through the Anki that owns it, if at all.
    if active_local().is_some() {
        return Ok(json!({ "result": "local" }));
    }
    let mut auth = read_auth().ok_or_else(|| fail("logged_out", "run /anki login first"))?;
    let rt = runtime();
    // A one-way download replaces everything here, so it starts from an empty
    // file: that way it also mends a copy too damaged to open.
    if full == Full::Download {
        for suffix in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{suffix}", own_col_path().display()));
        }
    }
    let mut col = open()?;

    // What AnkiWeb has to say to this account (a notice, a warning), shown
    // as it's sent, the way Anki shows it after a sync.
    let mut server_message = String::new();
    let required = if full == Full::No {
        let out = rt.block_on(col.normal_sync(sync_auth(&auth)?, client()))?;
        if let Some(endpoint) = out.new_endpoint {
            auth.endpoint = Some(endpoint);
            write_auth(&auth)?;
        }
        server_message = out.server_message;
        out.required
    } else {
        SyncActionRequired::FullSyncRequired {
            upload_ok: true,
            download_ok: true,
        }
    };

    let result = match required {
        SyncActionRequired::FullSyncRequired {
            upload_ok,
            download_ok,
        } => {
            // A collection that has never synced holds nothing worth keeping.
            let download = full == Full::Download || (full == Full::No && !auth.has_synced);
            if download && download_ok {
                rt.block_on(col.full_download(sync_auth(&auth)?, client()))?;
                "downloaded"
            } else if full == Full::Upload && upload_ok {
                rt.block_on(col.full_upload(sync_auth(&auth)?, client()))?;
                "uploaded"
            } else {
                col.close(None)?;
                return Ok(json!({
                    "result": "full_sync_required",
                    "uploadOk": upload_ok,
                    "downloadOk": download_ok,
                    "serverMessage": server_message,
                }));
            }
        }
        _ => {
            col.close(None)?;
            "synced"
        }
    };

    auth.has_synced = true;
    write_auth(&auth)?;
    Ok(json!({ "result": result, "serverMessage": server_message }))
}

/// Every deck, depth first as Anki lists them, with what's due in each
/// (subdecks included, daily limits applied). An empty Default is left out,
/// as Anki leaves it out.
fn decks() -> Out {
    fn walk(node: &anki_proto::decks::DeckTreeNode, path: &str, out: &mut Vec<Value>) {
        for child in &node.children {
            let name = if path.is_empty() {
                child.name.clone()
            } else {
                format!("{path}::{}", child.name)
            };
            let is_empty_default =
                child.deck_id == 1 && child.children.is_empty() && child.total_including_children == 0;
            if !is_empty_default {
                out.push(json!({
                    "name": name,
                    "level": child.level,
                    "new": child.new_count,
                    "learning": child.learn_count,
                    "review": child.review_count,
                }));
            }
            walk(child, &name, out);
        }
    }

    let mut col = open()?;
    let tree = col.deck_tree(Some(TimestampSecs::now()))?;
    col.close(None)?;
    let mut out = vec![];
    walk(&tree, "", &mut out);
    Ok(json!({ "decks": out }))
}

static ANSWER_RULE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)<hr[^>]*id=["']?answer["']?[^>]*>"#).unwrap());
/// What a note type hides from view: comments (Kaishi keeps whole template
/// blocks in them), scripts, styles, and the fallback text of <rp>.
static HIDDEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?si)<!--.*?-->|<script\b.*?</script>|<style\b.*?</style>|<rp>.*?</rp>").unwrap()
});
/// A run of furigana, e.g. <ruby><rb>一</rb><rt>いち</rt></ruby><ruby>応<rt>おう</rt></ruby>.
static RUBY_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?si)(?:<ruby\b[^>]*>.*?</ruby>)+").unwrap());
static RUBY_PAIR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?si)(.*?)<rt\b[^>]*>(.*?)</rt>").unwrap());

// Furigana in a run is marked with private-use characters while the HTML is
// walked, so styles around it (a bold target word) still apply.
const RUBY_START: char = '\u{E000}';
const RUBY_MID: char = '\u{E001}';
const RUBY_END: char = '\u{E002}';
static SOUND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[sound:[^\]]*\]|\[\[type:[^\]]*\]\]").unwrap());
static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]*>|[^<]+").unwrap());
static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)^<\s*(/?)\s*([a-zA-Z0-9]+)(.*?)/?\s*>$").unwrap());
static CSS_COLOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(?:^|[;\s"'])color\s*:\s*([^;"']+)"#).unwrap());
static FONT_COLOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\bcolor\s*=\s*["']?([^"'\s>]+)"#).unwrap());
static RGB: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)").unwrap());

/// Marks furigana runs: 一応 read いちおう becomes START 一応 MID いちおう END,
/// a run of kanji read together.
fn mark_furigana(html: &str) -> String {
    RUBY_RUN
        .replace_all(html, |run: &regex::Captures| {
            let inner = Regex::new(r"(?i)</?ruby\b[^>]*>|</?rb>").unwrap().replace_all(&run[0], "");
            let (mut base, mut reading) = (String::new(), String::new());
            let mut rest = inner.as_ref();
            for pair in RUBY_PAIR.captures_iter(&inner) {
                base.push_str(&html_to_text_line(&pair[1], false));
                reading.push_str(&html_to_text_line(&pair[2], false));
                rest = &inner[pair.get(0).unwrap().end()..];
            }
            base.push_str(&html_to_text_line(rest, false));
            if reading.is_empty() { base } else { format!("{RUBY_START}{base}{RUBY_MID}{reading}{RUBY_END}") }
        })
        .into_owned()
}

/// Furigana as Anki writes it in fields: the reading in brackets after the
/// word. The text fallback, where ruby can't be drawn.
#[cfg(test)]
fn furigana(html: &str) -> String {
    mark_furigana(html)
        .replace(RUBY_START, "")
        .replace(RUBY_MID, "[")
        .replace(RUBY_END, "]")
}

/// One styled run of a card's text; `r` is the furigana over it.
#[derive(Serialize, Clone, Default, PartialEq, Debug)]
struct Seg {
    t: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    r: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    b: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    i: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    u: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    c: Option<String>,
}

#[derive(Clone, Default)]
struct Style {
    b: bool,
    i: bool,
    u: bool,
    c: Option<String>,
}

/// A CSS or <font> colour a terminal can show: a name or #hex, rgb() turned
/// into hex. Anything else (var(), hsl()) is left out.
fn terminal_color(value: &str) -> Option<String> {
    let v = value.trim().trim_end_matches("!important").trim();
    if let Some(m) = RGB.captures(v) {
        let n = |i: usize| m[i].parse::<u8>().unwrap_or(0);
        return Some(format!("#{:02x}{:02x}{:02x}", n(1), n(2), n(3)));
    }
    let ok = v.starts_with('#') && matches!(v.len(), 4 | 7) && v[1..].chars().all(|c| c.is_ascii_hexdigit())
        || !v.is_empty() && v.chars().all(|c| c.is_ascii_alphabetic());
    (ok && !matches!(v.to_ascii_lowercase().as_str(), "inherit" | "initial" | "unset" | "currentcolor" | "transparent"))
        .then(|| v.to_ascii_lowercase())
}

/// A card side as lines of styled runs: one line per block of the card, tags
/// and sounds gone, bold/italic/underline/colour kept, furigana as readings.
/// Images show as [image] only when the side has nothing else.
fn rich(html: &str) -> Vec<Vec<Seg>> {
    const BLOCKS: &[&str] = &[
        "br", "div", "p", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "details", "summary",
    ];
    let html = SOUND.replace_all(&HIDDEN.replace_all(html, ""), "").into_owned();
    let html = mark_furigana(&html);

    let mut lines: Vec<Vec<Seg>> = vec![vec![]];
    let mut stack: Vec<(String, Style)> = vec![];
    let style = |stack: &Vec<(String, Style)>| stack.last().map(|(_, s)| s.clone()).unwrap_or_default();
    let push = |lines: &mut Vec<Vec<Seg>>, seg: Seg| {
        let line = lines.last_mut().unwrap();
        match line.last_mut() {
            Some(last) if last.r.is_none() && seg.r.is_none() && Seg { t: String::new(), ..last.clone() } == Seg { t: String::new(), ..seg.clone() } => {
                last.t.push_str(&seg.t)
            }
            _ => line.push(seg),
        }
    };

    for token in TOKEN.find_iter(&html).map(|m| m.as_str()) {
        if let Some(tag) = TAG.captures(token) {
            let (closing, name, attrs) = (&tag[1] == "/", tag[2].to_ascii_lowercase(), &tag[3]);
            if BLOCKS.contains(&name.as_str()) {
                lines.push(vec![]);
            } else if name == "img" {
                let s = style(&stack);
                push(&mut lines, Seg { t: "[image]".into(), b: s.b, i: s.i, u: s.u, c: s.c, r: None });
            } else if closing {
                if let Some(at) = stack.iter().rposition(|(n, _)| *n == name) {
                    stack.truncate(at);
                }
            } else if matches!(name.as_str(), "b" | "strong" | "i" | "em" | "u" | "span" | "font") {
                let mut s = style(&stack);
                match name.as_str() {
                    "b" | "strong" => s.b = true,
                    "i" | "em" => s.i = true,
                    "u" => s.u = true,
                    _ => {}
                }
                let color = CSS_COLOR.captures(attrs).or_else(|| (name == "font").then(|| FONT_COLOR.captures(attrs)).flatten());
                if let Some(c) = color.and_then(|m| terminal_color(&m[1])) {
                    s.c = Some(c);
                }
                if attrs.contains("font-weight") && (attrs.contains("bold") || attrs.contains("700")) {
                    s.b = true;
                }
                stack.push((name, s));
            }
            continue;
        }

        let text = decode_entities(token).replace('\u{a0}', " ");
        let s = style(&stack);
        let plain = |t: &str| Seg { t: t.to_string(), b: s.b, i: s.i, u: s.u, c: s.c.clone(), r: None };
        let mut rest = text.as_str();
        while let Some(start) = rest.find(RUBY_START) {
            push(&mut lines, plain(&rest[..start]));
            let after = &rest[start + RUBY_START.len_utf8()..];
            let (Some(mid), Some(end)) = (after.find(RUBY_MID), after.find(RUBY_END)) else { break };
            push(&mut lines, Seg { r: Some(after[mid + RUBY_MID.len_utf8()..end].trim().to_string()), ..plain(after[..mid].trim()) });
            rest = &after[end + RUBY_END.len_utf8()..];
        }
        push(&mut lines, plain(rest));
    }

    // Collapse whitespace as a browser would, trim each line, drop empty ones.
    let mut out: Vec<Vec<Seg>> = vec![];
    for line in lines {
        let mut segs: Vec<Seg> = vec![];
        for mut seg in line {
            let (lead, trail) = (seg.t.starts_with(char::is_whitespace), seg.t.ends_with(char::is_whitespace));
            let words = seg.t.split_whitespace().collect::<Vec<_>>().join(" ");
            if words.is_empty() && seg.r.is_none() {
                // Whitespace alone: one space between its neighbours.
                if lead {
                    if let Some(l) = segs.last_mut() {
                        if !l.t.ends_with(' ') {
                            l.t.push(' ');
                        }
                    }
                }
                continue;
            }
            if lead {
                if let Some(l) = segs.last_mut() {
                    if !l.t.ends_with(' ') {
                        l.t.push(' ');
                    }
                }
            }
            seg.t = if trail { format!("{words} ") } else { words };
            segs.push(seg);
        }
        if let Some(l) = segs.last_mut() {
            l.t = l.t.trim_end().to_string();
        }
        if let Some(f) = segs.first_mut() {
            f.t = f.t.trim_start().to_string();
        }
        segs.retain(|s| !s.t.is_empty() || s.r.is_some());
        if !segs.is_empty() {
            out.push(segs);
        }
    }

    let is_image = |line: &Vec<Seg>| line.iter().all(|s| s.t.replace("[image]", "").trim().is_empty() && s.r.is_none());
    if out.iter().all(is_image) {
        return out;
    }
    out.into_iter()
        .filter(|l| !is_image(l))
        .map(|l| {
            l.into_iter()
                .filter_map(|mut s| {
                    s.t = s.t.replace("[image]", "");
                    (!s.t.trim().is_empty() || s.r.is_some()).then_some(s)
                })
                .collect()
        })
        .collect()
}

/// The same as text, furigana in brackets: for a surface that can't draw ruby.
fn plain_lines(lines: &[Vec<Seg>]) -> String {
    lines
        .iter()
        .map(|line| {
            line.iter()
                .map(|s| match &s.r {
                    Some(r) => format!("{}[{r}]", s.t),
                    None => s.t.clone(),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn plain(html: &str) -> String {
    plain_lines(&rich(html))
}

#[cfg(test)]
mod tests {
    use super::*;

    // A Kaishi 1.5k card, as Anki renders it.
    const KAISHI_ANSWER: &str = r#"<div lang="ja">
<ruby><rb>置</rb><rt>お</rt></ruby>く

<!-- This part enables pitch accent.

{{#Pitch Accent}}
	<br><div style='font-size: 24px'>{{Pitch Accent}}</div>
{{/Pitch Accent}}

-->

<div style='font-size: 25px; padding-bottom:20px'>to put, to place</div>
<div style='font-size: 25px;'>あの<ruby><rb>本</rb><rt>ほん</rt></ruby>をどこに<b><ruby><rb>置</rb><rt>お</rt></ruby>きました</b>か。</div>
<div style='font-size: 25px; padding-bottom:10px'>Where did you put that book?</div>

[sound:66ee151d6e524a561a5c19b631a6a2a6.mp3]
<br>
<img src="yuubin_takuhaiin_door.webp">

<!-- {{#Pitch Accent Notes}}
<div><details><summary>Pitch Accent Notes</summary><br>{{Pitch Accent Notes}}</details></div>
{{/Pitch Accent Notes}} -->
</div>"#;

    #[test]
    fn kaishi_answer() {
        assert_eq!(
            plain(KAISHI_ANSWER),
            "置[お]く\nto put, to place\nあの本[ほん]をどこに置[お]きましたか。\nWhere did you put that book?"
        );
    }

    #[test]
    fn kaishi_question_keeps_its_two_lines() {
        let q = "<div lang=\"ja\">\n置く\n<div style='font-size: 20px;'>あの本をどこに<b>置きました</b>か。</div>\n</div>";
        assert_eq!(plain(q), "置く\nあの本をどこに置きましたか。");
    }

    #[test]
    fn furigana_runs_read_together() {
        assert_eq!(furigana("<ruby><rb>一</rb><rt>いち</rt></ruby><ruby><rb>応</rb><rt>おう</rt></ruby>"), "一応[いちおう]");
        // One <ruby> with several readings, and <rp> fallbacks, as some note types write it.
        assert_eq!(plain("<ruby>漢<rp>(</rp><rt>かん</rt><rp>)</rp>字<rt>じ</rt></ruby>を"), "漢字[かんじ]を");
    }

    #[test]
    fn kaishi_answer_keeps_bold_and_readings() {
        let lines = rich(KAISHI_ANSWER);
        let seg = |t: &str, r: Option<&str>, b: bool| Seg { t: t.into(), r: r.map(Into::into), b, ..Default::default() };
        assert_eq!(lines[0], vec![seg("置", Some("お"), false), seg("く", None, false)]);
        assert_eq!(
            lines[2],
            vec![
                seg("あの", None, false),
                seg("本", Some("ほん"), false),
                seg("をどこに", None, false),
                seg("置", Some("お"), true),
                seg("きました", None, true),
                seg("か。", None, false),
            ]
        );
    }

    #[test]
    fn colours_and_spacing() {
        let lines = rich(r#"<span style="color: rgb(255, 0, 0)">red</span> and <font color="blue">blue</font> <i>it</i>&nbsp;x"#);
        let ts: Vec<(&str, Option<&str>, bool)> = lines[0].iter().map(|s| (s.t.as_str(), s.c.as_deref(), s.i)).collect();
        assert_eq!(ts, vec![("red ", Some("#ff0000"), false), ("and ", None, false), ("blue ", Some("blue"), false), ("it ", None, true), ("x", None, false)]);
        assert_eq!(terminal_color("var(--x)"), None);
        assert_eq!(terminal_color("#ABC"), Some("#abc".into()));
    }

    #[test]
    fn image_only_side_keeps_its_marker() {
        assert_eq!(plain("<img src=\"a.png\">"), "[image]");
        assert_eq!(plain("word<br><img src=\"a.png\">"), "word");
    }
}

fn counts(col: &mut Collection) -> std::result::Result<Value, Fail> {
    let queued = col.get_queued_cards(0, false)?;
    Ok(json!({
        "new": queued.new_count,
        "learning": queued.learning_count,
        "review": queued.review_count,
    }))
}

fn next(deck: Option<String>, skip: Option<i64>) -> Out {
    let mut col = open()?;
    if let Some(name) = deck.filter(|n| !n.trim().is_empty()) {
        let id = col
            .get_deck_id(name.trim())?
            .ok_or_else(|| fail("no_deck", format!("no deck named {name}")))?;
        // Only write when it changes: it's a real (synced) collection change.
        if col.get_current_deck()?.id != id {
            col.set_current_deck(id)?;
        }
    }
    let deck_name = col.get_current_deck()?.human_name();

    // The mod holds the last grade back until the turn ends, so the card it
    // can still undo is due here too; deal the one after it.
    let queued = col.get_queued_cards(2, false)?;
    let card = match queued.cards.iter().find(|q| Some(q.card.id().0) != skip) {
        None => Value::Null,
        Some(q) => {
            let rendered = col.render_existing_card(q.card.id(), false, false)?;
            let answer = rendered.answer();
            // The answer side repeats the question above <hr id=answer>.
            let answer = ANSWER_RULE.split(&answer).last().unwrap_or_default();
            let (question, answer) = (rich(&rendered.question()), rich(answer));
            json!({
                "id": q.card.id().0,
                "kind": format!("{:?}", q.kind).to_lowercase(),
                "question": plain_lines(&question),
                "answer": plain_lines(&answer),
                "questionLines": question,
                "answerLines": answer,
            })
        }
    };
    let out = json!({
        "deck": deck_name,
        "card": card,
        "counts": {
            "new": queued.new_count,
            "learning": queued.learning_count,
            "review": queued.review_count,
        },
    });
    col.close(None)?;
    Ok(out)
}

fn answer(card: i64, rating: &str, ms: u32, at: Option<i64>) -> Out {
    let rating = match rating {
        "again" => Rating::Again,
        "hard" => Rating::Hard,
        "good" => Rating::Good,
        "easy" => Rating::Easy,
        other => return Err(fail("usage", format!("unknown rating {other}"))),
    };
    // The mod sends when the grade was pressed; it answers later, at the end
    // of the turn. Anything far off is a bad clock, not a real time.
    let now = TimestampMillis::now();
    let answered_at = at
        .filter(|at| (now.0 - at).abs() < 24 * 60 * 60 * 1000)
        .map(TimestampMillis)
        .unwrap_or(now);
    let mut col = open()?;
    let cid = CardId(card);
    // States are computed now, not when the card was dealt, so a card
    // reviewed elsewhere in between still gets a sound schedule.
    let states = col.get_scheduling_states(cid)?;
    let new_state = match rating {
        Rating::Again => states.again,
        Rating::Hard => states.hard,
        Rating::Good => states.good,
        Rating::Easy => states.easy,
    };
    col.answer_card(&mut CardAnswer {
        card_id: cid,
        current_state: states.current,
        new_state,
        rating,
        answered_at,
        milliseconds_taken: ms,
        custom_data: None,
        from_queue: true,
    })?;
    let out = json!({ "counts": counts(&mut col)? });
    col.close(None)?;
    Ok(out)
}

/// Debug builds only: adds N Basic notes to DECK (default: Default), for tests.
#[cfg(debug_assertions)]
fn seed(n: &str, deck: Option<&str>) -> Out {
    let n: usize = n.parse().map_err(|_| fail("usage", "seed N [DECK]"))?;
    let mut col = open()?;
    let did = match deck {
        Some(name) => col.get_or_create_normal_deck(name)?.id,
        None => DeckId(1),
    };
    let nt = col
        .get_notetype_by_name("Basic")?
        .ok_or_else(|| fail("anki", "no Basic notetype"))?;
    for i in 1..=n {
        let mut note = nt.new_note();
        note.set_field(0, format!("question <b>{i}</b><br>line two"))?;
        note.set_field(1, format!("answer&nbsp;{i} <img src=\"x.png\">"))?;
        col.add_note(&mut note, did)?;
    }
    col.close(None)?;
    Ok(json!({ "added": n }))
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn run(args: &[String]) -> Out {
    match args.first().map(String::as_str) {
        Some("login") => match flag(args, "--from-desktop") {
            Some(profile) => login_from_desktop(&profile),
            None => login(),
        },
        Some("desktop-logins") => list_desktop_logins(),
        Some("local-collections") => local_collections(),
        Some("setup") => match flag(args, "--collection") {
            Some(path) => setup(&path),
            None if args.iter().any(|a| a == "--reset") => setup_reset(),
            None => Err(fail("usage", "setup --collection PATH | setup --reset")),
        },
        Some("logout") => logout(),
        Some("status") => status(),
        Some("sync") => sync(if args.iter().any(|a| a == "--full-download") {
            Full::Download
        } else if args.iter().any(|a| a == "--full-upload") {
            Full::Upload
        } else {
            Full::No
        }),
        Some("decks") => decks(),
        // Debug builds only: holds the collection open the way Anki desktop does.
        #[cfg(debug_assertions)]
        Some("hold") => {
            let col = open()?;
            let mut col = col;
            col.get_or_create_normal_deck("held")?;
            std::thread::sleep(std::time::Duration::from_secs(flag(args, "--secs").and_then(|s| s.parse().ok()).unwrap_or(3)));
            col.close(None)?;
            Ok(json!({}))
        }
        // Debug builds only: the next N due cards' raw HTML beside what's shown.
        #[cfg(debug_assertions)]
        Some("inspect") => {
            let n = flag(args, "--n").and_then(|n| n.parse().ok()).unwrap_or(3);
            let mut col = open()?;
            let deck = col.get_current_deck()?.human_name();
            let mut cards = vec![];
            for q in col.get_queued_cards(n, false)?.cards {
                let r = col.render_existing_card(q.card.id(), false, false)?;
                let answer = r.answer();
                let answer_side = ANSWER_RULE.split(&answer).last().unwrap_or_default().to_string();
                cards.push(json!({
                    "questionHtml": r.question(),
                    "answerHtml": answer_side,
                    "shownQuestion": plain(&r.question()),
                    "shownAnswer": plain(&answer_side),
                }));
            }
            col.close(None)?;
            Ok(json!({ "deck": deck, "cards": cards }))
        }
        #[cfg(debug_assertions)]
        Some("seed") => seed(
            args.get(1).map(String::as_str).unwrap_or("3"),
            args.get(2).map(String::as_str),
        ),
        Some("next") => next(flag(args, "--deck"), flag(args, "--skip").and_then(|s| s.parse().ok())),
        Some("answer") => {
            let card = flag(args, "--card")
                .and_then(|c| c.parse().ok())
                .ok_or_else(|| fail("usage", "answer needs --card ID"))?;
            let rating = flag(args, "--rating").ok_or_else(|| fail("usage", "answer needs --rating"))?;
            let ms = flag(args, "--ms").and_then(|m| m.parse().ok()).unwrap_or(0);
            let at = flag(args, "--at").and_then(|m| m.parse().ok());
            answer(card, &rating, ms, at)
        }
        _ => Err(fail(
            "usage",
            "commands: login, desktop-logins, local-collections, setup, logout, status, sync, decks, next, answer",
        )),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "login") && args.iter().any(|a| a == "--interactive") {
        return login_interactive(flag(&args, "--endpoint"));
    }
    match run(&args) {
        Ok(mut value) => {
            value["ok"] = json!(true);
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(Fail { code, message }) => {
            println!("{}", json!({ "ok": false, "code": code, "message": message }));
            ExitCode::FAILURE
        }
    }
}
