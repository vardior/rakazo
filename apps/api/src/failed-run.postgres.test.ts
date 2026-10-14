import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import type { ThreadSnapshot } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { discardBotIntroRun } from "../../../packages/testkit/src/discard-bot-intro.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { startModelEmulator } from "../../../packages/testkit/src/model-emulator.js";
import { createApp } from "./app.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

describe.skipIf(!databaseAvailable)("failed run recovery", () => {
  it("persists a mid-work failure, retries with prior tool context, and keeps user stops quiet", async () => {
    let opened!: () => void;
    const modelOpened = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const model = await startModelEmulator({
      steps: [
        {
          expect: () => undefined,
          response: {
            type: "tool",
            id: "write-once",
            name: "write_file",
            arguments: { path: "notes/result.txt", content: "hello" },
            assistantText: "I'm saving the result.",
          },
        },
        {
          expect: () => undefined,
          response: {
            type: "error",
            status: 400,
            message: "Our servers are currently overloaded.",
          },
        },
        {
          expect(request) {
            const prompt = JSON.stringify(request.messages);
            expect(prompt).toContain("Save hello to notes/result.txt.");
            expect(prompt).toContain("write_file — notes/result.txt: succeeded");
            expect(prompt).toContain(
              "Check current state before repeating any action with side effects.",
            );
            const work = request.messages.find((message) =>
              String(message.content).includes("[past work]"),
            );
            expect(String(work?.content)).toContain('\\"ok\\":true');
          },
          response: { type: "text", text: "The file is already saved." },
        },
        {
          expect: () => undefined,
          response: { type: "hold", onOpen: opened },
        },
      ],
    });
    const temporaryRoot = join(process.cwd(), ".tmp");
    await mkdir(temporaryRoot, { recursive: true });
    const dataDir = await mkdtemp(join(temporaryRoot, "failed-run-"));
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "pi",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "offline-failure-fixture-key",
    });
    let modelClosed = false;
    try {
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `failure-${randomUUID()}@example.test`,
          password: "fixture-password-123",
          name: "Failure fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      async function rpc<T>(procedure: string, body: unknown): Promise<T> {
        const response = await handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify({ json: body }),
        });
        expect(response.status).toBe(200);
        return ((await response.json()) as { json: T }).json;
      }
      await rpc("models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: "local",
        contextWindow: 160_000,
        maxTokens: 4096,
      });
      const bot = await rpc<{ id: string }>("bots/create", {
        name: "Writer",
        title: "",
        description: "",
        instructions: "Complete the request.",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      const failed = await rpc<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: "Save hello to notes/result.txt.",
      });
      await handles.awaitIdle?.();
      expect(await handles.prisma.run.findUnique({ where: { id: failed.runId } })).toMatchObject({
        status: "failed",
      });
      const snapshot = await rpc<ThreadSnapshot>("threads/get", { botId: bot.id });
      const notice = snapshot.messages.at(-1);
      expect(notice).toMatchObject({
        role: "bot",
        botId: bot.id,
        runId: failed.runId,
        blocks: [
          {
            kind: "text",
            text: "I didn't finish because the model provider is unavailable.",
            runFailure: { runId: failed.runId },
          },
          {
            kind: "steps",
            steps: [{ label: "Write file", count: 1 }],
            workRecord: [
              {
                tool: "write_file",
                target: "notes/result.txt",
                result: JSON.stringify({ ok: true, path: "notes/result.txt" }),
              },
            ],
          },
        ],
      });
      expect(
        await handles.prisma.event.count({ where: { runId: failed.runId, type: "run.failed" } }),
      ).toBe(1);
      const outsiderSignup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `outsider-${randomUUID()}@example.test`,
          password: "fixture-password-123",
          name: "Other fixture",
        }),
      });
      const outsiderRetry = await handles.app.request("/rpc/threads/retry", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          cookie: sessionCookieHeader(outsiderSignup),
        },
        body: JSON.stringify({ json: { botId: bot.id, runId: failed.runId } }),
      });
      expect(outsiderRetry.status).toBe(404);
      const retries = await Promise.all([
        rpc<{ runId: string }>("threads/retry", { botId: bot.id, runId: failed.runId }),
        rpc<{ runId: string }>("threads/retry", { botId: bot.id, runId: failed.runId }),
      ]);
      expect(retries[0]).toEqual(retries[1]);
      expect(retries[0]!.runId).not.toBe(failed.runId);
      await handles.awaitIdle?.();
      const retry = await handles.prisma.run.findUniqueOrThrow({
        where: { id: retries[0]!.runId },
        include: { task: true },
      });
      expect(retry.status).toBe("completed");
      const original = await handles.prisma.run.findUniqueOrThrow({ where: { id: failed.runId } });
      expect(retry.sourceMessageId).toBe(original.sourceMessageId);
      const recovered = await rpc<ThreadSnapshot>("threads/get", { botId: bot.id });
      expect(
        recovered.messages.find((message) => message.id === notice!.id)?.blocks[0],
      ).toMatchObject({ runFailure: { runId: failed.runId, retried: true } });
      expect(recovered.messages.filter((message) => message.role === "user")).toHaveLength(1);
      expect(retry.task.prompt).toContain("write_file — notes/result.txt: succeeded");
      expect(
        await handles.prisma.event.count({
          where: { botId: bot.id, type: "agent.tool.called" },
        }),
      ).toBe(1);
      const cancelled = await rpc<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: "Wait for me.",
      });
      await modelOpened;
      await rpc("threads/stop", { botId: bot.id });
      model.assertComplete();
      await model.close();
      modelClosed = true;
      await handles.awaitIdle?.();
      expect(await handles.prisma.run.findUnique({ where: { id: cancelled.runId } })).toMatchObject(
        {
          status: "cancelled",
        },
      );
      const stopped = await rpc<ThreadSnapshot>("threads/get", { botId: bot.id });
      expect(
        stopped.messages.filter(
          (message) => message.runId === cancelled.runId && message.role === "bot",
        ),
      ).toEqual([]);
      const stoppedRetry = await handles.app.request("/rpc/threads/retry", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({ json: { botId: bot.id, runId: cancelled.runId } }),
      });
      expect(stoppedRetry.status).toBe(409);
    } finally {
      await handles.stop();
      if (!modelClosed) await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
