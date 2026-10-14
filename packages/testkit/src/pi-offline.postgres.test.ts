import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { startModelEmulator } from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";

describe.skipIf(!databaseAvailable)("offline Pi product journey", () => {
  it("uses a saved model connection and the real executor to persist a file and completed run", async () => {
    const fixtureKey = "offline-product-fixture-key";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Save hello to notes/result.txt.");
            expect(request.tools).toContainEqual(
              expect.objectContaining({
                function: expect.objectContaining({ name: "write_file" }),
              }),
            );
          },
          response: {
            type: "tool",
            id: "product-write",
            name: "write_file",
            arguments: { path: "notes/result.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.tool_call_id).toBe("product-write");
            expect(JSON.parse(String(result?.content))).toMatchObject({
              ok: true,
              path: "notes/result.txt",
            });
          },
          response: {
            type: "tool",
            id: "product-shell",
            name: "shell",
            arguments: { command: "wc -c notes/result.txt" },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.tool_call_id).toBe("product-shell");
          },
          response: { type: "text", text: "Saved notes/result.txt." },
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-offline-product-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.ts");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: fixtureOrigin,
        webOrigin: fixtureOrigin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
        encryptionKey: "offline-model-fixture-encryption-key",
      });
      stop = handles.stop;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixtureOrigin },
        body: JSON.stringify({
          email: `offline-pi-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Offline fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      await rpc(handles.app, cookie, "models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: fixtureKey,
        contextWindow: 160_000,
        maxTokens: 4096,
      });
      const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "File fixture",
        title: "",
        description: "",
        instructions: "Complete the task.",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      await rpc(handles.app, cookie, "bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        botId: bot.id,
        text: "Save hello to notes/result.txt.",
      });
      await expect
        .poll(
          async () => {
            const run = await handles.prisma.run.findUnique({
              where: { id: sent.runId },
              select: { status: true },
            });
            if (run?.status === "failed") model.assertComplete();
            return run?.status;
          },
          { timeout: 15_000, interval: 100 },
        )
        .toBe("completed");
      model.assertComplete();
      const file = await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", {
        botId: bot.id,
        path: "notes/result.txt",
      });
      expect(file.content).toBe("hello");
      const thread = await rpc<{ messages: Array<{ role: string; blocks: unknown[] }> }>(
        handles.app,
        cookie,
        "threads/get",
        { botId: bot.id },
      );
      const messages = JSON.stringify(thread.messages);
      expect(messages).toContain("Saved notes/result.txt.");
      expect(messages).not.toContain(fixtureKey);
      const tools = await handles.prisma.event.findMany({
        where: { botId: bot.id, type: "agent.tool.called" },
        select: { payload: true },
      });
      expect(tools).toHaveLength(2);
      expect(JSON.stringify(tools[0])).toContain("write_file");
      const commands = await rpc<Array<Record<string, unknown>>>(
        handles.app,
        cookie,
        "computer/commands",
        { botId: bot.id },
      );
      expect(commands).toEqual([
        expect.objectContaining({
          executionId: JSON.stringify(["pi-tool", "main", "product-write"]),
          kind: "write_file",
          command: "notes/result.txt",
          status: "done",
          exitCode: 0,
          bytes: 5,
        }),
        expect.objectContaining({
          executionId: JSON.stringify(["pi-tool", "main", "product-shell"]),
          kind: "shell",
          command: "wc -c notes/result.txt",
          status: "done",
          exitCode: 0,
        }),
      ]);
    } finally {
      try {
        await stop?.();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it("answers the owner during a routine before the routine resumes and finishes", async () => {
    const fixtureKey = "offline-priority-fixture-key";
    let handles: Awaited<ReturnType<typeof import("../../../apps/api/src/app.ts").createApp>>;
    let routineRunId = "";
    let ownerRunId = "";
    let routineAtModel: () => void = () => undefined;
    const routineReachedModel = new Promise<void>((resolve) => {
      routineAtModel = resolve;
    });
    let ownerMessageSent: () => void = () => undefined;
    const ownerMessageLanded = new Promise<void>((resolve) => {
      ownerMessageSent = resolve;
    });
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          async expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Collect the weekly numbers.");
            routineAtModel();
            await ownerMessageLanded;
          },
          response: {
            type: "tool",
            id: "routine-write",
            name: "write_file",
            arguments: { path: "notes/weekly.txt", content: "part one" },
          },
        },
        {
          async expect(request) {
            expect(JSON.stringify(request.messages)).toContain("What is the status?");
            const routineRun = await handles.prisma.run.findUniqueOrThrow({
              where: { id: routineRunId },
            });
            expect(routineRun.status).toBe("queued");
            expect(
              await handles.prisma.attempt.count({
                where: { runId: routineRunId, status: "running" },
              }),
            ).toBe(0);
          },
          response: { type: "text", text: "Status: the weekly numbers are in progress." },
        },
        {
          async expect(request) {
            const prompt = JSON.stringify(request.messages);
            expect(prompt).toContain("Collect the weekly numbers.");
            expect(prompt).toContain("This run was paused so the user could be answered first.");
            expect(prompt).toContain("Writing notes/weekly.txt");
            expect(prompt).toContain("[write_file]");
            expect(
              await handles.prisma.run.findUniqueOrThrow({ where: { id: ownerRunId } }),
            ).toMatchObject({ status: "completed" });
          },
          response: { type: "text", text: "Weekly numbers collected." },
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-offline-priority-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.ts");
      handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: fixtureOrigin,
        webOrigin: fixtureOrigin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
        encryptionKey: "offline-model-fixture-encryption-key",
      });
      stop = handles.stop;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixtureOrigin },
        body: JSON.stringify({
          email: `offline-priority-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Offline fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      await rpc(handles.app, cookie, "models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: fixtureKey,
        contextWindow: 160_000,
        maxTokens: 4096,
      });
      const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "Routine fixture",
        title: "",
        description: "",
        instructions: "Complete the task.",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      const routine = await rpc<{ id: string }>(handles.app, cookie, "routines/create", {
        botId: bot.id,
        name: "Weekly numbers",
        prompt: "Collect the weekly numbers.",
        crons: ["0 9 * * 1"],
        timezone: "UTC",
        notify: false,
        active: true,
      });
      const dueAt = new Date(Date.now() - 1_000);
      await handles.prisma.routine.update({
        where: { id: routine.id },
        data: { nextRunAt: dueAt },
      });
      await handles.executor.wakeRoutine(routine.id, dueAt.toISOString());
      const scheduled = await handles.prisma.routine.findUniqueOrThrow({
        where: { id: routine.id },
      });
      routineRunId = (
        await handles.prisma.run.findFirstOrThrow({
          where: { routineId: routine.id },
          select: { id: true },
        })
      ).id;
      await routineReachedModel;

      const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        botId: bot.id,
        text: "What is the status?",
      });
      ownerRunId = sent.runId;
      expect(ownerRunId).not.toBe(routineRunId);
      ownerMessageSent();

      await expect
        .poll(
          async () => {
            const run = await handles.prisma.run.findUniqueOrThrow({
              where: { id: routineRunId },
              select: { status: true },
            });
            if (run.status === "failed") model.assertComplete();
            return run.status;
          },
          { timeout: 30_000, interval: 100 },
        )
        .toBe("completed");
      model.assertComplete();

      const [ownerRun, routineRun, routineAttempts, storedRoutine] = await Promise.all([
        handles.prisma.run.findUniqueOrThrow({ where: { id: ownerRunId } }),
        handles.prisma.run.findUniqueOrThrow({ where: { id: routineRunId } }),
        handles.prisma.attempt.findMany({
          where: { runId: routineRunId },
          orderBy: { startedAt: "asc" },
          select: { status: true },
        }),
        handles.prisma.routine.findUniqueOrThrow({ where: { id: routine.id } }),
      ]);
      expect(ownerRun).toMatchObject({ status: "completed", trigger: "user" });
      expect(routineRun).toMatchObject({ status: "completed", error: null });
      expect(routineAttempts.map((attempt) => attempt.status)).toEqual(["yielded", "completed"]);
      expect(storedRoutine).toMatchObject({
        active: true,
        nextRunAt: scheduled.nextRunAt,
        lastRunAt: scheduled.lastRunAt,
      });
      expect(await handles.prisma.run.count({ where: { routineId: routine.id } })).toBe(1);
      expect(
        await handles.prisma.event.count({ where: { runId: routineRunId, type: "run.failed" } }),
      ).toBe(0);
      const replies = await handles.prisma.message.findMany({
        where: { threadId: routineRun.threadId, role: "bot" },
        orderBy: { seq: "asc" },
        select: { runId: true, blocks: true },
      });
      expect(replies.map((reply) => reply.runId)).toEqual([ownerRunId, routineRunId]);
      expect(JSON.stringify(replies[0]?.blocks)).toContain("Status: the weekly numbers");
      expect(JSON.stringify(replies[1]?.blocks)).toContain("Weekly numbers collected.");
      const file = await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", {
        botId: bot.id,
        path: "notes/weekly.txt",
      });
      expect(file.content).toBe("part one");
    } finally {
      try {
        await stop?.();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 60_000);
});

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
