# Upstream candidates

Fork-only tracker for bugs and design gaps worth raising on elie222/rakazo. Branch upstream fixes from `upstream/main` so this file never ships in a PR. Entries follow the upstream bug template (description, steps, expected, actual, version) so they paste straight into an issue; keep them free of local paths and account details.

Evidence levels: **reproduced** means driven live with `verify-rakazo`; **observed** means seen during a live run but not isolated; **code-read** means inferred from source only.

Fixes 1–9 live on `fix/*` branches cut from `0394e92c`, one commit each (three for steering); fixes 7 and 10–18 are cut from `932534d7`, with no fork-only files, so `git cherry-pick` onto `upstream/main` gives a PR-ready branch. Fork `main` merges them all and was verified live with `verify-rakazo` (evidence `20261013-213200-steering-fixed`). Each PR still needs the `finalize` skill, and any user-facing copy quoted in its description.

Checked for duplicates on 2026-10-13: no open or closed upstream issue covers these. #910 (free-text replies refused during `waiting_input`) is related but separate.

| # | Title | Kind | Evidence | Fix | Upstream |
| --- | --- | --- | --- | --- | --- |
| 1 | Steering sent during the final answer is missed by that run | bug | reproduced | `fix/steering` 178f87f4 | not filed |
| 2 | Steering continuation demotes the user's message to "Additional user context" | bug | reproduced | `fix/steering` 1ee523e9 | not filed |
| 3 | ~~A run that fails before the model call leaves no error in the chat~~ | invalid | rechecked live | none needed | do not file |
| 4 | Local provider's default 32k context window cannot fit the required tool context | bug | reproduced | `fix/context-budget-message` 08317f5b (message only) | not filed |
| 5 | A stopped request is re-sent to the model as an open request | needs judgment | reproduced | `fix/stopped-request-history` 2de7c78c | not filed |
| 6 | Steering cannot interrupt a long model turn | design | reproduced | `fix/steering` a53c8760 (depends on 1) | not filed |
| 7 | Owner messages wait behind routine, webhook and intro runs | design | reproduced | `fix/owner-priority` 4c6efef2, d8f4f455 | not filed |
| 8 | Routine runs speak by default; silence is opt-in per prompt | design | code-read | `fix/routine-silence-default` c838092b | not filed |
| 9 | Prior assistant turns are sent to the model as user messages | needs judgment | reproduced | `fix/history-assistant-roles` 4d75e0a6 | ask first |
| 10 | A chat reply to a pending takeover is folded into another message and the browser is lost | bug | reproduced | `fix/takeover-chat-reply` 483eb848, ecf80ea1, 8241c7a7 (rebased on upstream 60684ee3) | merged upstream as elie222/rakazo#1406 |
| 11 | A transient provider overload or dropped stream fails the run | bug | reproduced | `fix/transient-model-retry` cd48fb16, d5dcc36d, a0574037 (rebased on upstream 3209a27d) | merged upstream as elie222/rakazo#1392 |
| 12 | Websites with a third sign-in field cannot be filled from a saved login | gap | reproduced | `fix/login-extra-field` 78cc9c8e, 25d0d0bf | not filed |
| 13 | Prompt prefix changes between runs, defeating provider prompt caching | design | reproduced | `fix/cache-stable-context` d10daf93, 92ab2653 | not filed |
| 14 | A credential pasted in chat is re-sent to the model on every later turn | feature (too opinionated for upstream) | reproduced; S6 main 0/3, branch 3/3 | `fix/pasted-secret-hygiene` 336614cd (rebased on 39a676e2; fork main has the older 8ea7b673 version) | elie222/rakazo#1409 closed by us: new tool, history rewrite and run-wide redaction are a product call for the maintainer |
| 15 | A run that loses the model mid-work fails silently | bug | reproduced | `fix/failed-run-visible` f68e5806, fcaeb591, fdb1fb77 | not filed |
| 16 | Facts a tool returned in one run are gone in the next | design | reproduced | `fix/run-work-log` 7cb30170, c9ca101a | not filed |
| 17 | A reply that promises more work, or stops partway through a multi-step task, ends the run | bug | reproduced | `fix/promise-follow-through` 201d0af9, cb112392, 4dbd87f2 (scripted tests answer the completion check) | not filed |
| 18 | Every model call carries every tool schema | design | reproduced | `fix/tool-search` 39bcc16e, 31128f7b | not filed |
| 19 | A bot can register a stdio MCP server the deployment cannot run | bug | reproduced | `fix/reject-unrunnable-stdio-mcp` 8bec272f | not filed |
| 20 | Android chat links whose verified app is hidden from Rakazo do nothing | bug | reproduced | `fix/open-links-without-canopenurl` 0000930a | not filed |
| 21 | A stdio MCP server that needs a token can only get it pasted into chat | gap | reproduced | `fix/mcp-secret-env` 1e429e05, 58fa4680, 9b53e71c | not filed |

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

