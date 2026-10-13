---
name: verify-rakazo
description: Live-verify Rakazo's web chat end to end on an isolated local stack (real API, worker, web and Pi agent loop, scripted fixture model, fake sandbox) driven through a headless browser. Use when a change to chat, runs, steering, onboarding or bot behavior needs proof beyond unit tests, or to reproduce a timing bug in the agent loop.
---

# verify-rakazo

`bin/control-rakazo.mjs` starts a private Rakazo stack, drives its web UI and collects proof. Every command prints JSON; `--help` lists them. Run it from the checkout under test: it drives the code in the checkout that contains it.

```bash
C=.agents/skills/verify-rakazo/bin/control-rakazo.mjs
```

What a run is made of:

- Its own Postgres container (`postgres:16-alpine`, labeled `rakazo.verify=<id>`), migrated from this checkout.
- `apps/api`, `apps/worker` and `apps/web` started from this checkout on free ports, with the real Pi runtime, `SANDBOX_PROVIDER=fake`, fixed test secrets and a scratch `DATA_DIR`.
- A fixture model (`bin/fixture-model.mjs`) served as the `local` provider. It streams on a schedule you choose and its reply names the exact user messages it received, so the transcript itself shows what the agent loop delivered.
- A browser daemon (`bin/browser-daemon.mjs`) that holds one headless Playwright page.
- Scratch state lives in `.verify-runs/<id>/` (gitignored). No `.env` value reaches the stack when using the fixture model: `up` blanks every checkout credential.

It never touches a developer's own `pnpm dev`, their Postgres database or their Docker computers. Two runs can coexist; pass `--id` when more than one is live.

## Launch

```bash
$C up                    # fixture model; prints {"ready": true, "webUrl": ...}
$C up --model env        # the checkout's .env deployment model instead (real provider, costs money)
$C onboard               # UI sign-up, model connect, skip integrations; lands in Chief's chat
```

`up` returns only after Postgres, the fixture, the API (`/health` 200), the worker (`worker ready`), the web server and a first page load are all ready. That takes about 30–60s, most of it Vite's first dependency bundle. Requires `pnpm install && pnpm db:generate` in the checkout and a running Docker daemon.

## Doctor

```bash
$C doctor
```

Read-only. Checks every process the run started is alive, the API and web ports are held by those processes, `/health` answers, the web serves, the browser daemon answers, the fixture model answers, the Postgres container runs, and the checkout's `HEAD` still matches the SHA recorded at `up`. Exits 1 with the failing check names when unhealthy. Run it first whenever anything looks off, and before trusting evidence.

## Drive

Browser commands act on the run's single page. Locators: `--role R --name N`, `--testid ID`, `--placeholder P`, `--label L`, `--text T`, `--css S`, with optional `--exact` and `--nth N`.

```bash
$C browser open /app
$C browser fill --css 'textarea[name="chat-message"]' --value "hello"
$C browser press Enter
$C browser wait --text "Chief is working" --state hidden --timeout 120000
$C browser text --testid transcript
$C browser snapshot --path <bundle>/state.aria.txt
$C browser screenshot --path <bundle>/state.png
```

Fixture model markers, placed in the user's message:

| Marker | Model behavior |
| --- | --- |
| none | Replies at once: `Fixture saw N new user message(s): «…»` |
| `[[slow-final:S]]` | Streams a final answer (no tools) over S seconds, default 20 |
| `[[slow-tool:S]]` | Streams for S seconds (default 10), then calls `message_user`; the next turn replies as above |

`$C fixture-log` lists every model call with `start`/`end` timestamps, the plan, and the user messages that call received. `$C logs <api|worker|web|fixture|browser>` tails a process log. The run's database is reachable with `docker exec rakazo-verify-<id>-pg psql -U rakazo -d rakazo`.

`bin/scenario-steering.sh <bundle>` runs the steering scenarios from `features/steering.md` end to end and writes their artifacts into the bundle.

## Evidence

```bash
$C evidence new <slug>                               # prints the bundle path
$C evidence index <bundle> --verdict pass|fail|partial [--prs 123]
```

A bundle is `evidence/<YYYYMMDD-HHMMSS>-<slug>/` with `EVIDENCE.md` and the raw artifacts it cites. `evidence/INDEX.md` has one line per bundle. Both are gitignored and survive `down`.

`EVIDENCE.md` holds: a header naming the checkout branch and SHA, the worktree, the harness SHA and the run id; a scenario table (driven → observed → evidence file); negative probes; honest caveats; and `## For the PR`, written for a reviewer who cannot see this disk (surface exercised, what it proves and does not prove, driven → observed, with no paths, bundle ids or SHAs). A PR's `## Verification` section copies that block verbatim. Nothing else from the bundle goes into a PR; Rakazo is public.

Proof standards:

- Drive the user path: the composer, buttons and pages a user touches. RPC calls and DB writes are for observing, not for causing the behavior under test.
- Capture the action and the resulting state: a screenshot or ARIA snapshot before and after, plus the fixture log for anything the agent loop did.
- Check side effects alongside the screen: run rows (`status`, `trigger`, `error`), steering rows, the model calls the fixture received.
- The fixture model is the only mock. It proves harness timing and prompt framing, not model quality; say so in caveats, and use `--model env` when the claim depends on a real model.

## Cleanup

```bash
$C down --dry-run    # shows exactly what will be stopped and deleted
$C down
```

`down` stops only the process groups recorded at `up`, removes the run's Postgres container and deletes `.verify-runs/<id>/`. It never kills by process name and never touches `evidence/`. Run it after every attempt, failed ones included, so ports and containers are not stranded. `$C list` shows any runs left behind.

## Feature map

[`features/README.md`](features/README.md) indexes the user-facing features with recipes. Read it before driving, and update the matching file whenever a run shows a recipe drifted.
