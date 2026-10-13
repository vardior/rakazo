# Steering

A message a user sends while the bot is still working guides that work. It interrupts a streaming reply, reaches the active run between model turns, or starts a follow-up run when it was held behind other work.

## Sub-features

- `steer-interrupt` aborts a reply that is still streaming, drops the partial text, and answers the steer in the same run.
- `steer-tool-turn` delivers a message sent while a tool runs to the next model call of the same run. Running tools are never interrupted.
- `steer-final-turn` covers a steer that lands after the reply stream ended but before the run did: the finished reply stays as its own message and the same run answers the steer.
- `steer-continuation-framing` is what a follow-up run's model receives for a held message: the message itself as the request, with earlier held messages as ordinary user turns.

## How to get to it (user POV)

- Send a message, then send another one from the composer while `Chief is working` is shown.

## Driving it with control-rakazo

Preconditions:

- The baseline from the map README: onboarded, healthy, composer idle.
- An evidence bundle from `$C evidence new steering`.

- **All scenarios.** Run `.agents/skills/verify-rakazo/bin/scenario-steering.sh <bundle>`. It drives the two steps below, captures screenshots and ARIA snapshots before and after each, and prints a model-call table to `model-calls.txt`.
- **Steer a streaming answer.** Send `Book the dentist for Tuesday [[slow-final:20]]`, wait for `Chief is working`, wait 6s, send `Actually make it Thursday`. Within about a second the call's stream is aborted and the next call in the same run replies `Fixture saw 2 new user message(s): «Book the dentist … » | «Actually make it Thursday»`. The thread shows that one reply; the partial Tuesday answer is gone.
- **Steer during tool narration.** Send `Check the status page [[slow-tool:10]]`, wait 4s, send `Also mention Thursday`. The narration stream is aborted before its `message_user` call and the next call lists both messages. There is no second run.
- **Proof.** In `fixture-log`, the steered call ends with an `abort` record (its `streamed` field holds the partial text) within about a second of the steer, and the next call starts at the same moment. `select trigger, status from runs order by "createdAt"` shows one `user` run per request and no `follow_up`.

## Gotchas

- The fixture streams word by word, so any steer sent during a `slow-*` call is an interrupt. `steer-final-turn` and `steer-continuation-framing` need precise timing or a held intro, and are covered by `packages/testkit/src/steering.postgres.test.ts` rather than a live recipe.
- Two new user messages in the next call is expected after an interrupt: the dropped partial means no assistant turn separates them.
- A run started by a routine, webhook or the bot's introduction does not take steering; the message waits for that run to finish and is answered by a `follow_up` run.
