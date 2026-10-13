# Chat reply

A user sends a message to a bot from the composer and the bot answers in the same thread.

## Sub-features

- `chat-send` sends a composer message into the thread.
- `chat-reply` shows the bot's answer after its run completes.
- `chat-working` shows `Chief is working` while the run is active.

## How to get to it (user POV)

- Open a bot from the sidebar, type in `Message <bot>` and press Enter or choose `Send`.

## Driving it with control-rakazo

Preconditions:

- The baseline from the map README: onboarded, healthy, composer idle.

- **Send.** Run `$C browser fill --css 'textarea[name="chat-message"]' --value "Summarize my week"` then `$C browser press Enter`. The message appears in `--testid transcript` and the status `Chief is working` shows.
- **Reply.** Run `$C browser wait --text "Chief is working" --state hidden --timeout 60000`. The transcript gains a reply `Fixture saw 1 new user message(s): «Summarize my week …»`.
- **Proof.** `$C browser screenshot --path <bundle>/reply.png`, `$C browser text --testid transcript`, and `$C fixture-log`: the newest call's `newUserMessages` holds the sent text followed by the current-time instruction.

## Gotchas

- `browser press Enter --placeholder "Message Chief"` times out; press Enter without a locator after filling.
- The ARIA snapshot renders the composer's value twice because of its mirror layer; the textarea holds it once.
- A message whose run was stopped has no reply, so the next model call receives it again alongside the new message (`Fixture saw 2 new user message(s)`). Start from an answered thread when a recipe expects exactly one.
- A run that fails before the model call (for example `Required context exceeds the model context budget`) shows no reply and no error. Read the run row before concluding the reply is slow.
