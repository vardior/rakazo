#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(skillDir, "../../..");
const runsRoot = path.join(repoRoot, ".verify-runs");
const evidenceRoot = path.join(skillDir, "evidence");
const fixtureModelId = "verify-fixture";
const postgresImage = "postgres:16-alpine";

const TEST_SECRETS = {
  BETTER_AUTH_SECRET: "verify-secret-verify-secret-32chars!",
  ENCRYPTION_KEY: "verify-encryption-key-verify-encryption-key",
  SANDBOX_SUPERVISOR_TOKEN: "verify-supervisor-token-verify-32chars",
  SCREEN_PROXY_SECRET: "verify-screen-proxy-secret-verify-32chars",
};

const CHECKOUT_ENV_TO_BLANK =
  /(KEY|TOKEN|SECRET|PASSWORD|CLIENT_ID|PROJECT_ID|PHONE_NUMBER|APP_ID|_URL|POSTHOG|AXIOM|SMTP|SIGNUP_ALLOWLIST)/;

const USAGE = `control-rakazo: drive an isolated Rakazo stack for verification.

Stack
  up [--model fixture|env] [--context-window N] [--id ID]
                                       start Postgres, API, worker, web, fixture model, browser;
                                       N is the fixture model's declared window (default 200000)
  doctor [--id ID]                     read-only health of a run (exit 1 when unhealthy)
  down [--id ID] [--dry-run]           stop everything the run started and delete its scratch state
  list                                 runs under .verify-runs/
  logs <api|worker|web|fixture|browser> [--lines N] [--id ID]
  fixture-log [--id ID]                every model request: plan, new user messages, reply
  onboard [--value EMAIL] [--id ID]    sign up, connect the model, skip integrations, land in Chief's chat (UI path)

Browser (one headless Playwright page per run, held by a daemon)
  browser open <path-or-url>
  browser click   <locator>
  browser fill    <locator> --value TEXT
  browser press   <key> [<locator>]
  browser wait    <locator> [--state visible|hidden] [--timeout MS]
  browser text    [<locator>]
  browser snapshot   [--path FILE]      ARIA snapshot of the page
  browser screenshot  --path FILE
  browser url
  <locator> is one of: --role R --name N | --testid ID | --placeholder P | --label L | --text T | --css S
           plus optional --exact and --nth N

Evidence
  evidence new <slug>                       create evidence/<stamp>-<slug>/EVIDENCE.md and print its path
  evidence index <bundle-dir> --verdict pass|fail|partial [--prs LIST]

Every command prints JSON. --id defaults to the only live run.`;

function out(value) {
  console.log(JSON.stringify(value, null, 2));
}