**Fix.** `fix/steering` 178f87f4 claims durable steering when a tool-free turn ends and steers it into the same run. A new `reply_complete` runtime event makes the executor publish the already-streamed reply as its own message. With 6 applied, most such steers become interrupts instead; this path covers a steer that lands after the stream ends.

**Version.** 0394e92c

## 2. Steering continuation demotes the user's message to "Additional user context"

**Description.** When steering waits for a continuation run (case 1, or a message held behind a routine), the model receives a generic instruction as the user's request and the user's actual words underneath it as background.

**Steps to reproduce.** Same as 1; read model call 3 in `fixture-log`.

**Expected.** The user's message is the request the model answers.

**Actual.** The model receives `Respond to the user's steering context.`, the current-time instruction, then `Additional user context:` followed by `Actually make it Thursday`.

**Where.** `packages/db/src/events.ts` `createPendingSteeringRun` sets the task prompt to `Respond to the user's steering context.`; `packages/adapters/src/pi-runtime.ts` appends initially claimed steering under `Additional user context:` and removes those messages from history.

**Fix.** `fix/steering` 1ee523e9 makes the continuation's task prompt the newest held message's text, and the runtime keeps that message and earlier held ones out of "Additional user context"; earlier ones stay in history as user turns. Two lifecycle assertions that pinned the old prompt were updated.

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

**Fix so far.** `fix/context-budget-message` 08317f5b makes the failure actionable: `This chat needs about 38,600 tokens of context, but the selected model allows about 28,700; choose a model with a larger context window.` (user-facing copy; quote it in the PR). The default stays 32,768: the default non-graphical tool context measures about 36,800 tokens, and raising the budget past a real local model's window would only move the failure into the server. Validating the window at connect time is still open.

**Version.** 0394e92c

## 5. A stopped request is re-sent to the model as an open request

**Description.** After the user stops a run, that request has no reply, so the next model call receives it again alongside the new message.

**Steps to reproduce.** Send `Write a long report [[slow-final:30]]`, choose Stop after 5s, then send `Summarize my week`. The fixture reports two new user messages.

**Expected.** Needs a product call: a stopped request is probably cancelled, not pending.

**Actual.** The model sees both messages as unanswered and may resume the work the user stopped.

**Where.** History assembly for the next run; there is no marker for a cancelled request.

**Fix.** `fix/stopped-request-history` 2de7c78c appends `(The user stopped this request.)` to the model-facing history text of a user message whose source run was cancelled, including in compaction transcripts. Stored messages and the UI are unchanged. Verified live: the next call carries the note.

## 6. Steering cannot interrupt a long model turn or tool call

**Description.** Steering is read only between model turns. A correction sent during a long model call, shell command, computer action or sub-agent waits for it to finish, and the bot keeps doing work the user just redirected.

**Evidence.** Scenario B: a steer sent 4s into a 10s tool-calling turn was delivered only when the turn ended, 5–6s later. Longer tools make the wait proportionally longer.

**Fix.** `fix/steering` a53c8760: while a reply streams, the runtime polls for steering once a second; on a hit it aborts only that model stream (a per-reply signal, so a finished stream is unaffected), drops the partial reply from the transcript, and continues the same run with the steer. The executor discards the partial text and clears the live preview. Running tools are not interrupted; cancelling tools safely is a separate design. Verified live: delivery dropped from 5–6s to about 1s.

**Open question for upstream.** The poll claims steering under the thread row lock once a second per streaming run. Fine for one owner; a busy multi-user deployment may want a realtime notification instead.

## 7. Owner messages wait behind routine, webhook and intro runs

**Description.** A message sent while one of the bot's routine, webhook or introduction runs is active is held as pending steering until that run finishes. A long routine blocks the owner completely.

**Where.** `packages/db/src/events.ts` (the `busy` check) and `apps/api/src/thread-target.ts` (`steersUserMessage`), introduced in #941 because a second run could overlap the first on a dedicated computer with no per-bot execution lease.

