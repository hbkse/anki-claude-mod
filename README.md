# anki-claude-mod

The `anki` plugin, from the [hbkse](https://github.com/hbkse/claude-plugins) marketplace.

A Claude Code mod that shows your due Anki cards above the prompt while Claude works, and syncs
your reviews straight to AnkiWeb. You don't need Anki desktop or AnkiConnect: it works if you
mostly study on AnkiDroid or AnkiMobile.

The first time, it asks which deck to review. After that, press `1` to show the answer, then
grade it with Anki's keys: `1` again, `2` hard, `3` good, `4` easy. `5` undoes the last grade
and `0` brings the deck menu back. The band only appears while a turn is running. When Claude
finishes, it hides and leaves the prompt alone.

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

Then pick where your decks come from (`/anki` on its own says the same):

```
/anki login     # sync with AnkiWeb (recommended)
/anki setup     # or use Anki desktop's decks on this computer, no AnkiWeb
```

If you set up both, AnkiWeb comes first: anki reviews AnkiWeb's decks, and warns you when the
local collection's decks differ from them (decks only one side has, or different card counts).
The local collection is used again after `/anki logout`.

### Syncing with AnkiWeb: `/anki login`

Reviews sync both ways with AnkiWeb, so they show up in AnkiDroid, AnkiMobile and Anki desktop.

- **If Anki desktop is logged in on this computer**, it offers to reuse that login. No password
  needed: it copies the profile's sync key.
- **Otherwise, after asking, it opens a terminal window outside Claude Code** that explains the login and asks for your AnkiWeb email
  and password, with the password hidden. It opens in the terminal you're running Claude Code in:
  a new tmux or zellij window, or a new tab or window of Terminal, iTerm2, Ghostty, WezTerm, kitty,
  Alacritty or Windows Terminal. In any other terminal, an editor's say, it uses your system's
  default terminal. Over SSH without tmux, the command goes on your clipboard to paste instead.

### Decks on this computer: `/anki setup`

For decks that aren't on AnkiWeb. `/anki setup` lists Anki desktop's profiles to pick from, or
takes a path: `/anki setup ~/Library/Application Support/Anki2/User 1` (a profile folder, its
`collection.anki2`, or Anki's data folder if it holds one profile). Reviews go straight into that
collection, so Anki desktop sees them next time it opens. While you're logged in to AnkiWeb,
the setup is saved but AnkiWeb's decks are used.

This assumes you don't use Anki desktop while you review here. Anki desktop locks its collection
while it's running, so the plugin pauses then and picks up again once it's closed. Collections
from an Anki older than 2.1.50 aren't touched, rather than upgraded under it. `/anki login`
switches back to AnkiWeb.

### How your password is handled

AnkiWeb has no "authorize this app" page, so like Anki and AnkiDroid, logging in means sending
your email and password to AnkiWeb once, in exchange for a sync key. anki-claude-mod keeps only
that key, as Anki does.

The password is typed into the sidecar in its own terminal window. It never passes through
Claude Code: not its settings, this mod, other mods, or the transcript Claude reads. It goes
only to `sync.ankiweb.net` (or your own sync server) and is never written anywhere. The code that
does this is `login_interactive` and `exchange` in [`sidecar/src/main.rs`](sidecar/src/main.rs).

Whatever the login screen, you're trusting this plugin's code with your password once, as you
trust AnkiDroid's. The code is open, and release binaries are pinned by checksum to builds of it.

## Commands

| Command | What it does |
| --- | --- |
| `/anki` or `/anki status` | Account, deck, what's due, reviews not yet synced |
| `/anki login` / `logout` | Sync with AnkiWeb: log in once, or forget the sync key |
| `/anki setup [folder]` | Use a collection on this computer instead, with no AnkiWeb |
| `/anki sync` | Sync with AnkiWeb now |
| `/anki download` / `upload` | One-way sync, when AnkiWeb asks for one |
| `/anki deck` | Open the deck menu next time Claude works |
| `/anki deck <name>` | Switch to a deck by its full name, e.g. `Svensk::Verb` |

Replies come back as toasts, so none of this ends up in the transcript Claude reads.

## Keys

| Key | Card | Deck menu |
| --- | --- | --- |
| `1` | Show the answer, then Again | Pick deck 1 on the page |
| `2`–`4` | Hard, Good, Easy | Pick deck 2–4 |
| `5` | Undo the last grade | Pick deck 5 |
| `6`–`8` | | Pick deck 6–8 |
| `9` | | Next page |
| `0` | Deck menu | Back to your card |

The keys aren't configurable. They work straight from an empty composer. A second `1` within
0.4 s of showing the answer is ignored, so a double tap doesn't grade a card you haven't read.

The last grade is held back until your next grade, a sync, a deck switch or the end of the
session, so undo just forgets it and nothing needs reversing in Anki. If Claude Code is killed
mid-session, that one grade is lost.

## Settings

| Option | Default | What it does |
| --- | --- | --- |
| `syncServer` | `https://sync.ankiweb.net/` | AnkiWeb, or a [self-hosted sync server](https://docs.ankiweb.net/sync-server.html) |

The deck isn't a setting: pick it from the menu, which remembers your choice.

## Where things live

`~/Library/Application Support/anki-claude-mod/` on macOS (`$ANKI_CLAUDE_MOD_DIR` overrides it):

- `collection.anki2`: the sidecar's copy of your collection, synced with AnkiWeb
- `local.json`: the collection `/anki setup` points at, when you use one
- `auth.json` (mode 600): your email and AnkiWeb sync key, the way Anki desktop keeps its own
  in `prefs21.db`. The password is never stored. Anything running as you can read this file,
  including Claude if you approve a read of it. `/anki logout` deletes it.

## Limits

- Cards are shown as text: images become `[image]` and sounds are dropped. Media isn't synced.
- Picking a deck changes the collection's current deck, which syncs like any deck switch.
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
