import { describe, expect, it } from "vitest";
import { failedRunBlocks, failedRunRetryPrompt } from "./run-failure.js";

describe("failed run context", () => {
  it.each([
    [
      "Codex error: Our servers are currently overloaded. Please try again later.",
      "the model provider is unavailable",
    ],
    ["503 Service Unavailable", "the model provider is unavailable"],
    ["terminated", "the connection dropped"],
    ["WebSocket closed 1006", "the connection dropped"],
    ["Private internal error details", "something went wrong"],
  ])("uses a plain reason for %s without exposing the raw error", (error, reason) => {
    expect(failedRunBlocks("failed-run", error)).toEqual([
      {
        kind: "text",
        text: `I didn't finish because ${reason}.`,
        runFailure: { runId: "failed-run" },
      },
    ]);
  });

  it("distinguishes completed tools from calls whose side effects are unknown", () => {
    const prompt = failedRunRetryPrompt("Save the report", [
      {
        type: "agent.tool.called",
        payload: { executionId: "write", name: "write_file", target: "report.txt" },
      },
      {
        type: "agent.tool.completed",
        payload: {
          executionId: "write",
          name: "write_file",
          outcome: "succeeded",
          content: "private output",
        },
      },
      { type: "agent.tool.called", payload: { executionId: "send", name: "send_email" } },
    ]);
    expect(prompt).toContain("write_file — report.txt: succeeded");
    expect(prompt).toContain("send_email: outcome unknown");
    expect(prompt).toContain("Check current state before repeating any action with side effects.");
    expect(prompt).not.toContain("private output");
  });

  it("bounds repeated retry notes, retains whole recent entries, and carries earlier effects", () => {
    const request = "Repeat the request";
    let prompt = failedRunRetryPrompt(request, [
      {
        type: "agent.tool.called",
        payload: { name: "write_file", executionId: "first", target: "first.txt" },
      },
    ]);
    prompt = failedRunRetryPrompt(prompt, []);
    expect(prompt).toContain("write_file — first.txt: outcome unknown");
    for (let index = 0; index < 50; index++) {
      prompt = failedRunRetryPrompt(prompt, [
        {
          type: "agent.tool.called",
          payload: { name: `tool-${index}`, executionId: String(index), target: "x".repeat(500) },
        },
      ]);
    }
    expect(prompt.startsWith(request)).toBe(true);
    expect(prompt.length).toBeLessThan(request.length + 2450);
    expect(prompt.match(/<prior-attempts>/g)).toHaveLength(1);
    expect(prompt).toContain("tool-49 —");
    expect(prompt).toContain("Older tool activity omitted.");
    expect(prompt).not.toContain("tool-0 —");
    expect(prompt).toContain("Check current state before repeating any action with side effects.");
  });
});
