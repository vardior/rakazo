# Steering

A message a user sends while the bot is still working is meant to guide that work. It reaches the active run between model turns, or starts a follow-up run when the active run ends first.

## Sub-features

- `steer-tool-turn` delivers a message sent during a tool-calling turn to the next model call of the same run.
- `steer-final-turn` covers a message sent while the bot streams its final answer: today the answer does not see it, and a follow-up run answers it.
- `steer-continuation-framing` is what the follow-up run's model receives: `Respond to the user's steering context.` with the user's text under `Additional user context:`.

## How to get to it (user POV)

- Send a message, then send another one from the composer while `Chief is working` is shown.

## Driving it with control-rakazo

Preconditions:

- The baseline from the map README: onboarded, healthy, composer idle.
- An evidence bundle from `$C evidence new steering`.

- **All scenarios.** Run `.agents/skills/verify-rakazo/bin/scenario-steering.sh <bundle>`. It drives the two steps below, captures screenshots and ARIA snapshots before and after each, and prints a model-call table to `model-calls.txt`.
- **Final-turn steer.** Send `Book the dentist for Tuesday [[slow-final:20]]`, wait for `Chief is working`, wait 6s, send `Actually make it Thursday`. The answer streams for 20s and names only the Tuesday message. A second reply follows whose quoted message starts `Respond to the user's steering context.` and ends `Additional user context: ⏎ Actually make it Thursday`.
- **Tool-turn steer.** Send `Check the status page [[slow-tool:10]]`, wait 4s, send `Also mention Thursday`. When the 10s turn and its `message_user` call finish, the next model call in the same run replies `Fixture saw 1 new user message(s): «Also mention Thursday»`. There is no second run.
- **Proof.** In `fixture-log`, the final-turn steer's timestamp falls between call N's `start` and `end`, call N's `newUserMessages` lacks it, and call N+1 starts at call N's `end`. For the tool-turn steer, the call after the tool turn lists it. The run database shows the extra `follow_up` run only for the final-turn case: `select status, trigger from runs order by "createdAt"`.

## Gotchas

- Steering is read only between model turns. A steer sent during a long model call or tool waits for it to finish; measure delivery latency from the fixture timestamps, not from the screen.
- Wait for `Chief is working` to be hidden twice: the follow-up run starts the instant the first run ends.
- A run started by a routine, webhook or the bot's introduction does not take steering; the message waits for that run to finish. Not covered by these scenarios yet.
- The expectations in `steer-final-turn` and `steer-continuation-framing` describe current behavior. A fix to either must update this file in the same change.
