# Rakazo verification map

The maintained source for verifying Rakazo's user-facing web chat. Read this index, then drive the matching feature file.

## Baseline preconditions

- A run started from this checkout with `control-rakazo up` and onboarded with `control-rakazo onboard`.
- `control-rakazo doctor` reports `"healthy": true`.
- The page shows Chief's chat with the composer `textarea[name="chat-message"]` idle (no `Chief is working` status).
- Never drive a stack this skill did not start.

## Driving conventions

- `C=.agents/skills/verify-rakazo/bin/control-rakazo.mjs`; every command below is `$C …`.
- Prefer roles, accessible names and `data-testid` values. The composer is the exception: use `--css 'textarea[name="chat-message"]'` and send with `browser press Enter` (keyboard, no locator).
- Control model timing with fixture markers (`[[slow-final:S]]`, `[[slow-tool:S]]`), never with sleeps inside the product.
- Wait for `Chief is working` to be hidden twice, a few seconds apart, before reading a final state; a continuation run can start right after the first run ends.

## Proof and skip reporting

- UI proof: a screenshot plus an ARIA snapshot taken after the action.
- Agent-loop proof: `fixture-log` output showing which model call received which user message, with timestamps.
- Run proof: the run's `status`, `trigger` and `error` from the run database.
- Report an entry point you could not drive with the command you tried and the unmet precondition. Do not report it as verified through another path.

## Feature entry contract

Each feature file has an H1, a one-paragraph description, then exactly: `Sub-features`, `How to get to it (user POV)`, `Driving it with control-rakazo` (starting with `Preconditions:`), and `Gotchas`.

## Features

- [Onboarding](./onboarding.md) covers sign-up, model connection, skipping integrations and landing in the first bot's chat.
- [Chat reply](./chat-reply.md) covers sending a message and receiving the bot's reply.
- [Steering](./steering.md) covers messages sent while the bot is working: during a tool turn and during the final answer.
- [Stop a run](./stop-run.md) covers cancelling a bot's work from the composer.
