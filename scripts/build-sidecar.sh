#!/bin/sh
# Builds the Rust sidecar and puts it where the mod looks: bin/ in the plugin.
# Needs a Rust toolchain and protoc (brew install protobuf). The first build
# compiles Anki's core and takes a few minutes.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cargo build --release --manifest-path "$root/sidecar/Cargo.toml"
mkdir -p "$root/bin"
cp "$root/sidecar/target/release/anki-wait-sidecar" "$root/bin/"
# Marks bin/ as a local build, so install-sidecar.sh keeps it over a release.
touch "$root/bin/.dev"
echo "built $root/bin/anki-wait-sidecar"
