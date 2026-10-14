# Upstream candidates

Fork-only tracker for bugs and design gaps worth raising on elie222/rakazo. Branch upstream fixes from `upstream/main` so this file never ships in a PR. Entries follow the upstream bug template (description, steps, expected, actual, version) so they paste straight into an issue; keep them free of local paths and account details.

Evidence levels: **reproduced** means driven live with `verify-rakazo`; **observed** means seen during a live run but not isolated; **code-read** means inferred from source only.

Fixes 1–9 live on `fix/*` branches cut from `0394e92c`, one commit each (three for steering); fixes 10–17 are cut from `932534d7`, with no fork-only files, so `git cherry-pick` onto `upstream/main` gives a PR-ready branch. Fork `main` merges them all and was verified live with `verify-rakazo` (evidence `20261013-213200-steering-fixed`). Each PR still needs the `finalize` skill, and any user-facing copy quoted in its description.

Checked for duplicates on 2026-10-13: no open or closed upstream issue covers these. #910 (free-text replies refused during `waiting_input`) is related but separate.

| # | Title | Kind | Evidence | Fix | Upstream |
| --- | --- | --- | --- | --- | --- |
| 1 | Steering sent during the final answer is missed by that run | bug | reproduced | `fix/steering` 3a92c2cd | not filed |
| 2 | Steering continuation demotes the user's message to "Additional user context" | bug | reproduced | `fix/steering` 0cca295f | not filed |
| 3 | ~~A run that fails before the model call leaves no error in the chat~~ | invalid | rechecked live | none needed | do not file |
| 4 | Local provider's default 32k context window cannot fit the required tool context | bug | reproduced | `fix/context-budget-message` ee6ec2c2 (message only) | not filed |
| 5 | A stopped request is re-sent to the model as an open request | needs judgment | reproduced | `fix/stopped-request-history` 25ad1afe | not filed |
| 6 | Steering cannot interrupt a long model turn | design | reproduced | `fix/steering` 3ef80617 (depends on 1) | not filed |
| 7 | Owner messages wait behind routine, webhook and intro runs | design | code-read | design only, no code | not filed |
| 8 | Routine runs speak by default; silence is opt-in per prompt | design | code-read | `fix/routine-silence-default` 4a97ce5d | not filed |
| 9 | Prior assistant turns are sent to the model as user messages | needs judgment | reproduced | `fix/history-assistant-roles` 6e112d93 | ask first |
| 10 | A chat reply to a pending takeover is folded into another message and the browser is lost | bug | reproduced | `fix/takeover-chat-reply` c529ce34, 47970e2a | not filed |
| 11 | A transient provider overload or dropped stream fails the run | bug | reproduced | `fix/transient-model-retry` 2ea9eca9 | not filed |
| 12 | Websites with a third sign-in field cannot be filled from a saved login | gap | reproduced | `fix/login-extra-field` b9410a74, fff15f80 | not filed |
| 13 | Prompt prefix changes between runs, defeating provider prompt caching | design | reproduced | `fix/cache-stable-context` fb2613df, bcd16f38 | not filed |
| 14 | A credential pasted in chat is re-sent to the model on every later turn | bug | reproduced | `fix/pasted-secret-hygiene` 1904cb56 | not filed |
| 15 | A run that loses the model mid-work fails silently | bug | reproduced | `fix/failed-run-visible` e1f457cf, 518a7a53, 47547433 | not filed |
| 16 | Facts a tool returned in one run are gone in the next | design | reproduced | `fix/run-work-log` a00cc998 | not filed |
| 17 | A reply that promises more work ends the run | bug | reproduced | `fix/promise-follow-through` f055d573 | not filed |

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

**Fix.** `fix/steering` 3a92c2cd claims durable steering when a tool-free turn ends and steers it into the same run. A new `reply_complete` runtime event makes the executor publish the already-streamed reply as its own message. With 6 applied, most such steers become interrupts instead; this path covers a steer that lands after the stream ends.

