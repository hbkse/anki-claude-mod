# anki-claude-mod

The `anki` plugin, from the [hbkse](https://github.com/hbkse/claude-plugins) marketplace.

A Claude Code mod that shows your due Anki cards above the prompt while Claude works, and syncs
your reviews straight to AnkiWeb. You don't need Anki desktop or AnkiConnect: it works if you
mostly study on AnkiDroid or AnkiMobile.

Press `1` to show the answer, then grade it with Anki's keys: `1` again, `2` hard, `3` good,
`4` easy. The band only appears while a turn is running. When Claude finishes, it hides and
leaves the prompt alone.

## How it works

```
Claude Code ── mod (hooks/register.tsx) ── $.process.run ──▶ anki-claude-mod-sidecar ──▶ AnkiWeb
                draws the band, keys                         Rust, Anki's own core
```

- **`sidecar/`** is a small Rust CLI built on [`rslib`](https://github.com/ankitects/anki/tree/main/rslib),
  the core that desktop Anki, AnkiDroid and the sync server share. It keeps its own copy of
  your collection and syncs it with AnkiWeb like any other Anki client. Scheduling, including
  FSRS and your deck presets, runs in Anki's own code.
- Each command (`sync`, `next`, `answer`, ...) is one short process that prints one JSON line.
  A card takes about 10 ms.
- **`hooks/register.tsx`** is the mod. It syncs when a session starts, every 10 minutes while you
  review, and when the session ends. It deals a card as each turn starts.

To AnkiDroid, your reviews in Claude look like another device's, so they merge on the next sync.

## Requirements

Claude Code 2.1.287 or later, in the terminal or the Desktop app's Code tab. Prebuilt sidecars
cover macOS (Apple Silicon, Intel), Linux (x64, arm64) and Windows (x64).

## Install

```
/plugin marketplace add hbkse/claude-plugins
/plugin install anki@hbkse
/reload-plugins
```

The first session downloads the sidecar for your platform from this repo's GitHub release
pinned in [`sidecar.lock`](sidecar.lock). It's about 7 MB, and it is only installed if its SHA-256
matches the pin. It goes in `bin/` inside the plugin.

Then set your AnkiWeb email and password under `/config` → anki, and run:

```
/anki login
```

That exchanges the password for a sync key, clears the password from your settings, and
downloads your collection.

## Commands

| Command | What it does |
| --- | --- |
| `/anki` or `/anki status` | Account, deck, what's due, reviews not yet synced |
| `/anki login` / `logout` | Get or forget the sync key |
| `/anki sync` | Sync now |
| `/anki download` / `upload` | One-way sync, when AnkiWeb asks for one |
| `/anki decks` | List your decks |

Replies come back as toasts, so none of this ends up in the transcript Claude reads.

## Settings

| Option | Default | What it does |
| --- | --- | --- |
| `deck` | *(empty)* | Deck to review, subdecks included. Empty uses the collection's current deck. |
| `syncServer` | *(empty)* | A [self-hosted sync server](https://docs.ankiweb.net/sync-server.html) URL instead of AnkiWeb |

The keys aren't configurable. They work straight from an empty composer, and a second `1` within
0.4 s of showing the answer is ignored, so a double tap doesn't grade a card you haven't read.

## Where things live

`~/Library/Application Support/anki-claude-mod/` on macOS (`$ANKI_CLAUDE_MOD_DIR` overrides it):

- `collection.anki2`: the sidecar's copy of your collection
- `auth.json` (mode 600): your email and AnkiWeb sync key. The password is never stored.

## Limits

- Cards are shown as text: images become `[image]` and sounds are dropped. Media isn't synced.
- Setting `deck` changes the collection's current deck, which syncs like any deck switch.
- If AnkiWeb asks for a one-way sync (after a note type change, say), the band tells you.
  `/anki download` drops reviews from Claude that haven't synced yet; `/anki upload`
  overwrites AnkiWeb.
- Mods are new: their API can still change between Claude Code releases.

## Development

Building the sidecar needs Rust and `protoc` (`brew install protobuf`). The first build compiles
Anki's core and takes a few minutes.

```sh
./scripts/build-sidecar.sh                  # into bin/, marked as a local build so it's never replaced
claude --plugin-dir .
claude plugin validate .
claude plugin test .                        # mod tests, sidecar faked
ANKI_CLAUDE_MOD_DIR=/tmp/aw sidecar/target/debug/anki-claude-mod-sidecar seed 5   # debug builds only
ANKI_CLAUDE_MOD_DIR=/tmp/aw sidecar/target/debug/anki-claude-mod-sidecar next
```

Anki's [`anki-sync-server`](https://docs.ankiweb.net/sync-server.html) works as a local AnkiWeb
for sync tests. Log in with `"endpoint": "http://127.0.0.1:27701/"` on the sidecar's stdin.
`ANKI_CLAUDE_MOD_RELEASE_URL` points the installer at another download location; the checksum is
still checked.

### Releasing

Push a tag like `v0.1.0`. [`release.yml`](.github/workflows/release.yml) builds the sidecar on
all five platforms, publishes them as a GitHub release, and commits their SHA-256s to
`sidecar.lock` on the default branch. Installs pick that up with `/plugin update`.

## License

AGPL-3.0-or-later, because the sidecar links Anki's core.
