import { ORPCError } from "@orpc/server";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { Actor, RunActivityRow } from "@rakazo/contracts";
import { MessageBlock, runFailureNotice } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, BACKGROUND_RUN_TRIGGERS, botMessageContext } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  failedRunRequestPrompt,
  failedRunRetryPrompt,
  IsolationError,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ThreadTarget } from "./thread-target.js";

const RECENT_LIMIT = 20;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export async function retryThreadRun(
  deps: { prisma: PrismaClient; events: ThreadEvents; jobs: JobPublisher },
  actor: Actor,
  target: ThreadTarget,
  runId: string,
): Promise<{ taskId: string; runId: string }> {
  const result = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
      const failed = await tx.run.findFirst({
        where: {
          id: runId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          threadId: target.threadId,
          botId: target.kind === "bot" ? target.botId : { in: target.memberBotIds },
        },
        include: { task: true },
      });
      if (!failed) throw new IsolationError();
      if (failed.status !== "failed")
        throw new ORPCError("CONFLICT", { message: "This run cannot be retried." });
      const clientNonce = `retry:${failed.id}`;
      const existing = await tx.run.findUnique({
        where: { spaceId_clientNonce: { spaceId: actor.spaceId, clientNonce } },
      });
      if (existing) return { taskId: existing.taskId, runId: existing.id, seq: null };
      const latestRun = await tx.run.findFirst({
        where: { threadId: target.threadId, botId: failed.botId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      const latestMessage = await tx.message.findFirst({
        where: {
          threadId: target.threadId,
          OR: [{ role: "user" }, { role: "bot", botId: failed.botId }],
        },
        orderBy: { seq: "desc" },
      });
      const parsed = MessageBlock.array().safeParse(latestMessage?.blocks);
      const notice = parsed.success
        ? runFailureNotice({ role: "bot", blocks: parsed.data })
        : undefined;
      if (
        latestMessage?.role !== "bot" ||
        !parsed.success ||
        latestRun?.id !== failed.id ||
        notice?.runFailure?.runId !== failed.id ||
        notice.runFailure.retried
      ) {
        throw new ORPCError("CONFLICT", {
          message: "This failure is no longer the latest request.",
        });
      }
      const events = await tx.event.findMany({
        where: { runId: failed.id, type: { in: ["agent.tool.called", "agent.tool.completed"] } },
        orderBy: { seq: "desc" },
        take: 80,
        select: { type: true, payload: true },
      });
      const task = await tx.task.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          threadId: target.threadId,
          botId: failed.botId,
          prompt: failedRunRetryPrompt(failed.task.prompt, events.reverse()),
          status: "queued",
        },
      });
      const run = await tx.run.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          threadId: target.threadId,
          botId: failed.botId,
          taskId: task.id,
          trigger: failed.trigger,
          routineId: failed.routineId,
          sourceMessageId: failed.sourceMessageId,
          modelPinned: failed.modelPinned,
          modelProvider: failed.modelPinned ? failed.modelProvider : null,
          modelId: failed.modelPinned ? failed.modelId : null,
          thinkingLevel: failed.thinkingLevel,
          clientNonce,
          status: "queued",
        },
      });
      await tx.steeringMessage.updateMany({
        where: { runId: failed.id },
        data: { runId: run.id, claimedAt: null },
      });
      const blocks = parsed.data.map((block) =>
        block.kind === "text" && block.runFailure
          ? { ...block, runFailure: { ...block.runFailure, retried: true as const } }
          : block,
      );
      await tx.message.update({
        where: { id: latestMessage.id },
        data: { blocks: blocks as Prisma.InputJsonValue },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId: failed.botId,
        type: "thread.message.updated",
        runId: failed.id,
        payload: { messageId: latestMessage.id, role: "bot", blocks },
      });
      return { taskId: task.id, runId: run.id, seq: event.seq };
    }),
  );
  await deps.jobs.enqueue(runContinueJob(result.runId));
  if (result.seq !== null)
    await deps.events.notify(target.threadId, result.seq).catch((error) => {
      getLogger().error("run retry realtime notification", error);
    });
  return { taskId: result.taskId, runId: result.runId };
}

function promptSnippet(prompt: string, max = 120): string {
  const oneLine = failedRunRequestPrompt(prompt).replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function activityPromptSnippet(
  input: { trigger: string; prompt: string; sourceBlocks?: unknown },
  max = 120,
): string {
  if (input.trigger !== "bot_message") return promptSnippet(input.prompt, max);
  const parsed = MessageBlock.array().safeParse(input.sourceBlocks);
  const message = parsed.success ? botMessageContext(parsed.data) : undefined;
  if (!message) return "Message from another agent";
  const name = message.fromBotName.trim() || "Another agent";
  const label =
    message.intent === "result" || message.intent === "status" || message.intent === "fyi"
      ? `Update from ${name}`
      : `${name} asked`;
  return promptSnippet(message.text.trim() ? `${label}: ${message.text}` : label, max);
}

export function activityNotificationsEnabled(
  groupId: string | null,
  notifyOnFinish: boolean,
): boolean {
  return groupId !== null || notifyOnFinish;
}

export async function listSpaceRuns(
  prisma: PrismaClient,
  actor: Actor,
  filter: "active" | "recent",
): Promise<RunActivityRow[]> {
  const rows = await prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
      // Background ticket work belongs on the board, not in the activity list.
      trigger: { notIn: [...BACKGROUND_RUN_TRIGGERS] },
      ...(filter === "active"
        ? { status: { in: [...ACTIVE_RUN_STATUSES] } }
        : { status: { in: [...TERMINAL_STATUSES] } }),
    },
    include: {
      bot: { select: { name: true, archivedAt: true, notifyOnFinish: true } },
      task: { select: { prompt: true } },
      sourceMessage: { select: { blocks: true } },
      thread: {
        select: {
          groupId: true,
          group: { select: { name: true } },
        },
      },
    },
    orderBy:
      filter === "active"
        ? [{ updatedAt: "desc" }, { id: "desc" }]
        : [{ completedAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    take: filter === "recent" ? RECENT_LIMIT : undefined,
  });

  return rows.map((row) => ({
    runId: row.id,
    botId: row.botId,
    botName: row.bot.name,
    groupId: row.thread.groupId,
    groupName: row.thread.group?.name ?? null,
    threadId: row.threadId,
    status: row.status as RunActivityRow["status"],
    trigger: row.trigger as RunActivityRow["trigger"],
    notificationsEnabled: activityNotificationsEnabled(row.thread.groupId, row.bot.notifyOnFinish),
    promptSnippet: activityPromptSnippet({
      trigger: row.trigger,
      prompt: row.task.prompt,
      sourceBlocks: row.sourceMessage?.blocks,
    }),
    updatedAt: (filter === "recent" && row.completedAt
      ? row.completedAt
      : row.updatedAt
    ).toISOString(),
  }));
}