**Version.** 0394e92c

## 2. Steering continuation demotes the user's message to "Additional user context"

**Description.** When steering waits for a continuation run (case 1, or a message held behind a routine), the model receives a generic instruction as the user's request and the user's actual words underneath it as background.

**Steps to reproduce.** Same as 1; read model call 3 in `fixture-log`.

**Expected.** The user's message is the request the model answers.

**Actual.** The model receives `Respond to the user's steering context.`, the current-time instruction, then `Additional user context:` followed by `Actually make it Thursday`.

**Where.** `packages/db/src/events.ts` `createPendingSteeringRun` sets the task prompt to `Respond to the user's steering context.`; `packages/adapters/src/pi-runtime.ts` appends initially claimed steering under `Additional user context:` and removes those messages from history.

**Fix.** `fix/steering` 0cca295f makes the continuation's task prompt the newest held message's text, and the runtime keeps that message and earlier held ones out of "Additional user context"; earlier ones stay in history as user turns. Two lifecycle assertions that pinned the old prompt were updated.

**Version.** 0394e92c

## 3. A run that fails before the model call leaves no error in the chat (invalid)

**Status.** Wrong. A live recheck shows an alert with the failure reason and a `Dismiss error` button; the first observation missed it. Kept here so nobody files it.

**Original description.** When run setup fails, the user's message sits in the thread with no reply and no error.

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

**Fix sketch.** Measure the required context for the default tool set and either raise the default or validate the window when the model is connected.

**Fix so far.** `fix/context-budget-message` ee6ec2c2 makes the failure actionable: `This chat needs about 38,600 tokens of context, but the selected model allows about 28,700; choose a model with a larger context window.` (user-facing copy; quote it in the PR). The default stays 32,768: the default non-graphical tool context measures about 36,800 tokens, and raising the budget past a real local model's window would only move the failure into the server. Validating the window at connect time is still open.

**Version.** 0394e92c

## 5. A stopped request is re-sent to the model as an open request

**Description.** After the user stops a run, that request has no reply, so the next model call receives it again alongside the new message.

**Steps to reproduce.** Send `Write a long report [[slow-final:30]]`, choose Stop after 5s, then send `Summarize my week`. The fixture reports two new user messages.

**Expected.** Needs a product call: a stopped request is probably cancelled, not pending.

**Actual.** The model sees both messages as unanswered and may resume the work the user stopped.

**Where.** History assembly for the next run; there is no marker for a cancelled request.

**Fix.** `fix/stopped-request-history` 25ad1afe appends `(The user stopped this request.)` to the model-facing history text of a user message whose source run was cancelled, including in compaction transcripts. Stored messages and the UI are unchanged. Verified live: the next call carries the note.

## 6. Steering cannot interrupt a long model turn or tool call

**Description.** Steering is read only between model turns. A correction sent during a long model call, shell command, computer action or sub-agent waits for it to finish, and the bot keeps doing work the user just redirected.

**Evidence.** Scenario B: a steer sent 4s into a 10s tool-calling turn was delivered only when the turn ended, 5–6s later. Longer tools make the wait proportionally longer.

**Fix.** `fix/steering` 3ef80617: while a reply streams, the runtime polls for steering once a second; on a hit it aborts only that model stream (a per-reply signal, so a finished stream is unaffected), drops the partial reply from the transcript, and continues the same run with the steer. The executor discards the partial text and clears the live preview. Running tools are not interrupted; cancelling tools safely is a separate design. Verified live: delivery dropped from 5–6s to about 1s.

**Open question for upstream.** The poll claims steering under the thread row lock once a second per streaming run. Fine for one owner; a busy multi-user deployment may want a realtime notification instead.

## 7. Owner messages wait behind routine, webhook and intro runs

**Description.** A message sent while one of the bot's routine, webhook or introduction runs is active is held as pending steering until that run finishes. A long routine blocks the owner completely.

