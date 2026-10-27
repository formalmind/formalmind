#!/bin/bash
# Formal Mind's lifecycle test: a dev build of the app runs the swarm on a small project (WETH9 by default), on your
# Claude plan, with no focus (so the plan goes through prover, check and reviewer), and this checks what a person would: the start writes the plan, formalmind.toml and the model; every
# agent turn has its tools and a clean health line; a quit mid-job resumes with its tools; and a function ends proved
# and approved. The dev build runs as its own app (team.formal.desktop.lifecycle), beside the installed one.
#
#   desktop/scripts/lifecycle.sh [folder]      # the folder needs a .lifecycle-test file: its swarm state is reset
#
# Then the commands the MCP drives: cd desktop/src-tauri && FM_LIFECYCLE_FOLDER=<folder> cargo test --lib lifecycle -- --ignored
set -uo pipefail

FOLDER=$(cd "${1:-$HOME/developer/asyncswap/formal-targets/weth9}" && pwd)
HERE=$(cd "$(dirname "$0")/.." && pwd)
TURNS="$HOME/Library/Logs/Formal Mind/turns.jsonl"
OUT=$(mktemp -d /tmp/fm-lifecycle.XXXXXX)
PASS=0
FAIL=0

ok() { echo "  ok   $1"; PASS=$((PASS + 1)); }
no() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
# wait_for <seconds> <description> <test command...>
wait_for() {
	local limit=$1 what=$2
	shift 2
	local start=$SECONDS
	until "$@" >/dev/null 2>&1; do
		if ((SECONDS - start > limit)); then
			no "$what (waited ${limit}s)"
			return 1
		fi
		sleep 5
	done
	ok "$what ($((SECONDS - start))s)"
}

[ -f "$FOLDER/.lifecycle-test" ] || { echo "$FOLDER has no .lifecycle-test file; this test resets its swarm state, so it only runs where that file says it may."; exit 2; }
command -v claude >/dev/null || { echo "Claude Code isn't installed"; exit 2; }

# A fresh start: the swarm's state, the generated model, the proofs and formalmind.toml go; the contracts stay.
rm -rf "$FOLDER/.formal" "$FOLDER/formalmind.toml" "$FOLDER/formal/Refinement" "$FOLDER/formal/Generated"
mkdir -p "$FOLDER/formal/Refinement/Swarm"
# Its agents' saved Claude Code conversations go too, so nothing resumes from a previous run.
rm -rf "$HOME/.formalmind/claude-code/$(basename "$FOLDER")-"*
python3 -I - "$FOLDER" <<'EOF'
import json, os, sys
p = os.path.expanduser("~/.formalmind/config.json")
c = json.load(open(p)) if os.path.exists(p) else {"folders": [], "repos": {}}
if sys.argv[1] not in c["folders"]:
    c["folders"].append(sys.argv[1])
    json.dump(c, open(p, "w"), indent=2)
EOF
turns_before=$( [ -f "$TURNS" ] && wc -l <"$TURNS" || echo 0)

APP_PID=""
start_app() {
	(cd "$HERE" && VITE_FM_RELAY=0 FM_SWARM_AUTOSTART="$FOLDER" FM_SWARM_PROVIDER=claude-code FM_SWARM_BUDGET=50 \
		exec bunx tauri dev --config '{"identifier":"team.formal.desktop.lifecycle","productName":"Formal Mind Lifecycle"}' >>"$OUT/app.log" 2>&1) &
	APP_PID=$!
}
stop_app() {
	pkill -f "target/debug/formalmind-desktop" 2>/dev/null
	[ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
	pkill -f "vite --config vite.config.mts" 2>/dev/null
	sleep 3
}
trap stop_app EXIT

# New turn lines for this folder, as JSON, one per line.
new_turns() { tail -n +$((turns_before + 1)) "$TURNS" 2>/dev/null | python3 -I -c '
import json, sys
f = sys.argv[1]
for l in sys.stdin:
    try: t = json.loads(l)
    except Exception: continue
    if t.get("folder") == f: print(json.dumps(t))' "$FOLDER"; }
running_job() { python3 -I -c '
import json, sys
q = json.load(open(sys.argv[1]))
print(next(j["id"] for j in q["jobs"] if j["state"] == "running" and j["kind"] in ("prove", "review")))' "$FOLDER/.formal/queue.json"; }

echo "Formal Mind lifecycle test on $FOLDER (logs in $OUT)"
echo "1. Start"
start_app
wait_for 900 "the plan is written" test -s "$FOLDER/.formal/plan.md"
wait_for 60 "formalmind.toml is written" grep -q 'project = "formal"' "$FOLDER/formalmind.toml"
wait_for 60 "the model is in the Lake sources" test -s "$FOLDER/formal/Generated/WETH9.lean"

echo "2. A turn"
has_turn() { [ -n "$(new_turns)" ]; }
wait_for 1500 "an agent turn is logged" has_turn
first=$(new_turns | head -1)
check() { echo "$first" | python3 -I -c "import json,sys; t=json.loads(sys.stdin.read()); sys.exit(0 if $1 else 1)"; }
check 't.get("tools") in ("connected", None)' && ok "its tools connected" || no "its tools connected: $first"
check 'not t.get("anomalies")' && ok "its health line is clean" || no "its health line is clean: $first"

echo "3. Quit mid-job"
wait_for 900 "a job is running" running_job
job=$(running_job)
stop_app
start_app
resumed() { new_turns | python3 -I -c "import json,sys; sys.exit(0 if any(json.loads(l)['job'] == $job for l in sys.stdin) else 1)"; }
wait_for 1500 "job $job resumes and logs a turn" resumed
new_turns | python3 -I -c '
import json, sys
bad = [t for t in map(json.loads, sys.stdin) if t.get("tools") not in ("connected", None)]
sys.exit(1 if bad else 0)' && ok "every turn after the restart had its tools" || no "a turn ran without its tools"

echo "4. A function proved and approved"
# Approved by the swarm's reviewer, not just ticked: the review job for the item ended with approve.
approved() { python3 -I -c '
import json, sys
q = json.load(open(sys.argv[1]))
sys.exit(0 if any(j["kind"] == "review" and j["state"] == "done" and j.get("result") == "approve" for j in q["jobs"]) else 1)' "$FOLDER/.formal/queue.json"; }
wait_for 2400 "the reviewer approves a proof" approved
grep -q '^- \[x\]' "$FOLDER/.formal/plan.md" && ok "its plan item is ticked" || no "its plan item is ticked"

stop_app
trap - EXIT
new_turns >"$OUT/turns.jsonl"
echo
echo "$PASS passed, $FAIL failed. Turns: $OUT/turns.jsonl; app log: $OUT/app.log"
[ "$FAIL" -eq 0 ]
