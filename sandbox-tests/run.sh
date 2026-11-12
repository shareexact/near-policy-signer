#!/usr/bin/env bash
# Builds both contracts and runs the sandbox tests. Needs cargo-near 0.22 and network access for the sandbox binary.
set -euo pipefail
cd "$(dirname "$0")/.."
(cd policy-signer && cargo near build non-reproducible-wasm --locked)
(cd mock-signer && cargo near build non-reproducible-wasm --locked)
cd sandbox-tests && cargo test -- --nocapture
