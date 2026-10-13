import { once } from "node:events";
import { createServer } from "node:http";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";

type ChatRequest = { messages: Array<{ role: string; content: unknown }> };

async function withModelEndpoint(
  reply: (request: ChatRequest, index: number) => string,
  use: (baseUrl: string, requests: ChatRequest[]) => Promise<void>,
) {
  const requests: ChatRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
      requests.push(body);
      const content = reply(body, requests.length - 1);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    })().catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
  try {
    await use(`http://127.0.0.1:${address.port}/v1`, requests);
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
}

function runRequest(
  baseUrl: string,
  claimSteering: AgentRunRequest["claimSteering"],
): AgentRunRequest {
  return {
    botId: "bot-fixture",
    threadId: "thread-fixture",
    runId: "run-steering",
    prompt: "Book the dentist for Tuesday",
    instructions: "Answer briefly.",
    history: [],
    tools: [],
    contextStrategy: "retrieval",
    model: {
      provider: "openai-compatible",
      id: "fixture",
      baseUrl,
      contextWindow: 128_000,
      maxTokens: 4096,
    },
    claimSteering,
  };
}

async function collect(events: AsyncIterable<AgentRuntimeEvent>) {
  const collected: AgentRuntimeEvent[] = [];
  for await (const event of events) {
    if (event.type !== "usage") collected.push(event);
  }
  return collected;
}

describe("Pi steering", () => {
  it("answers steering that arrives while the final reply streams in the same run", async () => {
    await withModelEndpoint(
      (_request, index) => (index === 0 ? "Booked for Tuesday." : "Moved to Thursday."),
      async (baseUrl, requests) => {
        const claimed: string[][] = [];
        const events = await collect(
          new PiAgentRuntime().run(
            runRequest(baseUrl, async (seenIds) => {
              claimed.push(seenIds);
              return claimed.length === 2
                ? [{ id: "steer-1", messageId: "message-1", text: "Actually make it Thursday" }]
                : [];
            }),
            { signal: AbortSignal.timeout(15_000) },
          ),
        );

        expect(requests).toHaveLength(2);
        expect(requests[1]!.messages.at(-1)).toMatchObject({
          role: "user",
          content: expect.stringContaining("Actually make it Thursday"),
        });
        expect(events).toEqual([
          { type: "text", text: "Booked for Tuesday." },
          { type: "reply_complete" },
          { type: "text", text: "Moved to Thursday." },
          { type: "done", text: "Moved to Thursday." },
        ]);
        expect(claimed.at(-1)).toEqual(["steer-1"]);
      },
    );
  }, 30_000);
});
