#!/usr/bin/env bash
# Upgrade rehearsal at the state level: builds the deployed commit and the
# current code into one test, writes state with the old code and reads it back
# with the new code's `migrate`, as `apply_upgrade` does on chain.
set -euo pipefail
OLD=${OLD_COMMIT:-88e06a6}
cd "$(dirname "$0")/.."
rm -rf .old
git worktree prune
git worktree add --detach .old "$OLD" >/dev/null
sed -i 's/^name = "policy-signer"$/name = "policy-signer-old"/' .old/policy-signer/Cargo.toml
cd upgrade-check
cargo test -- --nocapture
