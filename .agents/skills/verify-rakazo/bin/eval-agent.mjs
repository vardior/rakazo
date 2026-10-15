#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const bin = path.dirname(fileURLToPath(import.meta.url));
const ctlPath = path.join(bin, "control-rakazo.mjs");
const repoRoot = path.resolve(bin, "../../../..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { trials: { type: "string" }, only: { type: "string" }, keep: { type: "boolean" } },
});
const bundle = positionals[0];
if (!bundle) {
  console.error("usage: eval-agent.mjs <evidence-bundle-dir> [--trials K] [--only S1,S4] [--keep]");
  process.exit(2);
}
const trials = Number(values.trials ?? 3);
const only = values.only ? new Set(values.only.split(",")) : null;
const composer = 'textarea[name="chat-message"]';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ctl(id, ...args) {
  const out = execFileSync("node", [ctlPath, ...args, "--id", id], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

function stateOf(id) {
  return JSON.parse(readFileSync(path.join(repoRoot, ".verify-runs", id, "state.json"), "utf8"));
}

function psql(state, sql) {
  return execFileSync(
    "docker",
    ["exec", state.postgresContainer, "psql", "-U", "rakazo", "-d", "rakazo", "-At", "-c", sql],
    { encoding: "utf8" },
  ).trim();
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function calls(id) {
  const dir = path.join(repoRoot, ".verify-runs", id);
  const starts = readJsonl(path.join(dir, "fixture-requests.jsonl")).filter(
    (entry) => entry.phase === "start",
  );
  const bodies = new Map(
    readJsonl(path.join(dir, "fixture-requests-bodies.jsonl")).map((entry) => [entry.n, entry]),
  );
  return starts.map((start) => ({ ...start, body: bodies.get(start.n) }));
}

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part.text ?? "").join("")
      : "";

function send(id, text) {
  ctl(id, "browser", "fill", "--css", composer, "--value", text);
  ctl(id, "browser", "press", "Enter");
}

async function settle(state, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  await sleep(1500);
  while (Date.now() < deadline) {
    const busy = Number(
      psql(state, `select count(*) from runs where status in ('queued','leased','running')`),
    );
    if (busy === 0) return true;
    await sleep(1000);
  }
  return false;
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(1000);
  }
  return false;
}

function sourceRun(state, marker) {
  const row = psql(
    state,
    `select r.status || '|' || coalesce(r.error,'') || '|' || m.seq from messages m join runs r on r."sourceMessageId" = m.id where m.role = 'user' and m.blocks::text like '%${marker}%' order by m.seq desc limit 1`,
  );
  const [status, error, seq] = row.split("|");
  return { status, error, seq: Number(seq) };
}

function serialize(body) {
  return JSON.stringify({
    instructions: body?.instructions,
    tools: body?.tools,
    messages: body?.messages,
  });
}

function messagePrefix(firstBody, secondBody) {
  const first = firstBody?.messages ?? [];
  const second = secondBody?.messages ?? [];
  const tools = JSON.stringify(firstBody?.tools) === JSON.stringify(secondBody?.tools);
  let index = 0;
  while (
    index < first.length - 1 &&
    index < second.length &&
    JSON.stringify(first[index]) === JSON.stringify(second[index])
  )
    index += 1;
  const firstText = JSON.stringify(first);
  const reused = JSON.stringify(first.slice(0, index)).length;
  return {
    tools,
    ratio: tools && firstText.length ? reused / firstText.length : 0,
    breakAt: index < first.length - 1 ? `${index}:${first[index]?.role}` : "latest turn",
  };
}

const scenarios = [
  {
    id: "S1",
    title: "A transient provider overload is retried and the request is answered",
    async run({ id, state }) {
      send(id, "[[fail:2:overloaded]] S1 ping");
      await settle(state, 120_000);
      const run = sourceRun(state, "S1 ping");
      return {
        pass: run.status === "completed",
        observed: `run ${run.status} ${run.error}`.trim(),
      };
    },
  },
  {
    id: "S2",
    title: "A run that cannot reach the model is not silent",
    async run({ id, state }) {
      send(id, "[[fail:20:terminated]] S2 ping");
      await settle(state, 180_000);
      const run = sourceRun(state, "S2 ping");
      const after = Number(
        psql(
          state,
          `select count(*) from messages where seq > ${run.seq} and role in ('bot','system')`,
        ),
      );
      return {
        pass: run.status === "completed" || after > 0,
        observed: `run ${run.status} ${run.error}; ${after} bot/system message(s) after the request`,
      };
    },
  },
  {
    id: "S4",
    title: "A fact a tool returned in one run is available to the next run",
    async run({ id, state }) {
      send(id, '[[tool:shell:{"command":"echo S4_BALANCE=4321.09"}]] S4 check the balance');
      await settle(state);
      const mark = calls(id).length;
      send(id, "S4 what was the balance?");
      await settle(state);
      const next = calls(id).slice(mark)[0];
      const seen = (next?.body?.messages ?? []).some((message) =>
        textOf(message.content)
          .replace(/\[\[tool:[^\]]*\]\]/g, "")
          .replace(/«[^»]*»/g, "")
          .includes("4321.09"),
      );
      return { pass: seen, observed: seen ? "next run saw 4321.09" : "next run never saw 4321.09" };
    },
  },
  {
    id: "S5",
    title: "A reply that promises more work is followed by that work or a durable follow-up",
    async run({ id, state }) {
      const scratchBefore = Number(psql(state, "select count(*) from scratchpad_items"));
      const routinesBefore = Number(psql(state, "select count(*) from routines"));
      const mark = calls(id).length;
      send(id, "[[promise]] S5 analyze my spending");
      await settle(state);
      const after = calls(id).slice(mark).length;
      const scratch = Number(psql(state, "select count(*) from scratchpad_items")) - scratchBefore;
      const routines = Number(psql(state, "select count(*) from routines")) - routinesBefore;
      return {
        pass: after > 1 || scratch > 0 || routines > 0,
        observed: `${after} model call(s), +${scratch} scratchpad, +${routines} routines`,
      };
    },
  },
  {
    id: "S12",
    title: "A multi-step run that stops before the request is finished goes on to finish it",
    async run({ id, state }) {
      const mark = calls(id).length;
      send(id, "[[quit:5]] S12 collect my policies");
      await settle(state);
      const reply = psql(
        state,
        `select string_agg(m.blocks::text, ' ' order by m.seq) from messages m where m.role = 'bot' and m."runId" = (select r.id from runs r join messages u on r."sourceMessageId" = u.id where u.blocks::text like '%S12 collect%' order by u.seq desc limit 1)`,
      );
      const after = calls(id).slice(mark).length;
      const finished = reply.includes("Remaining policy collected");
      const leaked = /\bDONE\b/.test(reply);
      return {
        pass: finished && !leaked,
        observed: `${after} model call(s); ${finished ? "remaining work done" : "stopped after the early reply"}${leaked ? "; DONE shown to the user" : ""}`,
      };
    },
  },
  {
    id: "S6",
    title: "A credential pasted in chat is not re-sent to the model on later turns",
    async run({ id, state }) {
      send(
        id,
        '[[tool:secure_pasted_secret:{"value":"zx81qa","name":"bank-user-code","auth":{"type":"command"}}]] S6 the bank user code is zx81qa',
      );
      await settle(state);
      const mark = calls(id).length;
      send(id, "S6 continue");
      await settle(state);
      const leaked = calls(id)
        .slice(mark)
        .filter((call) => serialize(call.body).includes("zx81qa")).length;
      return { pass: leaked === 0, observed: `${leaked} later model call(s) contained the code` };
    },
  },
  {
    id: "S7",
    title: "Consecutive runs share a cacheable prompt prefix",
    async run({ id, state }) {
      const mark = calls(id).length;
      send(id, "S7 first");
      await settle(state);
      const middle = calls(id).length;
      send(id, "S7 second");
      await settle(state);
      const prefix = messagePrefix(calls(id)[mark]?.body, calls(id)[middle]?.body);
      return {
        pass: prefix.tools && prefix.breakAt === "latest turn",
        observed: `tools ${prefix.tools ? "unchanged" : "changed"}; ${(prefix.ratio * 100).toFixed(1)}% of earlier messages reused; first change at ${prefix.breakAt}`,
      };
    },
  },
  {
    id: "S9",
    title: "Saving a memory note does not break the next run's cacheable prefix",
    async run({ id, state }) {
      const mark = calls(id).length;
      send(id, '[[tool:remember:{"content":"S9 prefers metric units"}]] S9 note this');
      await settle(state);
      const middle = calls(id).length;
      send(id, "S9 next");
      await settle(state);
      const prefix = messagePrefix(calls(id)[mark]?.body, calls(id)[middle]?.body);
      return {
        pass: prefix.tools && prefix.breakAt === "latest turn",
        observed: `tools ${prefix.tools ? "unchanged" : "changed"}; ${(prefix.ratio * 100).toFixed(1)}% of earlier messages reused; first change at ${prefix.breakAt}`,
      };
    },
  },
  {
    id: "S3",
    title: "A chat reply to a pending takeover keeps the browser and arrives as the user's message",
    async run({ id, state }) {
      send(id, '[[tool:request_takeover:{"reason":"S3 enter the user code on the page"}]]');
      const waiting = await waitFor(
        () =>
          Number(psql(state, "select count(*) from runs where status = 'waiting_takeover'")) > 0,
        30_000,
      );
      const mark = calls(id).length;
      send(id, "S3 the code is 1234");
      await waitFor(() => calls(id).length > mark, 30_000);
      await settle(state, 30_000);
      const next = calls(id).slice(mark)[0];
      const tools = next?.tools ?? [];
      const browser = tools.includes("browser_act");
      const users = (next?.body?.messages ?? []).filter((message) => message.role === "user");
      const own = users.some((message) => textOf(message.content).trim() === "S3 the code is 1234");
      return {
        pass: waiting && browser && own,
        observed: `takeover ${waiting ? "pending" : "never pending"}; browser_act ${browser ? "offered" : "missing"}; reply ${own ? "sent as its own user message" : "folded into another message"}`,
      };
    },
  },
  {
    id: "S10",
    title: "A rarely used tool stays reachable while its schema is left out of every call",
    async run({ id, state }) {
      const mark = calls(id).length;
      send(id, '[[tool:use_tool:{"name":"schedule_list","args":{}}]] S10 list my routines');
      await settle(state);
      const after = calls(id).slice(mark);
      const names = after[0]?.tools ?? [];
      const schemaChars = JSON.stringify(after[0]?.body?.tools ?? []).length;
      const result = (after[1]?.body?.messages ?? []).findLast((message) => message.role === "tool");
      const resultText = textOf(result?.content) || JSON.stringify(result?.content ?? "");
      const deferred =
        names.includes("find_tools") &&
        names.includes("use_tool") &&
        !names.includes("schedule_create") &&
        !names.includes("schedule_list");
      const ran = Boolean(result) && !/"error"/.test(resultText);
      return {
        pass: deferred && ran,
        observed: `${names.length} tools, ${schemaChars} schema chars; schedule tools ${deferred ? "deferred" : "sent"}; use_tool ${ran ? "ran schedule_list" : `failed: ${resultText.slice(0, 120)}`}`,
      };
    },
  },
  {
    id: "S11",
    title: "An owner message sent during a routine is answered before the routine finishes",
    async run({ id, state }) {
      send(
        id,
        '[[tool:schedule_create:{"name":"S11 watch","prompt":"S11 routine [[slow-tool:12]]","delaySeconds":5}]] S11 set up the watch',
      );
      await settle(state);
      let routineRun = "";
      await waitFor(() => {
        routineRun = psql(
          state,
          `select id from runs where trigger='routine' and status in ('leased','running') order by "createdAt" desc limit 1`,
        );
        return Boolean(routineRun);
      }, 60_000);
      if (!routineRun) return { pass: false, observed: "routine never started" };
      await sleep(3000);
      send(id, "S11 owner question");
      await settle(state, 120_000);
      const [ownerAt, routineAt] = ["user", "routine"].map((trigger) =>
        psql(
          state,
          `select extract(epoch from m."createdAt") from messages m join runs r on r.id = m."runId" where m.role = 'bot' and r.trigger = '${trigger}' order by m."createdAt" desc limit 1`,
        ),
      );
      const routine = psql(
        state,
        `select r.status || ' ' || coalesce((select string_agg(a.status, ',' order by a."startedAt") from attempts a where a."runId" = r.id), '') from runs r where r.id = '${routineRun}'`,
      );
      const ownerFirst = Boolean(ownerAt && routineAt) && Number(ownerAt) < Number(routineAt);
      return {
        pass: ownerFirst && routine.startsWith("completed") && routine.includes("yielded"),
        observed: `owner reply ${ownerFirst ? "before" : "not before"} routine reply; routine ${routine}`,
      };
    },
  },
  {
    id: "S8",
    title: "The tool list stays identical across every call in the trial",
    async run({ id }) {
      const lists = new Set(
        calls(id)
          .filter((call) => Array.isArray(call.tools) && call.tools.length > 0)
          .map((call) => call.tools.join(",")),
      );
      return { pass: lists.size === 1, observed: `${lists.size} distinct tool list(s)` };
    },
  },
];

