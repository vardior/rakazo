# Upstream candidates

Fork-only tracker for bugs and design gaps worth raising on elie222/rakazo. Branch upstream fixes from `upstream/main` so this file never ships in a PR. Entries follow the upstream bug template (description, steps, expected, actual, version) so they paste straight into an issue; keep them free of local paths and account details.

Evidence levels: **reproduced** means driven live with `verify-rakazo`; **observed** means seen during a live run but not isolated; **code-read** means inferred from source only.

Checked for duplicates on 2026-10-13: no open or closed upstream issue covers these. #910 (free-text replies refused during `waiting_input`) is related but separate.

| # | Title | Kind | Evidence | Upstream |
| --- | --- | --- | --- | --- |
| 1 | Steering sent during the final answer is missed by that run | bug | reproduced | not filed |
| 2 | Steering continuation demotes the user's message to "Additional user context" | bug | reproduced | not filed |
| 3 | A run that fails before the model call leaves no error in the chat | bug | reproduced | not filed |
| 4 | Local provider's default 32k context window cannot fit the required tool context | bug | reproduced | not filed |
| 5 | A stopped request is re-sent to the model as an open request | needs judgment | observed | not filed |
| 6 | Steering cannot interrupt a long model turn or tool call | design | reproduced | not filed |
| 7 | Owner messages wait behind routine, webhook and intro runs | design | code-read | not filed |
| 8 | Routine runs speak by default; silence is opt-in per prompt | design | code-read | not filed |
| 9 | Prior assistant turns are sent to the model as user messages | needs judgment | code-read | not filed |

---

## 1. Steering sent during the final answer is missed by that run

**Description.** A message sent while the bot streams its final, tool-free answer is not seen by that answer. The run completes with a reply that ignores it, and a follow-up run answers the message afterwards, so the user gets a stale reply followed by a second one.

**Steps to reproduce.**
1. `control-rakazo up && control-rakazo onboard`
2. Send `Book the dentist for Tuesday [[slow-final:20]]`.
3. Six seconds later, while the answer is streaming, send `Actually make it Thursday`.
4. Or run `bin/scenario-steering.sh <bundle>` (scenario A).

**Expected.** The correction reaches the run before it finishes, or the stale final answer is held back and replaced by one that accounts for it.

**Actual.** Model call 2 (20s stream) lists only the Tuesday message. The run completes with that reply. A new `follow_up` run then makes model call 3 for the correction.

**Where.** `packages/adapters/src/pi-runtime.ts` reads durable steering only in `prepareNextTurnWithContext`, which Pi's agent loop calls only when another tool turn follows. After a tool-free turn the loop checks its in-memory steering queue, which is empty, and ends. `packages/db/src/events.ts` `createPendingSteeringRun` then starts the continuation.

**Fix sketch.** Before the loop ends, claim durable steering (for example in `finishTurn`, or by backing `getSteeringMessages` with `claimSteering`) and continue the same run when anything was claimed. Decide whether the already-streamed stale answer is persisted or superseded.

**Version.** 0394e92c

## 2. Steering continuation demotes the user's message to "Additional user context"

**Description.** When steering waits for a continuation run (case 1, or a message held behind a routine), the model receives a generic instruction as the user's request and the user's actual words underneath it as background.

**Steps to reproduce.** Same as 1; read model call 3 in `fixture-log`.

**Expected.** The user's message is the request the model answers.

**Actual.** The model receives `Respond to the user's steering context.`, the current-time instruction, then `Additional user context:` followed by `Actually make it Thursday`.

**Where.** `packages/db/src/events.ts` `createPendingSteeringRun` sets the task prompt to `Respond to the user's steering context.`; `packages/adapters/src/pi-runtime.ts` appends initially claimed steering under `Additional user context:` and removes those messages from history.

**Fix sketch.** Make the newest steering message the turn's prompt (it is already the run's `sourceMessageId`) and keep earlier ones as ordinary user turns.

**Version.** 0394e92c

## 3. A run that fails before the model call leaves no error in the chat

