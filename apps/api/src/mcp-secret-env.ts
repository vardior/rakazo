import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import { persistPreparedSecret } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import type { McpSecretMaterial } from "./mcp-material.js";

export type McpSecretEnvDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
};

async function loadMaterial(
  deps: McpSecretEnvDeps,
  secret: { id: string; ciphertext: string } | null,
): Promise<McpSecretMaterial> {
  if (!secret) return {};
  try {
    const value = JSON.parse(await deps.secrets.load(secret.ciphertext, secret.id));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export async function storeMcpSecretEnv(
  deps: McpSecretEnvDeps,
  actor: Actor,
  serverId: string,
  env: Record<string, string>,
): Promise<void> {
  const owned = { spaceId: actor.spaceId, userId: actor.userId };
  for (let attempt = 0; attempt < 5; attempt++) {
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
    const material = await loadMaterial(deps, existing);
    const nextEnv = { ...(material.env ?? {}), ...env };
    const stored = await deps.secrets.put(JSON.stringify({ ...material, env: nextEnv }), {
      operationId: "mcp.secret-env",
      traceId: "mcp.secret-env",
      ...owned,
      botId: "mcp",
      signal: new AbortController().signal,
    });
    const saved = await persistPreparedSecret(deps.prisma, deps.secrets, stored, () =>
      deps.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('mcp-oauth-material'), hashtext(${server.id}))`;
        const current = await tx.mcpServer.findFirst({
          where: { id: server.id, ...owned },
          select: { secretId: true },
        });
        if (!current) throw new IsolationError();
        if (current.secretId !== server.secretId) return false;
        await tx.secret.create({
          data: { id: stored.id, ...owned, kind: "mcp", ciphertext: stored.ciphertext },
        });
        await tx.mcpServer.update({
          where: { id: server.id },
          data: {
            secretId: stored.id,
            env: Object.fromEntries(Object.keys(nextEnv).map((key) => [key, true])),
            revision: { increment: 1 },
          },
        });
        if (server.secretId) {
          await tx.secret.deleteMany({ where: { id: server.secretId, ...owned } });
        }
        return true;
      }),
    );
    if (saved) return;
  }
  throw new ORPCError("CONFLICT", { message: "MCP credentials changed; retry" });
}