function fail(message, hint) {
  console.error(JSON.stringify({ error: message, ...(hint ? { hint } : {}) }, null, 2));
  process.exit(1);
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function checkoutInfo() {
  return {
    sha: git(["rev-parse", "HEAD"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: git(["status", "--porcelain"]) !== "",
  };
}

function localUrl(port) {
  return `http://127.0.0.1:${port}`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listenerPids(port) {
  try {
    return execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function processGroup(pid) {
  try {
    return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }));
  } catch {
    return null;
  }
}

async function servesOk(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.status === 200;
  } catch {
    return false;
  }
}

function apiHealthUrl(state) {
  return `${localUrl(state.ports.api)}/health`;
}

function fixtureModelsUrl(state) {
  return `${localUrl(state.ports.fixture)}/v1/models`;
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs / 1000}s`);
}

function runDir(id) {
  return path.join(runsRoot, id);
}

function readState(id) {
  const file = path.join(runDir(id), "state.json");
  if (!existsSync(file)) fail(`no run ${id}`, "Run `control-rakazo list` to see runs.");
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeState(state) {
  writeFileSync(path.join(runDir(state.id), "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

function runIds() {
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot).filter((id) => existsSync(path.join(runDir(id), "state.json")));
}

function isLive(state) {
  return Object.values(state.processes).some((proc) => alive(proc.pid));
}

function resolveId(id) {
  if (id) return id;
  const live = runIds().filter((candidate) => isLive(readState(candidate)));
  if (live.length === 1) return live[0];
  if (live.length === 0) fail("no live run", "Start one with `control-rakazo up`.");
  fail(`several live runs: ${live.join(", ")}`, "Pass --id.");
}

function checkoutEnvNames() {
  const file = path.join(repoRoot, ".env");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1])
    .filter(Boolean);
}

function stackEnv(state) {
  const base = {
    NODE_ENV: "development",
    DATABASE_URL: state.databaseUrl,
    REALTIME_DATABASE_URL: state.databaseUrl,
    API_PORT: String(state.ports.api),
    API_HOST: "127.0.0.1",
    API_URL: localUrl(state.ports.api),
    API_PROXY_TARGET: localUrl(state.ports.api),
    WEB_PORT: String(state.ports.web),
    WEB_ORIGIN: state.webUrl,
    BETTER_AUTH_URL: state.webUrl,
    SIGNUPS_ENABLED: "true",
    SIGNUP_ALLOWLIST: "",
    SECRET_STORE: "encrypted",
    DATA_DIR: path.join(runDir(state.id), "data"),
    SANDBOX_PROVIDER: "fake",
    CLOUD_AGENT_PROVIDER: "emulator",
    AGENT_RUNTIME: "pi",
    WAKEUP_DRIVER: "graphile",
    TICKET_BOARD_ENABLED: "true",
    LOG_FORMAT: "pretty",
    ...TEST_SECRETS,
  };
  if (state.model !== "fixture") return { ...process.env, ...base };
  const blanked = Object.fromEntries(
    checkoutEnvNames()
      .filter((name) => CHECKOUT_ENV_TO_BLANK.test(name) && !(name in base))
      .map((name) => [name, ""]),
  );
  return {
    ...process.env,
    ...blanked,
    ...base,
    RAKAZO_LOCAL_MODELS: fixtureModelId,
    RAKAZO_LOCAL_MODELS_URL: `${localUrl(state.ports.fixture)}/v1`,
    PI_DEFAULT_PROVIDER: "local",
    PI_DEFAULT_MODEL: fixtureModelId,
    RAKAZO_LOCAL_CONTEXT_WINDOW: String(state.contextWindow),
    RAKAZO_LOCAL_MAX_TOKENS: "8192",
  };
}

function launch(state, name, command, args, cwd, env) {
  const log = path.join(runDir(state.id), `${name}.log`);
  const fd = openSync(log, "a");
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  state.processes[name] = { pid: child.pid, log };
  writeState(state);
}

async function browserRequest(state, command) {
  try {
    const response = await fetch(`${localUrl(state.ports.browser)}/`, {
      method: "POST",
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(Number(command.values?.timeout ?? 15_000) + 120_000),
    });
    return await response.json();
  } catch (error) {
    return { ok: false, error: `browser daemon unreachable: ${error.message}` };
  }
}

async function up(values) {
  const id = values.id ?? stamp();
  const model = values.model ?? "fixture";
  if (!["fixture", "env"].includes(model)) fail(`unknown model ${model}`, "Use fixture or env.");
  if (existsSync(runDir(id))) fail(`run ${id} already exists`, "Pick another --id or run down.");
  if (!existsSync(path.join(repoRoot, "node_modules")))
    fail("dependencies missing", "Run `pnpm install && pnpm db:generate` in the checkout first.");
  mkdirSync(path.join(runDir(id), "data"), { recursive: true });
  const ports = {
    postgres: await freePort(),
    api: await freePort(),
    web: await freePort(),
    fixture: await freePort(),
    browser: await freePort(),
  };
  const state = {
    id,
    model,
    contextWindow: Number(values["context-window"] ?? 200_000),
    checkout: repoRoot,
    ...checkoutInfo(),
    startedAt: new Date().toISOString(),
    ports,
    webUrl: localUrl(ports.web),
    postgresContainer: `rakazo-verify-${id}-pg`,
    databaseUrl: `postgresql://rakazo:verify@127.0.0.1:${ports.postgres}/rakazo`,
    fixtureLog: path.join(runDir(id), "fixture-requests.jsonl"),
    processes: {},
  };
  writeState(state);

  execFileSync("docker", [
    "run",
    "-d",
    "--name",
    state.postgresContainer,
    "--label",
    `rakazo.verify=${id}`,
    "-e",
    "POSTGRES_USER=rakazo",
    "-e",
    "POSTGRES_PASSWORD=verify",
    "-e",
    "POSTGRES_DB=rakazo",
    "-p",
    `127.0.0.1:${ports.postgres}:5432`,
    postgresImage,
  ]);
  await waitFor(
    () => {
      try {
        execFileSync("docker", ["exec", state.postgresContainer, "pg_isready", "-U", "rakazo"], {
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    },
    60_000,
    "postgres",
  );
  const env = stackEnv(state);
  const migrateLog = openSync(path.join(runDir(id), "migrate.log"), "a");
  execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", migrateLog, migrateLog],
  });

  if (model === "fixture") {
    launch(
      state,
      "fixture",
      process.execPath,
      [path.join(skillDir, "bin/fixture-model.mjs")],
      repoRoot,
      {
        ...process.env,
        FIXTURE_PORT: String(ports.fixture),
        FIXTURE_LOG: state.fixtureLog,
        FIXTURE_MODEL_ID: fixtureModelId,
      },
    );
  }
  launch(state, "api", "pnpm", ["start"], path.join(repoRoot, "apps/api"), env);
  launch(state, "worker", "pnpm", ["start"], path.join(repoRoot, "apps/worker"), env);
  launch(state, "web", "pnpm", ["exec", "vite"], path.join(repoRoot, "apps/web"), env);
  launch(
    state,
    "browser",
    process.execPath,
    [path.join(skillDir, "bin/browser-daemon.mjs")],
    repoRoot,
    {
      ...process.env,
      BROWSER_DAEMON_PORT: String(ports.browser),
      WEB_URL: state.webUrl,
      REPO_ROOT: repoRoot,
    },
  );

  try {
    if (model === "fixture")
      await waitFor(() => servesOk(fixtureModelsUrl(state)), 30_000, "fixture model");
    await waitFor(() => servesOk(apiHealthUrl(state)), 120_000, "api");
    await waitFor(() => servesOk(state.webUrl), 120_000, "web");
    await waitFor(
      async () => (await browserRequest(state, { action: "url" })).ok,
      30_000,
      "browser",
    );
    await waitFor(
      () => readFileSync(state.processes.worker.log, "utf8").includes("worker ready"),
      120_000,
      "worker",
    );
    const warm = await browserRequest(state, {
      action: "open",
      positional: ["/sign-in"],
      values: { timeout: "120000" },
    });
    if (!warm.ok) throw new Error(`first page load failed: ${warm.error}`);
  } catch (error) {
    fail(error.message, `Read logs with \`control-rakazo logs <name> --id ${id}\`, then run down.`);
  }
  out({ ready: true, ...summary(state) });
}

function summary(state) {
  return {
    id: state.id,
    model: state.model,
    webUrl: state.webUrl,
    apiUrl: localUrl(state.ports.api),
    sha: state.sha,
    branch: state.branch,
    dirty: state.dirty,
  };
}

async function doctor(values) {
  const state = readState(resolveId(values.id));
  const checks = {};
  for (const [name, proc] of Object.entries(state.processes))
    checks[`${name}Alive`] = alive(proc.pid);
  const ownsPort = (port, name) => {
    const group = processGroup(state.processes[name]?.pid);
    return listenerPids(port).some((pid) => group !== null && processGroup(pid) === group);
  };
  checks.apiPortOwned = ownsPort(state.ports.api, "api");
  checks.webPortOwned = ownsPort(state.ports.web, "web");
  checks.apiHealth = await servesOk(apiHealthUrl(state));
  checks.webServes = await servesOk(state.webUrl);
  checks.browserDaemon = (await browserRequest(state, { action: "url" })).ok;
  if (state.model === "fixture") checks.fixtureModel = await servesOk(fixtureModelsUrl(state));
  try {
    checks.postgresRunning =
      execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", state.postgresContainer], {
        encoding: "utf8",
      }).trim() === "true";
  } catch {
    checks.postgresRunning = false;
  }
  const currentSha = git(["rev-parse", "HEAD"]);
  checks.checkoutUnchanged = currentSha === state.sha;
  const healthy = Object.values(checks).every(Boolean);
  out({ healthy, ...summary(state), currentSha, checks });
  if (!healthy) process.exit(1);
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {}
}

