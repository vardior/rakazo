import { describe, expect, it } from "vitest";
import { commitsToUnfinishedWork, describeToolActivity } from "./pi-runtime.js";

describe("commitsToUnfinishedWork", () => {
  it.each([
    "I'm continuing with the analysis now and will report back shortly.",
    "I'm back on it now… The older-history retrieval and monthly income/outflow calculation aren't finished yet",
    "I'm continuing with the transaction history and will exclude investment transfers",
    "I'm collecting the available account data",
    "I'll report back with the monthly totals.",
    "I'll get back to you with the results shortly.",
    "I'm now retrieving the older transactions.",
    "I'm working on it.",
    "Working on it now.",
    "I’m still working on the income and outflow calculation.",
    "I am continuing the investigation.",
    "I will continue with the remaining files.",
    "I'll keep working on the analysis.",
    "I'll calculate the monthly totals next.",
    "I'm currently reviewing the available statements.",
    "The first page is loaded. I'll retrieve the older history next.",
    "I have the statements.\nI'm gathering the missing transactions now.",
    "I'LL REPORT BACK SHORTLY.",
  ])("detects an English-only unfinished-work commitment: %s", (text) => {
    expect(commitsToUnfinishedWork(text)).toBe(true);
  });

  it.each([
    "Your monthly income is 4,200 and your outflow is 3,100, excluding investment transfers.",
    "I've retrieved the full transaction history and finished the calculation.",
    "I finished the analysis. Here are the results.",
    "I continued the analysis and found two duplicate transactions.",
    "I reported back with the totals in the previous message.",
    "Which month should I analyze?",
    "I'm continuing with the analysis. Which accounts should I include?",
    "I'll wait for your answer.",
    "I'm waiting for your confirmation before continuing.",
    "Once you sign in I'll retrieve the older history.",
    "I'll continue once you sign in.",
    "After you upload the statements, I'll calculate the totals.",
    "I'll report back when you provide the missing account data.",
    "If you approve, I'll continue the analysis.",
    "I'll continue after your confirmation.",
    "I'll retrieve the history, but I need you to sign in first.",
    "I'll report back, but I need your answer before proceeding.",
    "I'll continue, but approval is pending and I'm awaiting permission.",
    "I can't access the account. I'll report back after authentication.",
    "I'm not continuing until the account is connected.",
    "The bank is working on it.",
    "You can continue with the transaction history.",
    'The earlier reply was "I\'m continuing with the analysis now."',
    '"I\'m continuing with the analysis now."',
    "`I'll report back shortly.` is the example string.",
    "```text\nI'm continuing with the analysis now.\n```",
    "> I'll report back shortly.\nThat was the earlier reply.",
    "",
    "Je continue l'analyse et je reviendrai avec les résultats.",
  ])("leaves completed, quoted, non-English or user-blocked replies alone: %s", (text) => {
    expect(commitsToUnfinishedWork(text)).toBe(false);
  });
});

describe("describeToolActivity", () => {
  it("summarizes builtin tools with their most informative argument", () => {
    expect(describeToolActivity("shell", { command: "pnpm test --filter web" })).toBe(
      "Running: pnpm test --filter web",
    );
    expect(describeToolActivity("read_file", { path: "notes/plan.md" })).toBe(
      "Reading notes/plan.md",
    );
    expect(describeToolActivity("write_file", { path: "out.csv", content: "…" })).toBe(
      "Writing out.csv",
    );
    expect(describeToolActivity("render_plot", { spec: {} })).toBe("Rendering a chart");
    expect(describeToolActivity("add_mcp_server", { name: "Linear" })).toBe(
      "Connecting MCP server: Linear",
    );
    expect(describeToolActivity("run_subagent", { name: "scout", task: "…" })).toBe(
      "Delegating to helper: scout",
    );
    expect(describeToolActivity("create_space", { name: "Customer support" })).toBe(
      "Creating space: Customer support",
    );
    expect(describeToolActivity("web_search", { query: "rakazo agents" })).toBe(
      "Searching the web: rakazo agents",
    );
    expect(describeToolActivity("web_fetch", { url: "https://example.com" })).toBe(
      "Reading page: https://example.com/",
    );
  });

  it("names MCP server and remote tool", () => {
    expect(describeToolActivity("mcp__brex__list_expenses", {})).toBe("Using brex: list_expenses");
    expect(describeToolActivity("mcp__demo-oauth__greet", {})).toBe("Using demo-oauth: greet");
  });

  it("truncates long details and collapses whitespace", () => {
    const long = `x${"y".repeat(200)}`;
    const line = describeToolActivity("shell", { command: `a\n\t${long}` });
    expect(line.length).toBeLessThanOrEqual("Running: ".length + 91);
    expect(line).toContain("…");
    expect(line).not.toContain("\n");
    expect(line).toMatch(/^Running: a x/);
  });

  it("redacts credentials from activity details", () => {
    const token = "fake-token";
    const line = describeToolActivity("shell", {
      command: `curl -H 'Authorization: Bearer ${token}' https://example.test?api_key=fake-key password=fake-password`,
    });

    expect(line).toContain("Bearer [redacted]");
    expect(line).toContain("api_key=[redacted]");
    expect(line).not.toContain(token);
    expect(line).not.toContain("fake-key");
    expect(line).not.toContain("fake-password");
  });

  it("strips signed-URL query and fragment from web_fetch activity", () => {
    const line = describeToolActivity("web_fetch", {
      url: "https://user:secret@cdn.example.test/doc.pdf?X-Amz-Signature=abc123&token=leak#frag",
    });
    expect(line).toBe("Reading page: https://cdn.example.test/doc.pdf");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("X-Amz-Signature");
    expect(line).not.toContain("token=");
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("frag");
  });

  it("does not echo secrets from malformed web_fetch URLs", () => {
    const line = describeToolActivity("web_fetch", {
      url: "https://user:secret@[",
    });
    expect(line).toBe("Reading page: [invalid URL]");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("user:");
  });

  it("falls back to the tool name", () => {
    expect(describeToolActivity("destination_write", undefined)).toBe("Using destination_write");
  });
});