**Description.** When run setup fails, the user's message sits in the thread with no reply and no error.

**Steps to reproduce.** Start the stack with the local provider at its default context window (drop `RAKAZO_LOCAL_CONTEXT_WINDOW` from `stackEnv` in `control-rakazo.mjs`), onboard, and send any message.

**Expected.** The thread shows that the bot could not answer and why, or what to change.

**Actual.** The run row reads `failed` with `Required context exceeds the model context budget`; the chat shows only the user's message and the working status disappears.

**Where.** Not yet traced: failure persistence in `packages/adapters/src/executor.ts` run setup, and how the web transcript renders failed runs.

**Version.** 0394e92c

## 4. Local provider's default 32k context window cannot fit the required tool context

**Description.** With the local OpenAI-compatible provider and no `RAKAZO_LOCAL_CONTEXT_WINDOW`, every user run fails before calling the model. The bot's introduction (no tools) succeeds, which hides the problem until the first real message.

**Steps to reproduce.** As in 3.

**Expected.** The default works with Rakazo's own tool set, or connecting a model with too small a window is refused with a clear message.

**Actual.** `Required context exceeds the model context budget` on every user run.

**Where.** `packages/adapters/src/pi-local-provider.ts` defaults `contextWindow` to 32,768.

**Fix sketch.** Measure the required context for the default tool set and either raise the default or validate the window when the model is connected. Pairs with 3.

**Version.** 0394e92c

## 5. A stopped request is re-sent to the model as an open request

**Description.** After the user stops a run, that request has no reply, so the next model call receives it again alongside the new message.

**Steps to reproduce.** Send `Write a long report [[slow-final:30]]`, choose Stop after 5s, then send `Summarize my week`. The fixture reports two new user messages.

**Expected.** Needs a product call: a stopped request is probably cancelled, not pending.

**Actual.** The model sees both messages as unanswered and may resume the work the user stopped.

**Where.** History assembly for the next run; there is no marker for a cancelled request.

**Fix sketch.** Mark stopped requests in history (for example a short "the user stopped this" note) so the model does not treat them as open.

## 6. Steering cannot interrupt a long model turn or tool call

**Description.** Steering is read only between model turns. A correction sent during a long model call, shell command, computer action or sub-agent waits for it to finish, and the bot keeps doing work the user just redirected.

**Evidence.** Scenario B: a steer sent 4s into a 10s tool-calling turn was delivered only when the turn ended, 5–6s later. Longer tools make the wait proportionally longer.

**Proposal.** Give owner messages in a direct chat an interrupt lane: abort the in-flight model stream (and cancellable tools) and restart the turn with the message, as the always-on assistant designs that treat a direct owner message as preempting background work do.

## 7. Owner messages wait behind routine, webhook and intro runs

**Description.** A message sent while one of the bot's routine, webhook or introduction runs is active is held as pending steering until that run finishes. A long routine blocks the owner completely.

**Where.** `packages/db/src/events.ts` (the `busy` check) and `apps/api/src/thread-target.ts` (`steersUserMessage`), introduced in #941 because a second run could overlap the first on a dedicated computer with no per-bot execution lease.

**Proposal.** Add a per-bot computer lease, then let a direct owner message preempt or run alongside background work instead of queueing behind it.

## 8. Routine runs speak by default; silence is opt-in per prompt

**Description.** A routine stays quiet only if its own prompt asks for it (`ROUTINE_SILENT_REPLY_GUIDANCE` in `packages/adapters/src/executor.ts`). Otherwise every routine run posts and marks the thread unread.

**Proposal.** Default background runs to silence unless there is something worth the user's attention, with routines opting into always-report.

## 9. Prior assistant turns are sent to the model as user messages

**Description.** `toHistory` in `packages/adapters/src/pi-runtime.ts` maps every history message to role `user`, prefixing the bot's own replies with `Assistant: `. The model cannot structurally tell its earlier replies from the user's messages.

**Open question.** This may be deliberate (provider neutrality, or because tool calls from earlier runs are not preserved). Ask upstream before treating it as a bug.
