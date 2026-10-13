#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.FIXTURE_PORT ?? 0);
const logPath = process.env.FIXTURE_LOG;
const modelId = process.env.FIXTURE_MODEL_ID ?? "verify-fixture";
let requestCount = 0;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPriorAssistantTurn(message) {
  return message.role === "assistant" || textOf(message.content).startsWith("Assistant: ");
}

function newUserMessages(messages) {
  const lastAssistant = messages.findLastIndex(isPriorAssistantTurn);
  return messages
    .slice(lastAssistant + 1)
    .filter((message) => message.role === "user")
    .map((message) => textOf(message.content));
}

function markerIn(text, name, fallbackSeconds) {
  const match = text.match(new RegExp(`\\[\\[${name}(?::(\\d+))?\\]\\]`));
  return match ? Number(match[1] ?? fallbackSeconds) : null;
}

function choosePlan(messages) {
  const latestIndex = messages.findLastIndex((message) => message.role === "user");
  const latest = textOf(messages[latestIndex]?.content);
  const answeredByTool = messages.slice(latestIndex + 1).some((message) => message.role === "tool");
  if (!answeredByTool) {
    const finalSeconds = markerIn(latest, "slow-final", 20);
    if (finalSeconds !== null) return { kind: "slow-final", seconds: finalSeconds };
    const toolSeconds = markerIn(latest, "slow-tool", 10);
    if (toolSeconds !== null) return { kind: "slow-tool", seconds: toolSeconds };
  }
  return { kind: "ack" };
}

function condensed(text) {
  const flat = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ⏎ ");
  return flat.length > 260 ? `${flat.slice(0, 110)} … ${flat.slice(-150)}` : flat;
}

function ackText(fresh) {
  if (fresh.length === 0) return "Fixture saw no new user message.";
  return `Fixture saw ${fresh.length} new user message(s): ${fresh.map((text) => `«${condensed(text)}»`).join(" | ")}`;
}

async function streamWords(emit, text, seconds, closed) {
  const words = text.split(" ");
  const delay = (seconds * 1000) / words.length;
  for (const word of words) {
    if (closed()) return;
    emit({ content: `${word} ` });
    await sleep(delay);
  }
}

const server = createServer(async (request, response) => {
  if (request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const n = ++requestCount;
  const messages = body.messages ?? [];
  const plan = choosePlan(messages);
  const fresh = newUserMessages(messages);
  const record = (entry) => {
    if (logPath)
      appendFileSync(logPath, `${JSON.stringify({ n, at: new Date().toISOString(), ...entry })}\n`);
  };
  record({
    phase: "start",
    plan: plan.kind,
    tools: (body.tools ?? []).length,
    roles: messages.map((message) => message.role[0]).join(""),
    newUserMessages: fresh.map(condensed),
  });

  let streamed = "";
  response.on("close", () => {
    if (!response.writableFinished) record({ phase: "abort", streamed: condensed(streamed) });
  });
  const closed = () => response.destroyed;
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.flushHeaders();
  const emit = (delta, finishReason = null) => {
    if (delta.content) streamed += delta.content;
    return response.write(
      `data: ${JSON.stringify({
        id: `fixture-${n}`,
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  };
  emit({ role: "assistant" });

  let reply;
  if (plan.kind === "slow-final") {
    reply = `Slow final answer. ${ackText(fresh)}`;
    await streamWords(emit, reply, plan.seconds, closed);
    if (closed()) return;
    emit({}, "stop");
  } else if (plan.kind === "slow-tool") {
    reply = "Posting a status before continuing.";
    await streamWords(emit, reply, plan.seconds, closed);
    if (closed()) return;
    emit({
      tool_calls: [
        {
          index: 0,
          id: `fixture-call-${n}`,
          type: "function",
          function: { name: "message_user", arguments: JSON.stringify({ text: "Working on it." }) },
        },
      ],
    });
    emit({}, "tool_calls");
  } else {
    reply = ackText(fresh);
    emit({ content: reply });
    emit({}, "stop");
  }
  response.end("data: [DONE]\n\n");
  record({ phase: "end", reply });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fixture model listening on http://127.0.0.1:${server.address().port}/v1`);
});
