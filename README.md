# anki-claude-mod

Claude Code Mod that puts [Anki](https://apps.ankiweb.net/) inside your Claude Code. 

While Claude works, you review cards.

## Installation

Needs Claude Code 2.1.287 or later.

```
/plugin marketplace add hbkse/claude-plugins
/plugin install anki@hbkse
/reload-plugins
```

Then run `/anki`

`/anki login` to pull decks from AnkiWeb (recommended)

or `/anki setup` for local decks

## Updates

Automatic updates: `/plugin` → **Marketplaces** tab → `hbkse` → **Enable auto-update**

Manual updates: `/plugin` → **Installed** → `anki` → **Update now**

## Commands

| Command | |
| --- | --- |
| `/anki` | What's set up, what's due |
| `/anki login` / `logout` | Sync with AnkiWeb |
| `/anki setup [folder]` | Use local decks instead |
| `/anki deck [name]` | Switch decks |
| `/anki sync` | Manually sync now |
| `/anki download` / `upload` | For resolving conflicts with AnkiWeb sync |

| Key | On a card |
| --- | --- |
| `1` | Show answer |
| `1` `2` `3` `4` | Again, Hard, Good, Easy |
| `5` | Undo the last grade |
| `0` | Deck list |

## AnkiWeb password information

To sync with AnkiWeb, we need to fetch a sync key. If you already have a sync key from Anki Desktop on the same computer, the plugin should detect that and ask if you want to use that. Otherwise you'll need to provide your email and password. When you run `/anki login`, it'll ask to launch a separate terminal for you to input those. This is so other Claude Code plugins can't read it. Your email and password is not saved anywhere, only the sync key.

## Settings

- `syncServer` in `/config`: points to AnkiWeb by default, but you can override with a [self-hosted sync server](https://docs.ankiweb.net/sync-server.html).
- Your data lives in `~/Library/Application Support/anki-claude-mod/` (macOS),
  `~/.local/share/anki-claude-mod/` (Linux) or `%APPDATA%\anki-claude-mod\` (Windows).
- `/anki logout` deletes your sync key

## Development and Contributing

Everything is vibe coded, use Claude Code and check CLAUDE.md 

## License

AGPL-3.0