function down(values) {
  const id = resolveId(values.id);
  const state = readState(id);
  const plan = {
    killProcessGroups: Object.fromEntries(
      Object.entries(state.processes)
        .filter(([, proc]) => alive(proc.pid))
        .map(([name, proc]) => [name, proc.pid]),
    ),
    removeContainer: state.postgresContainer,
    deleteScratch: runDir(id),
    keepEvidence: evidenceRoot,
  };
  if (values["dry-run"]) {
    out({ dryRun: true, ...plan });
    return;
  }
  const pids = Object.values(plan.killProcessGroups);
  for (const pid of pids) killGroup(pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && pids.some(alive)) {
    execFileSync("sleep", ["0.5"]);
  }
  for (const pid of pids.filter(alive)) killGroup(pid, "SIGKILL");
  try {
    execFileSync("docker", ["rm", "-f", state.postgresContainer], { stdio: "ignore" });
  } catch {}
  rmSync(runDir(id), { recursive: true, force: true });
  out({ down: true, ...plan });
}

function list() {
  out(
    runIds().map((id) => {
      const state = readState(id);
      return { ...summary(state), live: isLive(state) };
    }),
  );
}

function logs(name, values) {
  const state = readState(resolveId(values.id));
  const proc = state.processes[name];
  if (!proc) fail(`no ${name} log`, `Use one of: ${Object.keys(state.processes).join(", ")}.`);
  const lines = readFileSync(proc.log, "utf8").split("\n");
  console.log(lines.slice(-Number(values.lines ?? 60)).join("\n"));
}

