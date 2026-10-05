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
        let message = err.to_string();
        match err {
            // rslib opens the collection with an exclusive lock
            AnkiError::DbError { source } if matches!(source.kind, DbErrorKind::Locked) => {
                fail("busy", "the collection is open in another session")
            }
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

fn col_path() -> PathBuf {
    data_dir().join("collection.anki2")
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

fn open() -> std::result::Result<Collection, Fail> {
    fs::create_dir_all(data_dir()).map_err(|e| fail("io", e.to_string()))?;
    Ok(CollectionBuilder::new(col_path()).build()?)
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
            let _ = fs::remove_file(format!("{}{suffix}", col_path().display()));
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
        "anki-claude-mod: one-time login\n\n\
         Your email and password go only to {server}, the same way Anki and\n\
         AnkiDroid log in. It answers with a sync key, and that key is all\n\
         anki-claude-mod keeps: your password is not saved anywhere.\n\
         Source: https://github.com/hbkse/anki-claude-mod/blob/main/sidecar/src/main.rs\n"
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
    Ok(json!({
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
    let mut auth = read_auth().ok_or_else(|| fail("logged_out", "run /anki login first"))?;
    let rt = runtime();
    let mut col = open()?;

    let required = if full == Full::No {
        let out = rt.block_on(col.normal_sync(sync_auth(&auth)?, client()))?;
        if let Some(endpoint) = out.new_endpoint {
            auth.endpoint = Some(endpoint);
            write_auth(&auth)?;
        }
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
    Ok(json!({ "result": result }))
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
static IMG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<img\b[^>]*>").unwrap());
static LINE_BREAK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<br\s*/?>|</(div|p|li|tr|h\d)>").unwrap());

/// One terminal-friendly line: tags and sounds gone, images marked, the
/// card's own line breaks shown as " / ".
fn plain(html: &str) -> String {
    let html = IMG.replace_all(html, "[image]");
    LINE_BREAK
        .split(&html)
        .map(|part| html_to_text_line(part, false).split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" / ")
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
            json!({
                "id": q.card.id().0,
                "kind": format!("{:?}", q.kind).to_lowercase(),
                "question": plain(&rendered.question()),
                "answer": plain(answer),
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
            "commands: login, desktop-logins, logout, status, sync, decks, next, answer",
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
