#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const port = Number(process.env.BROWSER_DAEMON_PORT);
const webUrl = process.env.WEB_URL;
const repoRoot = process.env.REPO_ROOT;
const require = createRequire(path.join(repoRoot, "apps/web/package.json"));
const { chromium } = require("@playwright/test");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

function locatorFrom(values) {
  const exact = Boolean(values.exact);
  let locator;
  if (values.role)
    locator = page.getByRole(values.role, values.name ? { name: values.name, exact } : {});
  else if (values.testid) locator = page.getByTestId(values.testid);
  else if (values.placeholder) locator = page.getByPlaceholder(values.placeholder, { exact });
  else if (values.label) locator = page.getByLabel(values.label, { exact });
  else if (values.text) locator = page.getByText(values.text, { exact });
  else if (values.css) locator = page.locator(values.css);
  else return null;
  return values.nth === undefined ? locator.first() : locator.nth(Number(values.nth));
}

class UsageError extends Error {}

function requiredLocator(values, action) {
  const locator = locatorFrom(values);
  if (!locator)
    throw new UsageError(
      `${action} needs a locator: --role/--name, --testid, --placeholder, --label, --text or --css`,
    );
  return locator;
}

async function writeArtifact(file, write) {
  const resolved = path.resolve(file);
  mkdirSync(path.dirname(resolved), { recursive: true });
  await write(resolved);
  return resolved;
}

async function run({ action, positional = [], values = {} }) {
  const timeout = Number(values.timeout ?? 15_000);
  switch (action) {
    case "open":
      await page.goto(new URL(positional[0] ?? "/", webUrl).toString(), {
        timeout: Number(values.timeout ?? 90_000),
        waitUntil: "domcontentloaded",
      });
      return { url: page.url() };
    case "click":
      await requiredLocator(values, action).click({ timeout });
      return { clicked: true, url: page.url() };
    case "fill":
      if (values.value === undefined) throw new UsageError("fill needs --value");
      await requiredLocator(values, action).fill(values.value, { timeout });
      return { filled: true };
    case "press": {
      const key = positional[0];
      if (!key) throw new UsageError("press needs a key, for example: browser press Enter");
      const locator = locatorFrom(values);
      if (locator) await locator.press(key, { timeout });
      else await page.keyboard.press(key);
      return { pressed: key };
    }
    case "wait": {
      const state = values.state ?? "visible";
      await requiredLocator(values, action).waitFor({ state, timeout });
      return { waited: state };
    }
    case "text":
      return { text: await (locatorFrom(values) ?? page.locator("body")).innerText({ timeout }) };
    case "snapshot": {
      const snapshot = await page.locator("body").ariaSnapshot({ timeout });
      if (!values.path) return { url: page.url(), snapshot };
      const file = await writeArtifact(values.path, (resolved) =>
        writeFileSync(resolved, `${snapshot}\n`),
      );
      return { path: file, url: page.url() };
    }
    case "screenshot": {
      if (!values.path) throw new UsageError("screenshot needs --path");
      const file = await writeArtifact(values.path, (resolved) =>
        page.screenshot({ path: resolved, fullPage: true, animations: "disabled" }),
      );
      return { path: file, url: page.url() };
    }
    case "url":
      return { url: page.url() };
    default:
      throw new UsageError(`unknown browser action ${action}`);
  }
}

let queue = Promise.resolve();

createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const command = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const result = queue.then(() => run(command));
  queue = result.catch(() => undefined);
  try {
    const value = await result;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, value }));
  } catch (error) {
    response.writeHead(error instanceof UsageError ? 400 : 500, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ ok: false, error: error.message.split("\n")[0] }));
  }
}).listen(port, "127.0.0.1", () => console.log(`browser daemon listening on ${port}`));

const shutdown = () => browser.close().finally(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
