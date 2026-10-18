import { ORPCError } from "@orpc/server";
import type { SecretRecord, SecretStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import type { McpSecretMaterial } from "./mcp-material.js";

export type PreparedMcpSecretEnv = {
  serverId: string;
  previousSecretId: string | null;
  envKeys: string[];
  stored: SecretRecord;
};

export async function prepareMcpSecretEnv(
  deps: { prisma: PrismaClient; secrets: SecretStore },
  actor: Actor,
  serverId: string,
  env: Record<string, string>,
): Promise<PreparedMcpSecretEnv> {
  const owned = { spaceId: actor.spaceId, userId: actor.userId };
  const server = await deps.prisma.mcpServer.findFirst({
    where: { id: serverId, ...owned },
    select: { id: true, transport: true, secretId: true },
  });
  if (!server) throw new IsolationError();
  if (server.transport !== "stdio") {
    throw new ORPCError("BAD_REQUEST", {
      message: "Only local MCP servers take environment values",
    });
  }
  const existing = server.secretId
    ? await deps.prisma.secret.findFirst({ where: { id: server.secretId, ...owned } })
    : null;
  const material: McpSecretMaterial = existing
    ? JSON.parse(await deps.secrets.load(existing.ciphertext, existing.id))
    : {};
  const nextEnv = { ...(material.env ?? {}), ...env };
  const stored = await deps.secrets.put(JSON.stringify({ ...material, env: nextEnv }), {
    operationId: "mcp.secret-env",
    traceId: "mcp.secret-env",
    ...owned,
    botId: "mcp",
    signal: new AbortController().signal,
  });
  return {
    serverId: server.id,
    previousSecretId: server.secretId,
    envKeys: Object.keys(nextEnv),
    stored,
  };
}

export async function commitMcpSecretEnv(
  tx: Prisma.TransactionClient,
  actor: Actor,
  prepared: PreparedMcpSecretEnv,
): Promise<void> {
  const owned = { spaceId: actor.spaceId, userId: actor.userId };
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${prepared.serverId}))`;
  const current = await tx.mcpServer.findFirst({
    where: { id: prepared.serverId, ...owned },
    select: { secretId: true },
  });
  if (!current) throw new IsolationError();
  if (current.secretId !== prepared.previousSecretId) {
    throw new ORPCError("CONFLICT", { message: "MCP credentials changed; retry" });
  }
  await tx.secret.create({
    data: { id: prepared.stored.id, ...owned, kind: "mcp", ciphertext: prepared.stored.ciphertext },
  });
  await tx.mcpServer.update({
    where: { id: prepared.serverId },
    data: {
      secretId: prepared.stored.id,
      env: Object.fromEntries(prepared.envKeys.map((key) => [key, true])),
      revision: { increment: 1 },
    },
  });
  if (prepared.previousSecretId) {
    await tx.secret.deleteMany({ where: { id: prepared.previousSecretId, ...owned } });
  }
}