**Proposal.** Add a per-bot computer lease, then let a direct owner message preempt or run alongside background work instead of queueing behind it.

**Fix.** `fix/owner-priority`: an owner message sent while only a routine, webhook, intro or ticket run is active gets its own run. The background run yields at its next turn boundary between tool steps (an explicit `beforeNextTurn` steering claim), is requeued without being finalized (attempt `yielded`, no failure notice, schedule unchanged), and resumes after the owner's run with a model-only note and its earlier progress. A per-bot start gate keeps a background run and an owner run from executing at once on either computer type. Runs waiting for the user (takeover, input) keep holding messages. No user-facing copy. Verified offline against Postgres and live (S11). Known limits: a background run cannot yield during one long tool call; an owner message sent before the intro starts is answered before the intro.

**Integration note.** With 6 (steering polled during a streaming reply), only the next-turn claim may yield; fork `main` and the branch both carry the `beforeNextTurn` flag.

**Earlier design notes.** A message that started its own run would still wait: on a Team computer the per-bot lease is taken in `continueRun` before the model is called, even for the tool-less intro. Private computers take no lease at all (deliberate since #38), and the same lease row drives takeover refusal, the "Computer is busy" conflicts and boot claims. A sound fix: (1) acquire the computer lazily, on the first tool that needs it; (2) add a per-bot lease for Private computers without changing takeover and Boot/Reset/Update; (3) only then stop holding messages behind routine, webhook, intro and ticket runs. Two smaller pre-existing hazards worth their own fixes: the dedicated end-of-run checkpoint does not wait for another active run of the bot, and dedicated screen-lease takeover compares only fence numbers, so a requeued run can take the screen from a live one.

## 8. Routine runs speak by default; silence is opt-in per prompt

**Description.** A routine stays quiet only if its own prompt asks for it (`ROUTINE_SILENT_REPLY_GUIDANCE` in `packages/adapters/src/executor.ts`). Otherwise every routine run posts and marks the thread unread.

**Proposal.** Default background runs to silence unless there is something worth the user's attention, with routines opting into always-report.

**Fix.** `fix/routine-silence-default` c838092b rewrites the routine guidance so watch, check and monitor runs stay silent by default while scheduled reports and explicit always-report requests still post. It also treats `webhook` runs like routines (silent empty allowed, narration not promoted, no unread when silent), a wider change than the original issue that upstream should confirm. Not driven live; covered by an offline product journey through the real executor, Pi and webhook endpoint. Whether real models follow the new guidance is unmeasured.

## 9. Prior assistant turns are sent to the model as user messages

**Description.** `toHistory` in `packages/adapters/src/pi-runtime.ts` maps every history message to role `user`, prefixing the bot's own replies with `Assistant: `. The model cannot structurally tell its earlier replies from the user's messages.

**Open question.** This may be deliberate (provider neutrality, or because tool calls from earlier runs are not preserved). Ask upstream before treating it as a bug.

**Fix, pending that answer.** `fix/history-assistant-roles` 4d75e0a6 sends this bot's own earlier replies as text-only assistant messages; other group members' replies keep the quoted user form. Right before each call, a prior reply that would open the conversation or follow another assistant turn is sent quoted, so turns stay user-led for providers that require it. The recent-history window counts replies as turns, keeping its size. Verified live: request roles go `su`, `suau`, `suauau`. Unmeasured: real-provider behavior and the paid evals, which ran on the flattened layout.

## Live scorecard (`verify-rakazo` `eval-agent.mjs`, three trials, fixture model)

Scenarios S1–S9 are deterministic fixture drives of the real stack. Before = the deployed upstream build; after = fork `main` with 7 and 10–18 merged.

| Scenario | Before | After |
| --- | --- | --- |
| S1 transient overload is retried and answered | 0/1 | 3/3 |
| S2 a run that cannot reach the model is not silent | 0/1 | 3/3 |
| S3 chat reply to a pending takeover keeps the browser and arrives as its own message | 0/1 | 3/3 |
| S4 a tool fact from one run is available to the next | false pass | 3/3 |
| S5 a reply that promises more work is followed by that work | 0/1 | 3/3 |
| S12 a multi-step run that stops early goes on to finish | 0/3 | 3/3 |
| S6 a pasted credential is not re-sent on later turns | 0/1 | 3/3 |
| S7 consecutive runs share a cacheable prefix | first change mid-history | 3/3, first change at the latest turn |
| S8 tool list identical across every call | 0/1 | 3/3 |
| S10 a rarely used tool stays reachable while its schema is left out | not applicable (all 64 schemas sent) | 3/3, 31 tools and about 18k schema characters per call |
| S11 an owner message during a routine is answered before the routine finishes | held until the routine ended (code-read) | 3/3, routine attempts yielded then completed |
| S9 saving a memory note keeps the next run's prefix | first change at message 1 | 3/3 |

## 10. A chat reply to a pending takeover is folded into another message and the browser is lost

**Description.** When a bot asks the user to take over the screen and the user answers in chat instead, the reply is merged into the run's continuation prompt, and the resumed run is built without browser tools because the computer is still marked as held for the takeover.

**Steps to reproduce.** Drive a run to `request_takeover`, do not open the screen, reply in chat. The next model call lacks `browser_act` and the reply appears inside an "additional context" block.

**Fix.** `fix/takeover-chat-reply`: a chat reply releases the takeover hold (opened or unopened) through the same release path the Done button uses, so the resumed run keeps its browser. Verified live (S3, browser tools offered 3/3 against 0/3 on upstream main). The reply still arrives as additional user context; delivering it as its own user turn comes from `fix/steering` (2), not this branch.

## 11. A transient provider overload or dropped stream fails the run

**Description.** A single `503 overloaded` or a dropped SSE stream (`terminated`) fails the whole run, even after tool work.

**Fix.** `fix/transient-model-retry`: a configured backup is still tried first, unchanged; once no backup is left, the current model is retried after 2s, 8s and 20s before failing, without replaying completed tool effects. Timeouts are not retried, since they already spent the request budget. Verified live against upstream main (2 × 503, a dropped stream and 6 × 503 recover; 8 × 503 fails with the original error after 33s) and offline (dropped stream then overload after a tool call; backup-chain tests unchanged).

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

**Integration note.** With 12, a pasted value can fill the extra field and a partial login may hold any one field; fork `main` carries this in merge commit 7233d71a and 8fa8aab6.

## 15. A run that loses the model mid-work fails silently

**Description.** When a run fails after progress messages, the thread just stops at the last progress message; web shows a transient alert, mobile the raw error.

**Fix.** `fix/failed-run-visible`: for transient provider or connection failures, the run leaves a bot notice with Retry; Retry starts a new run with the request and a factual list of the failed attempt's tool calls. Other failures keep the existing error. User-facing copy to quote in the PR: "I didn't finish because the model provider is unavailable.", "I didn't finish because the connection dropped.", "Retry", "Could not retry", "This run cannot be retried.", "This failure is no longer the latest request." Verified live (S2).

## 16. Facts a tool returned in one run are gone in the next

**Description.** History across runs is text-only, so a balance a tool read in one run is unknown to the next run unless the bot repeated it in prose.

**Fix.** `fix/run-work-log`: each bot reply stores a bounded, redacted record of the run's tool calls and results and renders it as a `[past work]` block in later model history. No user-facing copy.

## 17. A reply that promises more work ends the run

**Description.** A model replying "I'm continuing with the analysis now and will report back shortly." ends the run; nothing continues.

**Fix.** `fix/promise-follow-through`: a deterministic English detector for explicit first-person commitments allows one internal follow-up turn asking the model to do the work or say what blocks it. Verified live (S5). Risk: heuristic, English only.

**Seen on the live deployment.** A long collection run ended with an acknowledgement and work left undone, and a later "Yes—I'm continuing now" reply ended its run seconds later; the detector returned false for both.

**Follow-up (cb112392).** The detector accepts short lead-ins ("Yes—", "Next") and more work verbs. A run with five or more tool calls that answers gets one hidden completion check: the model continues with tools, states the blocker, or replies DONE, which is never shown; at most two per run, skipped for silent routines and short runs. Verified live (S12: upstream 0/3, branch 3/3; S5 3/3). Cost: one extra model call at the end of long runs.

## 18. Every model call carries every tool schema

**Description.** Each model call sends all 64 built-in tool schemas (about 40,000 characters, roughly 10,000 tokens) plus every connected MCP or integration tool. The bundled local provider's default 32,768-token window cannot fit that with history (issue 4), and selection quality drops as connectors are added. On a live deployment about 20 tools accounted for nearly every call; the largest schema, `schedule_create`, was called twice.

**Fix.** `fix/tool-search`: the run's authorized tool set is computed exactly as before, then split into a fixed core set sent with full schemas and a deferred rest. `find_tools` returns matching deferred schemas as a tool result and lists deferred names in its description; `use_tool`, or a direct call by name, runs a deferred tool through the same approval, replay, validation and audit path, with audits and approvals naming the inner tool. The tool list stays byte-identical across calls and runs. No user-facing copy. Verified live (S10) and offline, including connector approval parity and filtered tools staying unreachable. Known limit: a scheduling lookup with full executor instructions still exceeds the smallest local budget.

**Integration notes.** With 14, `secure_pasted_secret` must be in the core set. With 10, the takeover-hold refusal must run before deferred argument validation. Fork `main` carries both in its merge commit.

---

## 19. A bot can register a stdio MCP server the deployment cannot run

**Description.** On a deployment with `MCP_STDIO_ENABLED` unset, or with the command missing from `MCP_STDIO_ALLOWED_COMMANDS`, `add_mcp_server` accepts a stdio server and reports success. Every later discovery fails with "MCP stdio is disabled", so the bot never gets the server's tools and the user sees no error.

**Steps to reproduce.** With stdio disabled, ask a bot to add an MCP server documented as `npx -y <package>`. Approve the card, then ask the bot to use the server's tools.

**Expected.** The bot is told this deployment cannot run that command and asks for a remote endpoint.

**Actual.** The server is created and approved; discovery fails on every turn and only the worker log says why.

**Fix.** `fix/reject-unrunnable-stdio-mcp`: the composition roots pass the runnable stdio commands (empty when stdio is disabled) to the executor, and `add_mcp_server` refuses any other command before anything is stored. The e2e harness allowlists `echo` for the scripted approval-card fixture. Verified with a unit test (fails without the fix), and with the approval-card e2e passing with `echo` allowed and showing no card with stdio off. The refusal is model-facing only, with no user-facing copy.

## 20. Android chat links whose verified app is hidden from Rakazo do nothing

**Description.** On Android 11+, `Linking.canOpenURL` only sees packages the manifest's `<queries>` expose. When a link's domain is a verified app link of an installed app that Rakazo cannot see, it returns false, so tapping Open in the link confirmation dialog does nothing.

**Steps to reproduce.** On Android, install an app that verifies its domain (a bank or budgeting app), get a bot message linking to that domain, tap the link, then tap Open.

**Expected.** The app or the browser opens the link.

**Actual.** The dialog closes and no intent is sent (logcat shows no `START u0` for the tap, while a link to another domain opens normally).

**Fix.** `fix/open-links-without-canopenurl`: open the sanitized URL directly and ignore a rejection. The markdown tests now mock `canOpenURL` as false, so all five link tests fail if the gate returns. Root cause confirmed from device logcat; the fixed build has not yet run on a device. No user-facing copy.

## 21. A stdio MCP server that needs a token can only get it pasted into chat

**Description.** `add_mcp_server` takes stdio environment variables as literal values only, and the approval card has no input. A stdio server that needs an API token (for example `npx -y <package>` reading `<NAME>_PAT`) can only receive it if the user pastes the token into chat, where the model and the message history keep it. Bots tell the user the token will be "entered securely", but no such path exists.

**Steps to reproduce.** With stdio MCP enabled and `npx` allowed, ask a bot to add a stdio MCP server that needs a token in an environment variable, and say you will enter the token yourself.

**Expected.** The approval card asks for the token in a masked field; the value goes to the server's encrypted credential and never through the model.

**Actual.** The card has only Approve and Not now; the server is created with no env and fails until the token is pasted into chat.

**Fix.** `fix/mcp-secret-env`: `add_mcp_server` takes `secret_env` (names only); the card shows one masked field per name on web and mobile; `mcp.assignments.approve` accepts `env` and merges it into the encrypted credential inside the approval transaction. No new copy: each field's label is the variable name. A Postgres test drives the real approve route and checks the value appears only in the decrypted credential and that a dismissed card leaves it unchanged. Verified live on the fork deployment with a fake key: the server process got the value, and the database dump and logs had no copy of it. The first build's `autocomplete="off"` let Chrome autofill the saved login password into the field; `new-password` fixed it. The mobile card was only typechecked. Fork PR vardior/rakazo#1.
