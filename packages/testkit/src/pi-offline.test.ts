import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { builtinAgentTools, PiAgentRuntime, selectBuiltinToolsForRun } from "@rakazo/adapters";
import * as Core from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findDeferredTools, splitDeferredTools } from "../../adapters/src/deferred-tools.js";
import { localProvider } from "../../adapters/src/pi-local-provider.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllEnvs();
});

const writeTool: ConnectorTool = {
  name: "write_file",
  description: "Save a UTF-8 file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  },
};

function runRequest(
  model: AgentRunRequest["model"],
  overrides: Partial<AgentRunRequest> = {},
): AgentRunRequest {
  return {
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId: randomUUID(),
    prompt: "Save hello to notes.txt.",
    instructions: "Complete the requested task.",
    history: [],
    tools: [writeTool],
    model,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<AgentRuntimeEvent>, events: AgentRuntimeEvent[] = []) {
  for await (const event of stream) events.push(event);
  return events;
}

function latestToolResult(request: ModelEmulatorRequest) {
  return request.messages.findLast((message) => message.role === "tool");
}

describe("real Pi against an offline model HTTP endpoint", () => {
  it("retries a dropped stream and an overloaded provider after tool work without replaying the effect", async () => {
    const delay = vi.spyOn(Core, "abortableDelay").mockResolvedValue(undefined);
    try {
      let retryMessages: ModelEmulatorRequest["messages"] | undefined;
      const assertRetryContext = (request: ModelEmulatorRequest) => {
        expect(latestToolResult(request)?.tool_call_id).toBe("retry-write");
        if (retryMessages) expect(request.messages).toEqual(retryMessages);
        else retryMessages = request.messages;
      };
      const server = await startModelEmulator({
        steps: [
          {
            expect() {},
            response: {
              type: "tool",
              id: "retry-write",
              name: "write_file",
              arguments: { path: "notes.txt", content: "hello" },
            },
          },
          { expect: assertRetryContext, response: { type: "disconnect" } },
          {
            expect: assertRetryContext,
            response: {
              type: "error",
              status: 503,
              message: "Codex error: Our servers are currently overloaded. Please try again later.",
            },
          },
          { expect: assertRetryContext, response: { type: "text", text: "Saved." } },
        ],
      });
      cleanups.push(() => server.close());
      const executeTool = vi.fn(async () => ({ ok: true }));
      const events = await collect(
        new PiAgentRuntime({
          modelCallObserver: {
            beforeCall: async () => "fixture-reservation",
            afterCall: async () => undefined,
          },
        }).run(runRequest(server.model, { executeTool })),
      ).catch((error) => {
        server.assertComplete();
        throw error;
      });
      server.assertComplete();
      expect(server.requests).toHaveLength(4);
      expect(executeTool).toHaveBeenCalledOnce();
      expect(events.filter((event) => event.type === "text")).toEqual([
        { type: "text", text: "Saved." },
      ]);
      expect(events.at(-1)).toEqual({ type: "done", text: "Saved." });
      expect(delay.mock.calls.map(([delayMs]) => delayMs)).toEqual([2_000, 8_000]);
    } finally {
      delay.mockRestore();
    }
  });

  it("preserves serialized page and screenshot prefixes between pruning batches", async () => {
    let previous: ModelEmulatorRequest["messages"] = [];
    const model = await startModelEmulator({
      steps: [
        ...Array.from({ length: 18 }, (_, count) => ({
          expect(request) {
            if (count > 0 && ![7, 10, 12, 17].includes(count)) {
              expect(JSON.stringify(request.messages.slice(0, previous.length))).toBe(
                JSON.stringify(previous),
              );
            }
            if (count === 10 || count === 17) {
              expect(
                request.messages.filter(
                  (message) =>
                    message.role === "tool" && String(message.content).includes("Page state"),
                ),
              ).toHaveLength(3);
            }
            previous = request.messages;
          },
          response:
            count < 17
              ? {
                  type: "tool" as const,
                  id: `snapshot-${count + 1}`,
                  name: "browser_snapshot",
                  arguments: {},
                }
              : { type: "text" as const, text: "Inspected." },
        })),
        { expect() {}, response: { type: "text", text: "DONE" } },
      ],
    });
    cleanups.push(() => model.close());
    let snapshot = 0;
    await collect(
      new PiAgentRuntime().run(
        runRequest(
          { ...model.model, acceptsImages: true, contextWindow: 1_000_000, maxTokens: 4096 },
          {
            prompt: "Inspect the pages.",
            contextStrategy: "current",
            tools: [
              {
                name: "browser_snapshot",
                description: "Inspect the page",
                inputSchema: { type: "object", properties: {} },
                readOnly: true,
              },
            ],
            executeTool: async () => ({
              kind: "agent_tool_result",
              content: [
                { type: "text", text: `Page state ${++snapshot}: ${"x".repeat(1_200)}` },
                { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
              ],
              details: { frameId: `frame-${snapshot}` },
            }),
          },
        ),
      ),
    ).catch((error) => {
      model.assertComplete();
      throw error;
    });
    model.assertComplete();
    expect(model.requests).toHaveLength(19);
  });

  it.each([
    "The monthly analysis is complete: income is 4,200 and outflow is 3,100.",
    "I'll report back with the totals shortly.",
    "I cannot retrieve the older history because the account connection has expired.",
  ])("keeps the streamed promise and appends one new assistant turn: %s", async (reply) => {
    const promise = "I'm continuing with the analysis now and will report back shortly.";
    const instruction =
      "You said you would continue. Do that work now with your tools, or tell the user plainly what is blocking you.";
    const events: AgentRuntimeEvent[] = [];
    const server = await startModelEmulator({
      steps: [
        { expect() {}, response: { type: "text", text: promise } },
        {
          expect(request) {
            expect(events.filter((event) => event.type === "text")).toEqual([
              { type: "text", text: promise },
            ]);
            expect(request.messages.filter((message) => message.role === "assistant")).toEqual([
              expect.objectContaining({ content: promise }),
            ]);
            expect(request.messages.at(-1)).toMatchObject({
              role: "user",
              content: instruction,
            });
          },
          response: { type: "text", text: reply },
        },
      ],
    });
    cleanups.push(() => server.close());
    await collect(
      new PiAgentRuntime().run(runRequest(server.model, { prompt: "Analyze the monthly totals." })),
      events,
    ).catch((error) => {
      server.assertComplete();
      throw error;
    });
    server.assertComplete();
    expect(server.requests).toHaveLength(2);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: promise },
      { type: "text", text: reply },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: promise + reply });
  });

  it("executes tools in the follow-up without renewing the allowance for a second promise", async () => {
    const promise = "I'm continuing with the analysis now.";
    const secondPromise = "I'll report back with the totals shortly.";
    const server = await startModelEmulator({
      steps: [
        { expect() {}, response: { type: "text", text: promise } },
        {
          expect(request) {
            expect(request.messages.at(-1)?.content).toContain("Do that work now with your tools");
          },
          response: {
            type: "tool",
            id: "follow-up-work",
            name: "write_file",
            arguments: { path: "notes.txt", content: "monthly totals" },
          },
        },
        {
          expect(request) {
            expect(latestToolResult(request)).toMatchObject({
              tool_call_id: "follow-up-work",
              content: JSON.stringify({ saved: true }),
            });
          },
          response: { type: "text", text: secondPromise },
        },
      ],
    });
    cleanups.push(() => server.close());
    const executeTool = vi.fn(async () => ({ saved: true }));
    const events = await collect(
      new PiAgentRuntime().run(runRequest(server.model, { executeTool })),
    ).catch((error) => {
      server.assertComplete();
      throw error;
    });
    server.assertComplete();
    expect(executeTool).toHaveBeenCalledExactlyOnceWith(
      "write_file",
      { path: "notes.txt", content: "monthly totals" },
      JSON.stringify(["pi-tool", "main", "follow-up-work"]),
      undefined,
      expect.any(Object),
    );
    expect(server.requests).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: "done", text: promise + secondPromise });
  });

  it.each([
    { reply: "The monthly analysis is complete.", allowSilentEmpty: false },
    { reply: "I'll wait for your answer.", allowSilentEmpty: false },
    { reply: "", allowSilentEmpty: true },
  ])(
    "does not follow up a completed, user-blocked or silent routine reply: $reply",
    async ({ reply, allowSilentEmpty }) => {
      const server = await startModelEmulator({
        steps: [{ expect() {}, response: { type: "text", text: reply } }],
      });
      cleanups.push(() => server.close());
      const events = await collect(
        new PiAgentRuntime().run(runRequest(server.model, { allowSilentEmpty })),
      );
      server.assertComplete();
      expect(server.requests).toHaveLength(1);
      expect(events.at(-1)).toEqual(reply ? { type: "done", text: reply } : { type: "done" });
    },
  );

  it.each([
    { name: "ask_user", args: { question: "Which account?", options: ["Checking", "Savings"] } },
    { name: "request_takeover", args: { reason: "Sign in to the account." } },
  ])("does not follow up a promise when $name pauses the run", async ({ name, args }) => {
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "pause-tool",
            name,
            arguments: args,
            assistantText: "I'm continuing with the analysis now and will report back shortly.",
          },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          tools: [
            {
              name,
              description: "Request user input",
              inputSchema: {
                type: "object",
                properties: {
                  question: { type: "string" },
                  options: { type: "array", items: { type: "string" } },
                  reason: { type: "string" },
                },
              },
            },
          ],
        }),
      ),
    );
    server.assertComplete();
    expect(server.requests).toHaveLength(1);
    expect(events.some((event) => event.type === (name === "ask_user" ? "ask" : "takeover"))).toBe(
      true,
    );
    expect(events.at(-1)?.type).toBe("done");
  });

  it("uses pending user steering instead of queuing a promise follow-up", async () => {
    const promise = "I'm collecting the available account data.";
    const steering = "Stop collecting data and summarize what is already available.";
    let claims = 0;
    const server = await startModelEmulator({
      steps: [
        { expect() {}, response: { type: "text", text: promise } },
        {
          expect(request) {
            expect(request.messages.at(-1)).toMatchObject({
              role: "user",
              content: steering,
            });
            expect(JSON.stringify(request.messages)).not.toContain("You said you would continue.");
          },
          response: { type: "text", text: "Only the current month's statement is available." },
        },
      ],
    });
    cleanups.push(() => server.close());
    await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          claimSteering: async () => {
            claims += 1;
            return claims === 2 ? [{ id: "steering-1", text: steering }] : [];
          },
        }),
      ),
    ).catch((error) => {
      server.assertComplete();
      throw error;
    });
    server.assertComplete();
    expect(server.requests).toHaveLength(2);
  });

  const completionCheck =
    "Check your last reply against the user's request. If part of the request is still unfinished and you can do it now, continue with your tools. If something blocks it and your last reply did not already say so, tell the user plainly what is left and why. Otherwise reply with exactly DONE.";
  const collectSteps = (prefix: string, count = 5) =>
    Array.from({ length: count }, (_, index) => ({
      expect() {},
      response: {
        type: "tool" as const,
        id: `${prefix}-${index}`,
        name: "write_file",
        arguments: { path: `${prefix}-${index}.txt`, content: "policy" },
      },
    }));
  const expectCompletionCheck = (request: ModelEmulatorRequest) =>
    expect(request.messages.at(-1)).toMatchObject({ role: "user", content: completionCheck });

  it.each([
    ["DONE", ""],
    [
      "One provider still returns a connection error, so its policy is not collected.",
      "\n\nOne provider still returns a connection error, so its policy is not collected.",
    ],
  ])(
    "asks a multi-step run once whether the request is finished: %s",
    async (checkReply, shown) => {
      const answer = "Two policies are saved.";
      const events: AgentRuntimeEvent[] = [];
      const server = await startModelEmulator({
        steps: [
          ...collectSteps("collect"),
          { expect() {}, response: { type: "text", text: answer } },
          {
            expect(request) {
              expectCompletionCheck(request);
              expect(events.filter((event) => event.type === "text")).toEqual([
                { type: "text", text: answer },
              ]);
            },
            response: { type: "text", text: checkReply },
          },
        ],
      });
      cleanups.push(() => server.close());
      await collect(
        new PiAgentRuntime().run(
          runRequest(server.model, { executeTool: vi.fn(async () => ({ saved: true })) }),
        ),
        events,
      ).catch((error) => {
        server.assertComplete();
        throw error;
      });
      server.assertComplete();
      expect(server.requests).toHaveLength(7);
      expect(
        events
          .filter((event) => event.type === "text")
          .map((event) => event.text)
          .join(""),
      ).toBe(answer + shown);
      expect(events.at(-1)).toEqual({ type: "done", text: answer + shown });
    },
  );

  it("continues the unfinished part of a multi-step run and checks again", async () => {
    const answer = "Understood, that provider is excluded.";
    const finished = "The remaining premiums are verified and saved.";
    const server = await startModelEmulator({
      steps: [
        ...collectSteps("collect"),
        { expect() {}, response: { type: "text", text: answer } },
        {
          expect: expectCompletionCheck,
          response: {
            type: "tool",
            id: "remaining-work",
            name: "write_file",
            arguments: { path: "premiums.txt", content: "premiums" },
          },
        },
        {
          expect(request) {
            expect(latestToolResult(request)).toMatchObject({ tool_call_id: "remaining-work" });
          },
          response: { type: "text", text: finished },
        },
        { expect: expectCompletionCheck, response: { type: "text", text: "DONE" } },
      ],
    });
    cleanups.push(() => server.close());
    const executeTool = vi.fn(async () => ({ saved: true }));
    const events = await collect(
      new PiAgentRuntime().run(runRequest(server.model, { executeTool })),
    ).catch((error) => {
      server.assertComplete();
      throw error;
    });
    server.assertComplete();
    expect(executeTool).toHaveBeenCalledTimes(6);
    expect(events.at(-1)).toEqual({ type: "done", text: answer + finished });
  });

  it("does not check a silent routine or a short tool run", async () => {
    for (const { steps, allowSilentEmpty } of [
      { steps: collectSteps("routine"), allowSilentEmpty: true },
      { steps: collectSteps("short", 4), allowSilentEmpty: false },
    ]) {
      const server = await startModelEmulator({
        steps: [...steps, { expect() {}, response: { type: "text", text: "Saved." } }],
      });
      cleanups.push(() => server.close());
      const events = await collect(
        new PiAgentRuntime().run(
          runRequest(server.model, {
            allowSilentEmpty,
            executeTool: vi.fn(async () => ({ saved: true })),
          }),
        ),
      );
      server.assertComplete();
      expect(server.requests).toHaveLength(steps.length + 1);
      expect(events.at(-1)).toEqual({ type: "done", text: "Saved." });
    }
  });

  it("does not follow up a promise after the last allowed tool call", async () => {
    vi.stubEnv("MAX_TOOL_CALLS_PER_TURN", "1");
    const promise = "I'll retrieve the older transactions next.";
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "last-allowed-tool",
            name: "write_file",
            arguments: { path: "notes.txt", content: "current totals" },
          },
        },
        { expect() {}, response: { type: "text", text: promise } },
      ],
    });
    cleanups.push(() => server.close());
    const executeTool = vi.fn(async () => ({ ok: true }));
    const events = await collect(
      new PiAgentRuntime().run(runRequest(server.model, { executeTool })),
    );
    server.assertComplete();
    expect(executeTool).toHaveBeenCalledOnce();
    expect(server.requests).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "done", text: promise });
  });

  it("fits the default local window with stable tool declarations and deferred validation", async () => {
    const split = splitDeferredTools(
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        pageBrowserAllowed: false,
        groupId: null,
        trigger: "user",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        historyRetrievalEnabled: true,
      }),
    );
    const args = { name: "Daily reminder", prompt: "Report the summary.", cron: "0 9 * * *" };
    const calls: string[] = [];
    const server = await startModelEmulator({
      steps: [
        {
          expect(request) {
            expect(request.tools?.map((tool) => tool.function.name)).not.toContain(
              "schedule_create",
            );
          },
          response: {
            type: "tool",
            id: "lookup",
            name: "find_tools",
            arguments: { query: "schedule reminder recurring" },
          },
        },
        {
          expect(request) {
            expect(JSON.parse(String(latestToolResult(request)?.content)).tools[0]).toMatchObject({
              name: "schedule_create",
              inputSchema: expect.any(Object),
            });
          },
          response: {
            type: "tool",
            id: "invalid",
            name: "use_tool",
            arguments: { name: "schedule_create", args: { ...args, cron: 42 } },
          },
        },
        {
          expect(request) {
            expect(JSON.parse(String(latestToolResult(request)?.content))).toMatchObject({
              error: expect.stringContaining("invalid"),
              inputSchema: expect.any(Object),
            });
          },
          response: {
            type: "tool",
            id: "core-via-wrapper",
            name: "use_tool",
            arguments: { name: "shell", args: { command: "true" } },
          },
        },
        {
          expect(request) {
            expect(JSON.parse(String(latestToolResult(request)?.content))).toMatchObject({
              error: expect.stringContaining("find_tools"),
            });
          },
          response: {
            type: "tool",
            id: "direct-deferred",
            name: "schedule_create",
            arguments: args,
          },
        },
        {
          expect(request) {
            expect(JSON.parse(String(latestToolResult(request)?.content))).toMatchObject({
              ok: true,
            });
          },
          response: { type: "text", text: "Scheduled." },
        },
        { expect() {}, response: { type: "text", text: "Still scheduled." } },
      ],
    });
    cleanups.push(() => server.close());
    vi.stubEnv("RAKAZO_LOCAL_MODELS", server.model.id);
    vi.stubEnv("RAKAZO_LOCAL_MODELS_URL", server.baseUrl);
    vi.stubEnv("RAKAZO_LOCAL_CONTEXT_WINDOW", "");
    vi.stubEnv("RAKAZO_LOCAL_MAX_TOKENS", "");
    try {
      const provider = localProvider()!;
      expect(provider.getModels()[0]!.contextWindow).toBe(32_768);
      const runtime = new PiAgentRuntime();
      const events: AgentRuntimeEvent[] = [];
      for (const prompt of ["Create a daily reminder.", "Confirm the reminder."])
        await collect(
          runtime.run(
            runRequest(
              { provider: "local", id: server.model.id },
              {
                ...split,
                prompt,
                executeTool: async (name, toolArgs) => {
                  calls.push(name);
                  return name === "find_tools"
                    ? findDeferredTools(split.deferredTools, String(toolArgs.query))
                    : { ok: true };
                },
              },
            ),
          ),
          events,
        );
      server.assertComplete();
      expect(calls).toEqual(["find_tools", "schedule_create"]);
      expect(events.filter((event) => event.type === "tool").map((event) => event.name)).toEqual([
        "find_tools",
        "schedule_create",
        "use_tool",
        "schedule_create",
      ]);
      expect(events.filter((event) => event.type === "done")).toHaveLength(2);
      for (const request of server.requests)
        expect(JSON.stringify(request.tools)).toBe(JSON.stringify(server.requests[0]!.tools));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([undefined, "retrieval", "snapshots", "cache-aware"] as const)(
    "bounds actual initial and tool-loop requests with %s context",
    async (contextStrategy) => {
      const decisions: Array<{ droppedMessages: number; truncatedToolResults: number }> = [];
      const assertBounded = (request: ModelEmulatorRequest) => {
        expect(Buffer.byteLength(JSON.stringify(request.messages))).toBeLessThan(7168);
        expect(JSON.stringify(request.messages)).toContain("Save hello to notes.txt.");
      };
      const server = await startModelEmulator({
        steps: [
          {
            expect: assertBounded,
            response: {
              type: "tool",
              id: "bounded-tool",
              name: "write_file",
              arguments: { path: "notes.txt", content: "hello" },
            },
          },
          {
            expect(request) {
              assertBounded(request);
              expect(latestToolResult(request)?.tool_call_id).toBe("bounded-tool");
              expect(String(latestToolResult(request)?.content)).toContain("truncated");
              expect(
                request.messages.findLast((message) => message.role === "assistant")
                  ?.tool_calls?.[0]?.id,
              ).toBe("bounded-tool");
            },
            response: { type: "text", text: "Saved." },
          },
        ],
      });
      cleanups.push(() => server.close());
      const events = await collect(
        new PiAgentRuntime({ onContextDecision: (decision) => decisions.push(decision) }).run(
          runRequest(
            { ...server.model, contextWindow: 8192, maxTokens: 1024 },
            {
              contextStrategy,
              history: Array.from({ length: 100 }, (_, index) => ({
                id: `old-${index}`,
                role: "user" as const,
                content: `Old message ${index} ${"filler ".repeat(80)}`,
              })),
              executeTool: async () => ({ original: "large evidence ".repeat(6000) }),
            },
          ),
        ),
      ).catch((error) => {
        server.assertComplete();
        throw error;
      });
      server.assertComplete();
      expect(events.some((event) => event.type === "done")).toBe(true);
      expect(decisions).toHaveLength(2);
      expect(decisions[0]!.droppedMessages).toBeGreaterThan(0);
      expect(decisions[1]!.truncatedToolResults).toBe(1);
    },
  );

  it("sends the same provider context for omitted and explicit retrieval when history tools are usable", async () => {
    let firstMessages: ModelEmulatorRequest["messages"] | undefined;
    let firstTools: ModelEmulatorRequest["tools"] | undefined;
    const server = await startModelEmulator({
      steps: [
        {
          expect(request) {
            firstMessages = request.messages;
            firstTools = request.tools;
          },
          response: { type: "text", text: "Done." },
        },
        {
          expect(request) {
            expect(request.messages).toEqual(firstMessages);
            expect(request.tools).toEqual(firstTools);
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const history = Array.from({ length: 40 }, (_, index) => ({
      id: `paired-${index}`,
      role: "user" as const,
      content: `Original ${index}: ${"bounded historical evidence ".repeat(20)}`,
    }));
    const tools = ["read_history", "search_history"].map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object" as const, properties: {} },
    }));
    for (const contextStrategy of [undefined, "retrieval"] as const)
      await collect(
        new PiAgentRuntime().run(
          runRequest(
            { ...server.model, contextWindow: 8192, maxTokens: 1024 },
            { history, tools, executeTool: async () => ({}), contextStrategy },
          ),
        ),
      );
    server.assertComplete();
    expect(JSON.stringify(firstMessages)).not.toContain("Original 0:");
    expect(JSON.stringify(firstMessages)).toContain("Original 39:");
  });

  it("keeps fitting standalone originals under the shared default without unavailable history tools", async () => {
    const history = Array.from({ length: 40 }, (_, index) => ({
      id: `short-${index}`,
      role: "user" as const,
      content: `Standalone original ${index}: rare-${index}`,
    }));
    const assertOriginals = (request: ModelEmulatorRequest) => {
      const wire = JSON.stringify(request.messages);
      for (const item of history) expect(wire).toContain(item.content);
      expect(wire).toContain("Save hello to notes.txt.");
      expect(wire).not.toContain("Historical navigation snapshots");
      expect(
        request.tools?.some((tool) =>
          ["read_history", "search_history"].includes(tool.function.name),
        ),
      ).toBe(false);
    };
    const server = await startModelEmulator({
      steps: [
        {
          expect: assertOriginals,
          response: {
            type: "tool",
            id: "standalone-write",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            assertOriginals(request);
            expect(latestToolResult(request)?.tool_call_id).toBe("standalone-write");
          },
          response: { type: "text", text: "Saved." },
        },
      ],
    });
    cleanups.push(() => server.close());
    await collect(
      new PiAgentRuntime().run(
        runRequest(
          { ...server.model, contextWindow: 8192, maxTokens: 1024 },
          { history, executeTool: async () => ({ ok: true }) },
        ),
      ),
    );
    server.assertComplete();
  });

  it("rejects an oversized live request before invoking the model or reserving spend", async () => {
    const server = await startModelEmulator({ steps: [] });
    cleanups.push(() => server.close());
    let reservations = 0;
    const events: AgentRuntimeEvent[] = [];
    await expect(
      collect(
        new PiAgentRuntime({
          modelCallObserver: {
            beforeCall: async () => {
              reservations += 1;
              return "reserved";
            },
            afterCall: async () => undefined,
          },
        }).run(
          runRequest(
            { ...server.model, contextWindow: 4096, maxTokens: 1024 },
            {
              contextStrategy: "retrieval",
              prompt: "Required user request ".repeat(2000),
              tools: [],
            },
          ),
        ),
        events,
      ),
    ).rejects.toThrow(
      /^This chat needs about [\d,]+ tokens of context, but the selected model allows about 3,070; choose a model with a larger context window\.$/,
    );
    server.assertComplete();
    expect(reservations).toBe(0);
    expect(events.filter((event) => event.type === "usage")).toHaveLength(0);
  });

  it("enforces the same context budget inside a delegated tool loop", async () => {
    const decisions: Array<{ agentId?: string; strategy?: string; truncatedToolResults: number }> =
      [];
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "delegate",
            name: "use_tool",
            arguments: {
              name: "run_subagent",
              args: { name: "helper", task: "Save hello to notes.txt." },
            },
          },
        },
        {
          expect(request) {
            expect(request.tools?.some((tool) => tool.function.name === "run_subagent")).toBe(
              false,
            );
            expect(JSON.stringify(request.messages)).toContain("Save hello to notes.txt.");
          },
          response: {
            type: "tool",
            id: "child-lookup",
            name: "find_tools",
            arguments: { query: "run_subagent" },
          },
        },
        {
          expect(request) {
            expect(JSON.parse(String(latestToolResult(request)?.content))).toMatchObject({
              tools: [],
              names: ["schedule_list"],
            });
          },
          response: {
            type: "tool",
            id: "child-delegation-denied",
            name: "use_tool",
            arguments: { name: "run_subagent", args: { name: "helper", task: "Delegate again." } },
          },
        },
        {
          expect(request) {
            expect(JSON.parse(String(latestToolResult(request)?.content))).toMatchObject({
              error: expect.stringContaining("find_tools"),
            });
            expect(JSON.stringify(request.tools)).toBe(JSON.stringify(server.requests[1]!.tools));
          },
          response: {
            type: "tool",
            id: "child-write",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            expect(Buffer.byteLength(JSON.stringify(request.messages))).toBeLessThan(7168);
            expect(latestToolResult(request)?.tool_call_id).toBe("child-write");
            expect(String(latestToolResult(request)?.content)).toContain("truncated");
            expect(JSON.stringify(request.messages)).toContain("Save hello to notes.txt.");
          },
          response: { type: "text", text: "Saved." },
        },
        {
          expect(request) {
            expect(latestToolResult(request)?.tool_call_id).toBe("delegate");
          },
          response: { type: "text", text: "Finished." },
        },
      ],
    });
    cleanups.push(() => server.close());
    await collect(
      new PiAgentRuntime({ onContextDecision: (decision) => decisions.push(decision) }).run(
        runRequest(
          { ...server.model, contextWindow: 8192, maxTokens: 1024 },
          {
            ...splitDeferredTools([
              writeTool,
              builtinAgentTools.find((tool) => tool.name === "schedule_list")!,
              {
                name: "run_subagent",
                description: "Delegate a task",
                inputSchema: {
                  type: "object",
                  properties: { name: { type: "string" }, task: { type: "string" } },
                  required: ["task"],
                },
              },
            ]),
            executeTool: async () => ({ original: "large child evidence ".repeat(3000) }),
          },
        ),
      ),
    ).catch((error) => {
      server.assertComplete();
      throw error;
    });
    server.assertComplete();
    expect(decisions).toHaveLength(6);
    expect(decisions.every((decision) => decision.strategy === "retrieval")).toBe(true);
    expect(decisions.filter((decision) => decision.agentId)).toHaveLength(4);
    expect(
      decisions.some((decision) => decision.agentId && decision.truncatedToolResults === 1),
    ).toBe(true);
  });

  it("assembles fragmented tool arguments, executes the write, and sends its result back", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-pi-offline-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const calls: Array<{ name: string; args: Record<string, unknown>; id?: string }> = [];
    const server = await startModelEmulator({
      apiKey: "fixture-only-key",
      steps: [
        {
          expect(request) {
            expect(request.messages.at(-1)).toMatchObject({
              role: "user",
              content: [{ type: "text", text: "Save hello to notes.txt." }],
            });
            expect(request.tools).toContainEqual(
              expect.objectContaining({
                function: expect.objectContaining({ name: "write_file" }),
              }),
            );
          },
          response: {
            type: "tool",
            id: "write-1",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hello\n" },
            argumentChunks: ['{"pa', 'th":"notes.', 'txt","content":"hel', "lo\\", 'n"}'],
          },
        },
        {
          expect(request) {
            expect(
              request.messages.find((message) => message.role === "assistant")?.tool_calls,
            ).toEqual([
              {
                id: "write-1",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "notes.txt", content: "hello\n" }),
                },
              },
            ]);
            expect(latestToolResult(request)).toMatchObject({ tool_call_id: "write-1" });
            expect(JSON.parse(String(latestToolResult(request)?.content))).toEqual({
              path: "notes.txt",
              bytes: 6,
            });
          },
          response: { type: "text", text: "Saved notes.txt." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          async executeTool(name, args, id) {
            calls.push({ name, args, id });
            expect(name).toBe("write_file");
            expect(args.path).toBe("notes.txt");
            await writeFile(path.join(dir, "notes.txt"), String(args.content));
            return { path: "notes.txt", bytes: Buffer.byteLength(String(args.content)) };
          },
        }),
      ),
    ).catch((error) => {
      try {
        server.assertComplete();
      } catch (fixtureError) {
        throw new AggregateError(
          [error, fixtureError],
          "Pi failed and model fixture validation also failed",
        );
      }
      throw error;
    });
    server.assertComplete();
    expect(calls).toEqual([
      {
        name: "write_file",
        args: { path: "notes.txt", content: "hello\n" },
        id: JSON.stringify(["pi-tool", "main", "write-1"]),
      },
    ]);
    expect(await readFile(path.join(dir, "notes.txt"), "utf8")).toBe("hello\n");
    expect(events.at(-1)).toEqual({ type: "done", text: "Saved notes.txt." });
  });

  it("returns tool failure to the model and continues without claiming a successful write", async () => {
    let calls = 0;
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "denied-write",
            name: "write_file",
            arguments: { path: "notes.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            expect(latestToolResult(request)).toMatchObject({ tool_call_id: "denied-write" });
            expect(String(latestToolResult(request)?.content)).toContain("Fixture write denied");
          },
          response: { type: "text", text: "The file could not be saved." },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events = await collect(
      new PiAgentRuntime().run(
        runRequest(server.model, {
          executeTool: async () => {
            calls++;
            throw new Error("Fixture write denied");
          },
        }),
      ),
    );
    server.assertComplete();
    expect(calls).toBe(1);
    expect(events.at(-1)).toEqual({ type: "done", text: "The file could not be saved." });
  });

  it("propagates a provider rejection without dispatching tools or emitting done", async () => {
    let calls = 0;
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: { type: "error", status: 400, message: "Fixture request rejected" },
        },
      ],
    });
    cleanups.push(() => server.close());
    const events: AgentRuntimeEvent[] = [];
    await expect(
      collect(
        new PiAgentRuntime().run(
          runRequest(server.model, {
            executeTool: async () => {
              calls++;
              return {};
            },
          }),
        ),
        events,
      ),
    ).rejects.toThrow(/Fixture request rejected/);
    server.assertComplete();
    expect(calls).toBe(0);
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("rejects an interrupted SSE response without emitting successful completion", async () => {
    const server = await startModelEmulator({
      steps: [{ expect() {}, response: { type: "disconnect", text: "Working" } }],
    });
    cleanups.push(() => server.close());
    const events: AgentRuntimeEvent[] = [];
    await expect(
      collect(new PiAgentRuntime().run(runRequest(server.model)), events),
    ).rejects.toThrow();
    server.assertComplete();
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("cancels a quiet HTTP stream and closes the provider connection", async () => {
    const opened = deferred();
    const closed = deferred();
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "hold",
            onOpen: opened.resolve,
            onClose: closed.resolve,
          },
        },
      ],
    });
    cleanups.push(() => server.close());
    const controller = new AbortController();
    const events: AgentRuntimeEvent[] = [];
    const work = collect(
      new PiAgentRuntime().run(runRequest(server.model), { signal: controller.signal }),
      events,
    );
    // Attach the rejection handler before aborting to avoid an unhandled rejection.
    const outcome = work.then(
      () => undefined,
      (error: unknown) => error,
    );
    await opened.promise;
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    await closed.promise;
    server.assertComplete();
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("keeps two model connections and their responses isolated", async () => {
    const first = await startModelEmulator({
      modelId: "fixture-first",
      apiKey: "first-fixture-key",
      steps: [{ expect() {}, response: { type: "text", text: "First connection" } }],
    });
    const second = await startModelEmulator({
      modelId: "fixture-second",
      apiKey: "second-fixture-key",
      steps: [{ expect() {}, response: { type: "text", text: "Second connection" } }],
    });
    cleanups.push(
      () => first.close(),
      () => second.close(),
    );
    const runtime = new PiAgentRuntime();
    const results = await Promise.all(
      [first, second].map((server) => collect(runtime.run(runRequest(server.model)))),
    );
    expect(results.map((events) => events.at(-1))).toEqual([
      { type: "done", text: "First connection" },
      { type: "done", text: "Second connection" },
    ]);
    first.assertComplete();
    second.assertComplete();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
