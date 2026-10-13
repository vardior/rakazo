import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";

describe.skipIf(!databaseAvailable)("offline Pi product journey", () => {
  it("persists interactive results and delivers routine reports while keeping empty monitoring silent", async () => {
    const fixtureKey = "offline-product-fixture-key";
    const routineCases: Array<{
      prompt: string;
      reply: string;
      unread: boolean;
      webhook?: boolean;
    }> = [
      { prompt: "Check my inbox for anything from the bank.", reply: "NO_RESPONSE", unread: false },
      {
        prompt: "Every morning send me my agenda.",
        reply: "Your agenda is empty today.",
        unread: true,
      },
      {
        prompt: "Watch for price drops and confirm each run even if nothing changed.",
        reply: "No price drops this run.",
        unread: true,
      },
      {
        prompt: "Watch this page for price drops.",
        reply: "NO_RESPONSE",
        unread: false,
        webhook: true,
      },
    ];
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
        ...routineCases.map(({ prompt, reply }) => ({
          expect(request: ModelEmulatorRequest) {
            const instructions = String(
              request.messages.find((message) => message.role === "system")?.content,
            );
            expect(JSON.stringify(request.messages)).toContain(prompt);
            expect(instructions).toContain("watch, check, or monitor");
            expect(instructions).toContain(
              "stay silent by default when there is nothing new worth the user's attention",
            );
            expect(instructions).toContain(
              "Always deliver requested scheduled reports or summaries",
            );
            expect(instructions).toContain(
              "always report or confirm each run when the routine's prompt explicitly asks for it",
            );
            expect(instructions).toContain("exactly NO_RESPONSE");
            expect(instructions).toContain(
              "Do not call message_user unless you have something to report.",
            );
          },
          response: { type: "text" as const, text: reply },
        })),
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
      const threadRecord = await handles.prisma.thread.findFirstOrThrow({
        where: { botId: bot.id },
      });
      for (const { prompt, reply, unread, webhook } of routineCases) {
        await handles.prisma.thread.update({
          where: { id: threadRecord.id },
          data: { unread: false },
        });
        const routine = await rpc<{ id: string }>(handles.app, cookie, "routines/create", {
          botId: bot.id,
          name: "Routine fixture",
          prompt,
          crons: ["0 9 * * *"],
          timezone: "UTC",
          notify: false,
          active: Boolean(webhook),
          webhookEnabled: Boolean(webhook),
        });
        let tested: { runId: string };
        if (webhook) {
          const hook = await rpc<{ secret: string; path: string }>(
            handles.app,
            cookie,
            "bots/rotateWebhookSecret",
            { botId: bot.id },
          );
          const response = await handles.app.request(hook.path, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${hook.secret}` },
            body: JSON.stringify({ price: 100 }),
          });
          expect(response.status).toBe(200);
          tested = (await response.json()) as { runId: string };
        } else {
          tested = await rpc<{ runId: string }>(handles.app, cookie, "routines/testRun", {
            routineId: routine.id,
          });
        }
        await expect
          .poll(
            async () => {
              const run = await handles.prisma.run.findUniqueOrThrow({
                where: { id: tested.runId },
              });
              if (run.status === "failed") model.assertComplete();
              return run.status;
            },
            { timeout: 15_000, interval: 100 },
          )
          .toBe("completed");
        const completedThread = await handles.prisma.thread.findUniqueOrThrow({
          where: { id: threadRecord.id },
        });
        expect(completedThread.unread).toBe(unread);
        const replies = await handles.prisma.message.findMany({
          where: { runId: tested.runId, role: "bot" },
        });
        if (unread) {
          expect(JSON.stringify(replies)).toContain(reply);
        } else {
          expect(replies).toEqual([]);
        }
      }
      model.assertComplete();
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
