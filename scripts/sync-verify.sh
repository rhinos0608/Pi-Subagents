#!/usr/bin/env bash
# Usage: scripts/sync-verify.sh <worktree> <label>
# Runs typecheck + unit + integration and diffs failing test names against the pre-sync baseline.
# Exit 0 only when typecheck passes and no failure is new relative to baseline.
# Baseline logs default to /tmp/upstream-sync; override with SYNC_BASELINE_DIR.
set -u
wt="$1"; label="$2"
base_dir="${SYNC_BASELINE_DIR:-/tmp/upstream-sync}"
out="$base_dir/$label"
mkdir -p "$out"
cd "$wt" || exit 2
extract() { awk '/✖ failing tests:/,0' "$1" | grep -E '^✖' | grep -v 'failing tests' | sed -E 's/ \([0-9.]+ms\)$//' | sort -u; }
npm run typecheck > "$out/typecheck.log" 2>&1; tc=$?
npm run test:unit > "$out/unit.log" 2>&1
npm run test:integration > "$out/int.log" 2>&1
extract "$out/unit.log" > "$out/unit-fail.txt"
extract "$out/int.log" > "$out/int-fail.txt"
extract "$base_dir/baseline-unit.log" > "$out/base-unit-fail.txt"
extract "$base_dir/baseline-int.log" > "$out/base-int-fail.txt"
new_unit=$(comm -13 "$out/base-unit-fail.txt" "$out/unit-fail.txt")
new_int=$(comm -13 "$out/base-int-fail.txt" "$out/int-fail.txt")
echo "typecheck exit: $tc"
grep -E '^ℹ (tests|pass|fail)' "$out/unit.log" | sed 's/^/unit /'
grep -E '^ℹ (tests|pass|fail)' "$out/int.log" | sed 's/^/int  /'
echo "NEW unit failures:"; echo "${new_unit:-none}"
echo "NEW integration failures:"; echo "${new_int:-none}"
[ "$tc" -eq 0 ] && [ -z "$new_unit" ] && [ -z "$new_int" ]