function fixtureLog(values) {
  const state = readState(resolveId(values.id));
  if (!existsSync(state.fixtureLog)) {
    out([]);
    return;
  }
  out(
    readFileSync(state.fixtureLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
}

async function browserCommand(action, positional, values) {
  const state = readState(resolveId(values.id));
  const result = await browserRequest(state, { action, positional, values });
  if (!result.ok)
    fail(result.error, "Run `browser snapshot` to see what the page offers, or raise --timeout.");
  if (action === "snapshot" && result.value.snapshot !== undefined)
    console.log(result.value.snapshot);
  else out(result.value);
}

async function onboard(values) {
  const state = readState(resolveId(values.id));
  const email = values.value ?? `verify-${state.id}@example.test`;
  const steps = [
    { action: "open", positional: ["/sign-up"] },
    { action: "fill", values: { placeholder: "Your name", value: "Verify User" } },
    { action: "fill", values: { placeholder: "Your email address", value: email } },
    { action: "fill", values: { placeholder: "Password", value: "verify-password-123" } },
    { action: "click", values: { role: "button", name: "Create account" } },
    { action: "wait", values: { role: "heading", name: "Connect a model", timeout: "30000" } },
    { action: "fill", values: { role: "textbox", name: "API key", value: "verify-local-key" } },
    { action: "click", values: { role: "button", name: "Continue" } },
    { action: "wait", values: { role: "heading", name: "Server integrations", timeout: "30000" } },
    { action: "click", values: { role: "button", name: "Skip", exact: true } },
    { action: "wait", values: { placeholder: "Message Chief", timeout: "30000" } },
    { action: "wait", values: { text: "Chief is working", state: "hidden", timeout: "60000" } },
  ];
  for (const step of steps) {
    const result = await browserRequest(state, step);
    if (!result.ok)
      fail(
        `onboarding stopped at ${step.action}: ${result.error}`,
        "Run `browser snapshot` to see the screen.",
      );
  }
  const { value } = await browserRequest(state, { action: "url" });
  out({ onboarded: true, email, url: value.url });
}

function evidenceNew(slug) {
  if (!slug) fail("evidence new needs a slug", "Example: evidence new steering-final-turn");
  const bundle = path.join(evidenceRoot, `${stamp()}-${slug}`);
  mkdirSync(bundle, { recursive: true });
  const skillSha = git(["log", "-1", "--format=%H", "--", skillDir]) || "uncommitted";
  const { sha, branch, dirty } = checkoutInfo();
  const header = [
    `# Evidence: ${slug}`,
    "",
    `- Checkout: ${branch} @ ${sha}${dirty ? " (dirty)" : ""}`,
    `- Worktree: ${repoRoot}`,
    `- Harness (verify-rakazo) SHA: ${skillSha}`,
    `- Run id: `,
    "",
    "## Scenarios",
    "",
    "| Scenario | Driven | Observed | Evidence file |",
    "| --- | --- | --- | --- |",
    "",
    "## Negative probes",
    "",
    "## Caveats",
    "",
    "## For the PR",
    "",
  ].join("\n");
  writeFileSync(path.join(bundle, "EVIDENCE.md"), header);
  out({ bundle, evidence: path.join(bundle, "EVIDENCE.md") });
}

function evidenceIndex(bundle, values) {
  if (!bundle || !existsSync(path.join(bundle, "EVIDENCE.md")))
    fail(
      "evidence index needs an existing bundle directory",
      "Use the path printed by evidence new.",
    );
  if (!["pass", "fail", "partial"].includes(values.verdict))
    fail("evidence index needs --verdict pass|fail|partial");
  const name = path.basename(bundle);
  const line = `- ${new Date().toISOString().slice(0, 10)} · ${name} · ${git(["rev-parse", "--short", "HEAD"])} · PRs: ${values.prs ?? "none"} · ${values.verdict}\n`;
  const index = path.join(evidenceRoot, "INDEX.md");
  if (!existsSync(index)) writeFileSync(index, "# verify-rakazo evidence index\n\n");
  appendFileSync(index, line);
  out({ indexed: name, index });
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: "string" },
    model: { type: "string" },
    "context-window": { type: "string" },
    lines: { type: "string" },
    "dry-run": { type: "boolean" },
    role: { type: "string" },
    name: { type: "string" },
    testid: { type: "string" },
    placeholder: { type: "string" },
    label: { type: "string" },
    text: { type: "string" },
    css: { type: "string" },
    exact: { type: "boolean" },
    nth: { type: "string" },
    value: { type: "string" },
    state: { type: "string" },
    timeout: { type: "string" },
    path: { type: "string" },
    verdict: { type: "string" },
    prs: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...rest] = positionals;
if (!command || values.help) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}
switch (command) {
  case "up":
    await up(values);
    break;
  case "doctor":
    await doctor(values);
    break;
  case "down":
    down(values);
    break;
  case "list":
    list();
    break;
  case "logs":
    logs(rest[0], values);
    break;
  case "fixture-log":
    fixtureLog(values);
    break;
  case "onboard":
    await onboard(values);
    break;
  case "browser":
    await browserCommand(rest[0], rest.slice(1), values);
    break;
  case "evidence":
    if (rest[0] === "new") evidenceNew(rest[1]);
    else if (rest[0] === "index") evidenceIndex(rest[1], values);
    else fail(`unknown evidence action ${rest[0]}`, "Use evidence new or evidence index.");
    break;
  default:
    fail(`unknown command ${command}`, "Run control-rakazo --help.");
}