const results = [];
for (let trial = 1; trial <= trials; trial += 1) {
  const id = `eval-${Date.now()}-t${trial}`;
  ctl(id, "up");
  ctl(id, "onboard");
  const state = stateOf(id);
  for (const scenario of scenarios) {
    if (only && !only.has(scenario.id)) continue;
    let result;
    try {
      result = await scenario.run({ id, state });
    } catch (error) {
      result = { pass: false, observed: `harness error: ${error.message.split("\n")[0]}` };
    }
    results.push({ trial, id: scenario.id, title: scenario.title, ...result });
    console.log(`${trial} ${scenario.id} ${result.pass ? "PASS" : "FAIL"} ${result.observed}`);
  }
  writeFileSync(
    path.join(bundle, `trial-${trial}-fixture-log.json`),
    JSON.stringify(
      calls(id).map(({ body, ...call }) => call),
      null,
      2,
    ),
  );
  if (!values.keep) ctl(id, "down");
}

const byScenario = new Map();
for (const result of results) {
  const entry = byScenario.get(result.id) ?? {
    title: result.title,
    passes: 0,
    runs: 0,
    observed: [],
  };
  entry.runs += 1;
  if (result.pass) entry.passes += 1;
  entry.observed.push(result.observed);
  byScenario.set(result.id, entry);
}
const rows = [...byScenario.entries()].map(
  ([scenario, entry]) =>
    `| ${scenario} | ${entry.title} | ${entry.passes}/${entry.runs} | ${entry.passes === entry.runs ? "pass" : "fail"} | ${[...new Set(entry.observed)].join("; ")} |`,
);
writeFileSync(path.join(bundle, "scorecard.json"), JSON.stringify(results, null, 2));
writeFileSync(
  path.join(bundle, "scorecard.md"),
  `| Scenario | Expectation | Passed | pass^${trials} | Observed |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`,
);
console.log(readFileSync(path.join(bundle, "scorecard.md"), "utf8"));
