# Stop a run

While a bot is working, the user can stop it from the composer; the run is cancelled and the composer returns to idle.

## Sub-features

- `stop-composer` cancels the active run with the composer's `Stop` button.

## How to get to it (user POV)

- Choose `Stop` in the composer while `Chief is working` is shown.

## Driving it with control-rakazo

Preconditions:

- The baseline from the map README: onboarded, healthy, composer idle.

- **Start long work.** Send `Write a long report [[slow-final:30]]` and wait for `Chief is working`.
- **Stop.** After about 5s run `$C browser click --role button --name "Stop" --exact`. `Chief is working` disappears within a few seconds and `Send` is back.
- **Proof.** `$C browser snapshot --path <bundle>/after-stop.aria.txt` shows no bot reply to the report request. The newest run row reads `cancelled|user` (`select status, trigger from runs order by "createdAt" desc limit 1`). `fixture-log` shows the call's `start` followed by an `abort` record.
- **Next message.** Send `Summarize my week`. The next call's `newUserMessages` lists `Write a long report … ⏎ (The user stopped this request.)` before the new message.

## Gotchas

- `Stop` exists only while the bot is working; once the run is cancelled the composer shows `Send` and `Voice` instead, so a click after the run ends times out.
