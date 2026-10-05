#!/bin/sh
# Builds the Rust sidecar and puts it where the mod looks: helper/ in the plugin.
# Not bin/: Claude Code puts a plugin's bin/ on Claude's own PATH.
# Needs a Rust toolchain and protoc (brew install protobuf). The first build
# compiles Anki's core and takes a few minutes.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cargo build --release --manifest-path "$root/sidecar/Cargo.toml"
mkdir -p "$root/helper"
cp "$root/sidecar/target/release/anki-claude-mod-sidecar" "$root/helper/"
# Marks helper/ as a local build, so install-sidecar.sh keeps it over a release.
touch "$root/helper/.dev"
echo "built $root/helper/anki-claude-mod-sidecar"