**Where.** `packages/db/src/events.ts` (the `busy` check) and `apps/api/src/thread-target.ts` (`steersUserMessage`), introduced in #941 because a second run could overlap the first on a dedicated computer with no per-bot execution lease.

**Proposal.** Add a per-bot computer lease, then let a direct owner message preempt or run alongside background work instead of queueing behind it.

**Design notes (no code).** A message that started its own run would still wait: on a Team computer the per-bot lease is taken in `continueRun` before the model is called, even for the tool-less intro. Private computers take no lease at all (deliberate since #38), and the same lease row drives takeover refusal, the "Computer is busy" conflicts and boot claims. A sound fix: (1) acquire the computer lazily, on the first tool that needs it; (2) add a per-bot lease for Private computers without changing takeover and Boot/Reset/Update; (3) only then stop holding messages behind routine, webhook, intro and ticket runs. Two smaller pre-existing hazards worth their own fixes: the dedicated end-of-run checkpoint does not wait for another active run of the bot, and dedicated screen-lease takeover compares only fence numbers, so a requeued run can take the screen from a live one.

## 8. Routine runs speak by default; silence is opt-in per prompt

**Description.** A routine stays quiet only if its own prompt asks for it (`ROUTINE_SILENT_REPLY_GUIDANCE` in `packages/adapters/src/executor.ts`). Otherwise every routine run posts and marks the thread unread.

**Proposal.** Default background runs to silence unless there is something worth the user's attention, with routines opting into always-report.

**Fix.** `fix/routine-silence-default` 4a97ce5d rewrites the routine guidance so watch, check and monitor runs stay silent by default while scheduled reports and explicit always-report requests still post. It also treats `webhook` runs like routines (silent empty allowed, narration not promoted, no unread when silent), a wider change than the original issue that upstream should confirm. Not driven live; covered by an offline product journey through the real executor, Pi and webhook endpoint. Whether real models follow the new guidance is unmeasured.

## 9. Prior assistant turns are sent to the model as user messages

**Description.** `toHistory` in `packages/adapters/src/pi-runtime.ts` maps every history message to role `user`, prefixing the bot's own replies with `Assistant: `. The model cannot structurally tell its earlier replies from the user's messages.

**Open question.** This may be deliberate (provider neutrality, or because tool calls from earlier runs are not preserved). Ask upstream before treating it as a bug.

**Fix, pending that answer.** `fix/history-assistant-roles` 6e112d93 sends this bot's own earlier replies as text-only assistant messages; other group members' replies keep the quoted user form. Right before each call, a prior reply that would open the conversation or follow another assistant turn is sent quoted, so turns stay user-led for providers that require it. The recent-history window counts replies as turns, keeping its size. Verified live: request roles go `su`, `suau`, `suauau`. Unmeasured: real-provider behavior and the paid evals, which ran on the flattened layout.

## Live scorecard (`verify-rakazo` `eval-agent.mjs`, three trials, fixture model)

Scenarios S1–S9 are deterministic fixture drives of the real stack. Before = the deployed upstream build; after = fork `main` with 10–17 merged.

| Scenario | Before | After |
| --- | --- | --- |
| S1 transient overload is retried and answered | 0/1 | 3/3 |
| S2 a run that cannot reach the model is not silent | 0/1 | 3/3 |
| S3 chat reply to a pending takeover keeps the browser and arrives as its own message | 0/1 | 3/3 |
| S4 a tool fact from one run is available to the next | false pass | pending integration fix |
| S5 a reply that promises more work is followed by that work | 0/1 | 3/3 |
| S6 a pasted credential is not re-sent on later turns | 0/1 | 3/3 |
| S7 consecutive runs share a cacheable prefix | first change mid-history | 3/3, first change at the latest turn |
| S8 tool list identical across every call | 0/1 | 3/3 |
| S9 saving a memory note keeps the next run's prefix | first change at message 1 | 3/3 |

## 10. A chat reply to a pending takeover is folded into another message and the browser is lost

**Description.** When a bot asks the user to take over the screen and the user answers in chat instead, the reply is merged into the run's continuation prompt, and the resumed run is built without browser tools because the computer is still marked as held for the takeover.

**Steps to reproduce.** Drive a run to `request_takeover`, do not open the screen, reply in chat. The next model call lacks `browser_act` and the reply appears inside an "additional context" block.

**Fix.** `fix/takeover-chat-reply`: a chat reply releases the takeover hold (opened or unopened) through the same release path the Done button uses, and the reply is delivered as its own user turn. Verified live (S3).

## 11. A transient provider overload or dropped stream fails the run

**Description.** A single `503 overloaded` or a dropped SSE stream (`terminated`) fails the whole run, even after tool work.

**Fix.** `fix/transient-model-retry`: retries those failures with 2s, 8s and 20s backoff before failing, without replaying completed tool effects. Verified live (S1) and offline (dropped stream then overload after a tool call).

## 12. Websites with a third sign-in field cannot be filled from a saved login

**Description.** Banks often ask for a user code besides username and password. Saved logins hold only two fields.

**Fix.** `fix/login-extra-field`: an optional labelled extra field on website logins, filled with `browser_act fill_secret field:"extra"`. User-facing copy is the label the user types; quote it in the PR.

## 13. Prompt prefix changes between runs, defeating provider prompt caching

**Description.** Mutable state (memory, scratchpad, tickets, recalled memory, time) sat in the system prompt, visual-context pruning slid by one message per call, and the recent-history window slid by one exchange per run, so each run rewrote the prefix providers cache.

**Fix.** `fix/cache-stable-context`: static instructions and a stable tool list first, mutable state in the latest turn, pruning in batches, and the retrieval history window advancing in steps of its size. Logs `run.cache_usage`. Verified live (S7, S8, S9). Known remaining rewrite: older tool-result shortening changes the previous turn once.

**Integration note.** Combined with 9, the window must count conversation turns the same way retention does (`isConversationTurn`); fork `main` carries that one-line adjustment in its merge commit.

## 14. A credential pasted in chat is re-sent to the model on every later turn

**Description.** If the user pastes a password or code in chat, it stays in history, compaction summaries and memory, and every later model call carries it.

**Fix.** `fix/pasted-secret-hygiene`: `secure_pasted_secret` moves the value into encrypted storage as a command variable or a login field and replaces every copy in the chat, compaction summary and memory with `[saved as <name>]`; memory tools refuse protected values. Verified live (S6).

**Integration note.** With 12, a pasted value can fill the extra field and a partial login may hold any one field; fork `main` carries this in merge commit 52ef0178 and 2af34e2e.

## 15. A run that loses the model mid-work fails silently

**Description.** When a run fails after progress messages, the thread just stops at the last progress message; web shows a transient alert, mobile the raw error.

**Fix.** `fix/failed-run-visible`: for transient provider or connection failures, the run leaves a bot notice with Retry; Retry starts a new run with the request and a factual list of the failed attempt's tool calls. Other failures keep the existing error. User-facing copy to quote in the PR: "I didn't finish because the model provider is unavailable.", "I didn't finish because the connection dropped.", "Retry", "Could not retry", "This run cannot be retried.", "This failure is no longer the latest request." Verified live (S2).

## 16. Facts a tool returned in one run are gone in the next

**Description.** History across runs is text-only, so a balance a tool read in one run is unknown to the next run unless the bot repeated it in prose.

**Fix.** `fix/run-work-log`: each bot reply stores a bounded, redacted record of the run's tool calls and results and renders it as a `[past work]` block in later model history. No user-facing copy.

## 17. A reply that promises more work ends the run

**Description.** A model replying "I'm continuing with the analysis now and will report back shortly." ends the run; nothing continues.

**Fix.** `fix/promise-follow-through`: a deterministic English detector for explicit first-person commitments allows one internal follow-up turn asking the model to do the work or say what blocks it. Verified live (S5). Risk: heuristic, English only.

