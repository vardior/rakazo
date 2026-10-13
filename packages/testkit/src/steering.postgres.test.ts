import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { type ModelEmulatorStep, startModelEmulator } from "./model-emulator.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

function lastUserText(request: Parameters<ModelEmulatorStep["expect"]>[0]) {
  const content = request.messages.filter((message) => message.role === "user").at(-1)?.content;
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .flatMap((part: { type?: string; text?: string }) => (part.type === "text" ? [part.text] : []))
    .join("");
}

async function withSteeringProduct(
  steps: ModelEmulatorStep[],
  use: (product: {
    send: (text: string) => Promise<{ runId: string | null }>;
    waitForIdle: () => Promise<void>;
    botMessages: () => Promise<string[]>;
    runTriggers: () => Promise<string[]>;
  }) => Promise<void>,
  { keepIntro = false } = {},
) {
  const model = await startModelEmulator({ steps });
  const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-steering-fixture-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "pi",
      contextStrategy: "current",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "steering-fixture-encryption-key",
    });
    stop = handles.stop;
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `steering-${randomUUID()}@rakazo.test`,
        password: "password12",
        name: "Steering fixture",
      }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);
    const rpc = async <T>(procedure: string, input: unknown = {}): Promise<T> => {
      const response = await handles.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify({ json: input }),
      });
      const body = (await response.json()) as { json: T; error?: { message: string } };
      if (response.status >= 400 || body.error)
        throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
      return body.json;
    };
    await rpc("models/connect", {
      provider: model.model.provider,
      modelId: model.model.id,
      baseUrl: model.baseUrl,
    });
    const bot = await rpc<{ id: string }>("bots/create", {
      name: "Steering fixture",
      title: "",
      description: "",
      instructions: "Answer the user.",
      notifyOnFinish: false,
    });
    if (!keepIntro) {
      await discardBotIntroRun(handles, cookie, bot.id);
      await rpc("bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
    }
    const runs = () =>
      handles.prisma.run.findMany({
        where: { botId: bot.id, ...(keepIntro ? {} : { trigger: { not: "created" } }) },
        orderBy: { createdAt: "asc" },
      });
    await use({
      send: (text) => rpc("threads/send", { botId: bot.id, text }),
      waitForIdle: () =>
        expect
          .poll(
            async () => {
              const all = await runs();
              return all.length > 0 && all.every((run) => run.status === "completed");
            },
            { timeout: 15_000, interval: 100 },
          )
          .toBe(true),
      botMessages: async () => {
        const messages = await handles.prisma.message.findMany({
          where: { role: "bot", runId: { in: (await runs()).map((run) => run.id) } },
          orderBy: { seq: "asc" },
        });
        return messages.map((message) =>
          (message.blocks as MessageBlock[])
            .flatMap((block) => (block.kind === "text" ? [block.text] : []))
            .join(""),
        );
      },
      runTriggers: async () => (await runs()).map((run) => run.trigger),
    });
    model.assertComplete();
  } finally {
    await stop?.();
    await model.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe.skipIf(!enabled)("steering a running reply", () => {
  it("answers a correction sent during the final reply in the same run", async () => {
    const replying = gate();
    const steered = gate();
    await withSteeringProduct(
      [
        {
          expect: async () => {
            replying.open();
            await steered.opened;
          },
          response: { type: "text", text: "Booked for Tuesday." },
        },
        {
          expect: (request) => {
            expect(lastUserText(request)).toContain("Actually make it Thursday");
          },
          response: { type: "text", text: "Moved to Thursday." },
        },
      ],
      async (product) => {
        await product.send("Book the dentist for Tuesday");
        await replying.opened;
        await product.send("Actually make it Thursday");
        steered.open();
        await product.waitForIdle();
        expect(await product.botMessages()).toEqual(["Booked for Tuesday.", "Moved to Thursday."]);
        expect(await product.runTriggers()).toEqual(["user"]);
      },
    );
  }, 60_000);

  it("answers a message held behind other work as the user's own request", async () => {
    const introducing = gate();
    const held = gate();
    await withSteeringProduct(
      [
        {
          expect: async () => {
            introducing.open();
            await held.opened;
          },
          response: { type: "text", text: "Hi, I'm ready." },
        },
        {
          expect: (request) => {
            const prompt = lastUserText(request);
            expect(prompt.startsWith("Book the dentist for Tuesday")).toBe(true);
            expect(prompt).not.toContain("steering context");
            expect(prompt).not.toContain("Additional user context");
          },
          response: { type: "text", text: "Booked for Tuesday." },
        },
      ],
      async (product) => {
        await introducing.opened;
        await product.send("Book the dentist for Tuesday");
        held.open();
        await product.waitForIdle();
        expect(await product.runTriggers()).toEqual(["created", "follow_up"]);
        expect(await product.botMessages()).toEqual(["Hi, I'm ready.", "Booked for Tuesday."]);
      },
      { keepIntro: true },
    );
  }, 60_000);
});
