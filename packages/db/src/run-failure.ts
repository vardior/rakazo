import type { MessageBlock } from "@rakazo/contracts";

export function failedRunBlocks(runId: string, error: string): MessageBlock[] {
  const reason = /overload|unavailable|rate.?limit|too many requests|\b429\b|\b50[0234]\b/i.test(
    error,
  )
    ? "the model provider is unavailable"
    : /terminated|connection|network|socket|fetch failed|disconnect|timed? out|ECONN|EPIPE/i.test(
          error,
        )
      ? "the connection dropped"
      : undefined;
  return reason
    ? [{ kind: "text", text: `I didn't finish because ${reason}.`, runFailure: { runId } }]
    : [];
}

const PRIOR_ATTEMPT_START = "\n\n<prior-attempts>\n";
const PRIOR_ATTEMPT_END = "\n</prior-attempts>";
const TOOL_LIMIT = 20;
const NOTE_LIMIT = 2400;

export function failedRunRequestPrompt(prompt: string): string {
  const start = prompt.endsWith(PRIOR_ATTEMPT_END) ? prompt.lastIndexOf(PRIOR_ATTEMPT_START) : -1;
  return start < 0 ? prompt : prompt.slice(0, start);
}

export function failedRunRetryPrompt(
  prompt: string,
  events: Array<{ type: string; payload: unknown }>,
): string {
  const request = failedRunRequestPrompt(prompt);
  const earlier =
    request === prompt
      ? ""
      : prompt.slice(request.length + PRIOR_ATTEMPT_START.length, -PRIOR_ATTEMPT_END.length);
  const tools = new Map<string, { name: string; target?: string; outcome: string }>();
  for (const event of events) {
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload))
      continue;
    const payload = event.payload as Record<string, unknown>;
    if (typeof payload.name !== "string" || typeof payload.executionId !== "string") continue;
    const existing = tools.get(payload.executionId);
    tools.set(payload.executionId, {
      name: payload.name.replace(/\s+/g, " ").slice(0, 80),
      target:
        typeof payload.target === "string"
          ? payload.target.replace(/\s+/g, " ").slice(0, 160)
          : existing?.target,
      outcome:
        event.type === "agent.tool.completed" &&
        ["succeeded", "error", "paused"].includes(String(payload.outcome))
          ? String(payload.outcome)
          : (existing?.outcome ?? "outcome unknown"),
    });
  }
  const activity = [...tools.values()]
    .slice(-TOOL_LIMIT)
    .map((tool) => `- ${tool.name}${tool.target ? ` — ${tool.target}` : ""}: ${tool.outcome}`);
  const earlierActivity = earlier.split("\n").filter((line) => line.startsWith("- "));
  const allActivity = [...earlierActivity, ...activity];
  const retainedActivity = allActivity.slice(-TOOL_LIMIT);
  while (retainedActivity.join("\n").length > 1800) retainedActivity.shift();
  const retained = retainedActivity.join("\n");
  const omitted =
    earlier.includes("Older tool activity omitted.") ||
    tools.size > TOOL_LIMIT ||
    allActivity.length > TOOL_LIMIT ||
    events.length >= 80 ||
    retainedActivity.length < allActivity.length;
  const note = [
    "Previous failed attempts: recorded tool activity, not proof that the request finished.",
    retained || "No tool activity was recorded.",
    omitted ? "Older tool activity omitted." : "",
    "Calls without a result may already have taken effect. Check current state before repeating any action with side effects.",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, NOTE_LIMIT);
  return `${request}${PRIOR_ATTEMPT_START}${note}${PRIOR_ATTEMPT_END}`;
}
