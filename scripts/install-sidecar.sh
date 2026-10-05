#!/bin/sh
# Installs the anki-wait-sidecar release pinned in sidecar.lock into bin/
# beside the plugin, checking it against the pinned SHA-256. The mod runs it
# when a session starts; it prints one JSON line, as the sidecar does, and is
# quick when the right binary is already there.
#
# ANKI_WAIT_RELEASE_URL replaces the GitHub release download base (for mirrors
# and tests); the checksum is checked all the same.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
bin="$root/bin/anki-wait-sidecar"
lock="$root/sidecar.lock"

ok() {
  printf '{"ok":true,"path":"%s","source":"%s"}\n' "$bin" "$1"
  exit 0
}
fail() {
  printf '{"ok":false,"code":"%s","message":"%s"}\n' "$1" "$2"
  exit 1
}
field() {
  awk -v k="$1" '$1 == k { print $2; exit }' "$lock" 2>/dev/null
}
sha256() {
  { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d' ' -f1
}

# A local build (scripts/build-sidecar.sh) wins over any release.
[ -f "$root/bin/.dev" ] && [ -x "$bin" ] && ok dev

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) key=darwin-arm64 ;;
  Darwin-x86_64) key=darwin-x64 ;;
  Linux-x86_64) key=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) key=linux-arm64 ;;
  *) fail unsupported "no prebuilt sidecar for $(uname -sm); build one with scripts/build-sidecar.sh" ;;
esac

repo=$(field repo)
version=$(field version)
sha=$(field "$key")
[ -n "$version" ] && [ -n "$sha" ] || fail missing "no sidecar release pinned yet; build one with scripts/build-sidecar.sh"

[ -x "$bin" ] && [ "$(sha256 "$bin")" = "$sha" ] && ok release

base=${ANKI_WAIT_RELEASE_URL:-"https://github.com/$repo/releases/download/$version"}
url="$base/anki-wait-sidecar-$key.gz"
mkdir -p "$root/bin" || fail io "can't create $root/bin"
tmp="$bin.download.$$"
trap 'rm -f "$tmp" "$tmp.gz"' EXIT

curl -fsSL --retry 2 --max-time 120 -o "$tmp.gz" "$url" || fail network "couldn't download $url"
gunzip -c "$tmp.gz" >"$tmp" || fail crash "couldn't unpack $url"
[ "$(sha256 "$tmp")" = "$sha" ] || fail checksum "the downloaded sidecar doesn't match sidecar.lock; not installing it"
chmod +x "$tmp" && mv -f "$tmp" "$bin" || fail io "can't install into $root/bin"
ok release
