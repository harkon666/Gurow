#!/usr/bin/env bash
# Gurow's checks in one command.
#
#   scripts/check.sh quick      types, unit tests, Rust and backend tests (Docker PostgreSQL)
#   scripts/check.sh full       quick, then one build and every browser regression check
#   scripts/check.sh NAME...    chosen checks; a unique prefix is enough (e.g. ux05)
#   scripts/check.sh list       every check name
#
# Browser checks serve the build this run made and run JOBS at a time (default 3); each has
# its own ports and database. SKIP_BUILD=1 reuses the last build. A browser check that fails
# in parallel is run once more alone, and reported as flaky if it then passes.
# Logs go to .harness/check-logs/<time>/ (ignored by git).
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
JOBS=${JOBS:-3}
LOGS="$ROOT/.harness/check-logs/$(date +%Y%m%dT%H%M%S)"

declare -A CHECK=(
  [scripts-tests]=".|python3 -B -m unittest discover -s scripts -p 'test_*.py'"
  [frontend-types]="frontend|bun run typecheck"
  [backend-types]="backend|bun run typecheck"
  [rust-tests]=".|cargo test --manifest-path editor/Cargo.toml"
  [frontend-tests]="frontend|bun test"
  [db-up]=".|docker compose up -d --wait"
  [backend-tests]="backend|bun test"
  [build]="frontend|bun run build"
  [t04-browser]="frontend|bun run scripts/t04-smoke-check.ts --check-only"
  [t05-browser]="frontend|bun run scripts/t05-smoke-check.ts --check-only"
  [editor-lifecycle]="frontend|bun run scripts/editor-lifecycle-check.ts"
  [t06-functional]="frontend|bun run scripts/t06-functional-check.ts --skip-build"
  [t43-gpu-errors]="frontend|bun run scripts/gpu-error-check.ts"
  [t44-label-scroll]="frontend|bun run scripts/label-scroll-check.ts --skip-build"
  [t15-sign-in]="frontend|bun run scripts/t15-sign-in-check.ts --skip-build"
  [t16-path-authoring]="frontend|bun run scripts/t16-path-authoring-check.ts --skip-build"
  [t17-personal-learning]="frontend|bun run scripts/t17-personal-learning-check.ts --skip-build"
  [t18-coach-draft]="frontend|bun run scripts/t18-coach-draft-check.ts --skip-build"
  [t19-publication]="frontend|bun run scripts/t19-publication-check.ts --skip-build"
  [t20-invitation]="frontend|bun run scripts/t20-invitation-check.ts --skip-build"
  [t21-enrolled-navigation]="frontend|bun run scripts/t21-enrolled-navigation-check.ts --skip-build"
  [t22-learner-work]="frontend|bun run scripts/t22-submit-work-check.ts --skip-build"
  [t23-coach-review]="frontend|bun run scripts/t23-review-work-check.ts --skip-build"
  [t24-correct-approval]="frontend|bun run scripts/t24-correct-approval-check.ts --skip-build"
  [t25-access-override]="frontend|bun run scripts/t25-access-override-check.ts --skip-build"
  [t26-participation]="frontend|bun run scripts/t26-participation-check.ts --skip-build"
  [t27-shared-layout]="frontend|bun run scripts/t27-shared-layout-check.ts --skip-build"
  [t28-recovery]="frontend|bun run scripts/t28-recovery-check.ts --skip-build"
  [t29-copy-content]="frontend|bun run scripts/t29-copy-content-check.ts --skip-build"
  [t30-archive-content]="frontend|bun run scripts/t30-archive-content-check.ts --skip-build"
  [t31-arrange-selection]="frontend|bun run scripts/t31-arrange-selection-check.ts --skip-build"
  [t32-delete-content]="frontend|bun run scripts/t32-delete-content-check.ts --skip-build"
  [ux01-navigation]="frontend|bun run scripts/ux01-navigation-check.ts --skip-build"
  [ux02-connections]="frontend|bun run scripts/ux02-connections-check.ts --skip-build"
  [ux03-task-board]="frontend|bun run scripts/ux03-task-board-check.ts --skip-build"
  [ux04-coach-board]="frontend|bun run scripts/ux04-coach-board-check.ts --skip-build"
  [ux05-learner-board]="frontend|bun run scripts/ux05-learner-board-check.ts --skip-build"
)
# Run in this order, one at a time; db-up comes before backend-tests.
SERIAL=(scripts-tests frontend-types backend-types rust-tests frontend-tests db-up backend-tests build)
QUICK=(scripts-tests frontend-types backend-types rust-tests frontend-tests db-up backend-tests)
# Browser regression checks: each guards invariants listed in docs/validation/regression-audit.md.
BROWSER=(t04-browser t05-browser editor-lifecycle t06-functional t43-gpu-errors t44-label-scroll
  t15-sign-in t16-path-authoring t17-personal-learning t18-coach-draft t19-publication t20-invitation
  t21-enrolled-navigation t22-learner-work t23-coach-review t24-correct-approval t25-access-override
  t26-participation t27-shared-layout t28-recovery t29-copy-content t30-archive-content
  t31-arrange-selection t32-delete-content ux01-navigation ux02-connections ux03-task-board
  ux04-coach-board ux05-learner-board)

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
is_browser() { local b; for b in "${BROWSER[@]}"; do [[ $b == "$1" ]] && return 0; done; return 1; }

