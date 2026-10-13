#!/usr/bin/env bash
set -euo pipefail

bin="$(cd "$(dirname "$0")" && pwd)"
ctl="$bin/control-rakazo.mjs"
composer='textarea[name="chat-message"]'
bundle="${1:?usage: scenario-steering.sh <evidence-bundle-dir>}"
mkdir -p "$bundle"

send() {
  "$ctl" browser fill --css "$composer" --value "$1" >/dev/null
  "$ctl" browser press Enter >/dev/null
  echo "$(date -u +%H:%M:%S) sent: $1" | tee -a "$bundle/timeline.txt"
}

wait_working() {
  "$ctl" browser wait --text "Chief is working" "$@" >/dev/null
}

settle() {
  wait_working --state hidden --timeout 120000
  sleep 3
  wait_working --state hidden --timeout 120000
}

capture() {
  "$ctl" browser screenshot --path "$bundle/$1.png" >/dev/null
  "$ctl" browser snapshot --path "$bundle/$1.aria.txt" >/dev/null
}

: >"$bundle/timeline.txt"

send "Book the dentist for Tuesday [[slow-final:20]]"
wait_working --timeout 15000
sleep 6
send "Actually make it Thursday"
sleep 2
capture a1-steer-during-final-answer
sleep 20
settle
capture a2-after-final-answer

send "Check the status page [[slow-tool:10]]"
wait_working --timeout 15000
sleep 4
send "Also mention Thursday"
sleep 2
capture b1-steer-during-tool-turn
settle
capture b2-after-tool-turn

"$ctl" fixture-log >"$bundle/fixture-log.json"
"$ctl" browser text --testid transcript >"$bundle/transcript.json"
node -e '
  for (const entry of require(process.argv[1]))
    console.log(
      entry.n,
      entry.at.slice(11, 19),
      entry.phase.padEnd(5),
      (entry.plan ?? "").padEnd(10),
      JSON.stringify(entry.newUserMessages ?? entry.reply),
    );
' "$bundle/fixture-log.json" | tee "$bundle/model-calls.txt"