# Resolves a name or unique prefix to a check name.
resolve() {
  [[ -n ${CHECK[$1]+x} ]] && { echo "$1"; return; }
  local matches=() name
  for name in "${!CHECK[@]}"; do [[ $name == "$1"* ]] && matches+=("$name"); done
  if (( ${#matches[@]} == 1 )); then echo "${matches[0]}"; return; fi
  echo "unknown or ambiguous check: $1 ${matches[*]:+(${matches[*]})}" >&2
  return 1
}

FAILED=() FLAKY=() PASSED=0
# Runs one check, logging to $LOGS/<name>.log; returns its exit code.
run() {
  local name=$1 dir cmd start code
  IFS='|' read -r dir cmd <<< "${CHECK[$name]}"
  start=$SECONDS
  (cd "$ROOT/$dir" && bash -c "$cmd") > "$LOGS/$name.log" 2>&1
  code=$?
  printf '  %-26s %s (%ss)\n' "$name" "$([[ $code == 0 ]] && echo ok || echo "FAILED exit=$code")" "$((SECONDS - start))"
  return $code
}

run_serial() {
  local name
  for name in "$@"; do
    if run "$name"; then PASSED=$((PASSED + 1)); else
      FAILED+=("$name")
      # Without a build, a database or types, later checks only repeat the same failure.
      [[ $name == build || $name == db-up ]] && { echo "  stopping: $name failed"; return 1; }
    fi
  done
}

run_parallel() {
  local name pids=() code
  for name in "$@"; do
    while (( $(jobs -rp | wc -l) >= JOBS )); do wait -n; done
    ( run "$name"; echo $? > "$LOGS/$name.status" ) &
  done
  wait
  for name in "$@"; do
    code=$(cat "$LOGS/$name.status" 2>/dev/null || echo 1)
    if [[ $code == 0 ]]; then PASSED=$((PASSED + 1)); continue; fi
    # Parallel load can disturb timing-sensitive browser checks: one solo retry tells flakes from failures.
    mv "$LOGS/$name.log" "$LOGS/$name.parallel.log"
    echo "  retrying $name alone"
    if run "$name"; then PASSED=$((PASSED + 1)); FLAKY+=("$name"); else FAILED+=("$name"); fi
  done
}

(( $# > 0 )) || usage
case $1 in
  list) printf '%s\n' "${SERIAL[@]}" "${BROWSER[@]}"; exit 0 ;;
  quick) serial=("${QUICK[@]}") browser=() ;;
  full) serial=("${SERIAL[@]}") browser=("${BROWSER[@]}") ;;
  -h|--help) usage ;;
  *)
    serial=() browser=() needs_build=0 needs_db=0
    for arg in "$@"; do
      name=$(resolve "$arg") || exit 2
      if is_browser "$name"; then browser+=("$name"); needs_build=1; needs_db=1
      else
        [[ $name == backend-tests ]] && needs_db=1
        serial+=("$name")
      fi
    done
    # A chosen check gets what it needs: the database, and a current build for browser checks.
    if (( needs_db )) && [[ " ${serial[*]} " != *" db-up "* ]]; then serial=(db-up "${serial[@]}"); fi
    if (( needs_build )) && [[ " ${serial[*]} " != *" build "* ]]; then serial+=(build); fi
    ;;
esac
if [[ ${SKIP_BUILD:-0} == 1 ]]; then
  kept=(); for name in "${serial[@]}"; do [[ $name == build ]] || kept+=("$name"); done; serial=("${kept[@]}")
fi

mkdir -p "$LOGS"
echo "Logs: ${LOGS#"$ROOT"/}"
run_serial "${serial[@]}" && (( ${#browser[@]} > 0 )) && run_parallel "${browser[@]}"

echo
echo "Passed: $PASSED"
(( ${#FLAKY[@]} )) && echo "Flaky (failed in parallel, passed alone): ${FLAKY[*]}"
if (( ${#FAILED[@]} )); then
  echo "FAILED: ${FAILED[*]} (see ${LOGS#"$ROOT"/}/<name>.log)"
  exit 1
fi
echo "All checks passed."
