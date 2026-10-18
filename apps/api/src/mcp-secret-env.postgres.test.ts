import { createRouterClient } from "@orpc/server";
import { EncryptedSecretStore, withSecretPersistence } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("MCP secret env entered on the approval card (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `mcp-secret-env-user-${suffix}`;
  const organizationId = `mcp-secret-env-org-${suffix}`;
  const spaceId = `mcp-secret-env-space-${suffix}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const secrets = new EncryptedSecretStore("fake-encryption-key");
  const token = "fake-riseup-pat-value-0123456789";
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let botId: string;
  let threadId: string;
  let serverId: string;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = withSecretPersistence(db.prisma, secrets);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: userId, name: userId, email: actor.email, emailVerified: false },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Env Org", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    botId = (await prisma.bot.create({ data: { spaceId, userId, name: "Chief", color: "blue" } }))
      .id;
    threadId = (await prisma.thread.create({ data: { spaceId, userId, botId } })).id;
    serverId = (
      await prisma.mcpServer.create({
        data: {
          spaceId,
          userId,
          slug: "riseup",
          name: "RiseUp",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@riseup-oss/mcp"],
        },
      })
    ).id;
    await prisma.message.create({
      data: {
        threadId,
        seq: 1,
        role: "bot",
        botId,
        blocks: [
          {
            kind: "mcp_approval",
            name: "RiseUp",
            serverId,
            transport: "stdio",
            endpoint: null,
            needsOAuth: false,
            secretEnv: ["RISEUP_PAT"],
            status: "pending",
          },
        ],
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await close();
  });

  const client = () =>
    createRouterClient(
      createRouter({
        prisma,
        secrets,
        events: { notify: async () => {} },
        env: { webOrigin: "http://127.0.0.1:5173" },
        dataDir: "/tmp/rakazo-mcp-secret-env-test",
      } as unknown as RouterDeps),
      { context: { actor } as never },
    );

  it("leaves the credential untouched when the card was already dismissed", async () => {
    await client().mcp.assignments.dismiss({ botId, serverId, threadId });
    await expect(
      client().mcp.assignments.approve({ botId, serverId, threadId, env: { RISEUP_PAT: token } }),
    ).rejects.toThrow();
    const server = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
    expect(server.secretId).toBeNull();
    expect(await prisma.secret.count({ where: { spaceId } })).toBe(0);
    await prisma.message.updateMany({
      where: { threadId },
      data: {
        blocks: [
          {
            kind: "mcp_approval",
            name: "RiseUp",
            serverId,
            transport: "stdio",
            endpoint: null,
            needsOAuth: false,
            secretEnv: ["RISEUP_PAT"],
            status: "pending",
          },
        ],
      },
    });
  });

  it("stores the value only in the server's encrypted credential", async () => {
    await client().mcp.assignments.approve({
      botId,
      serverId,
      threadId,
      env: { RISEUP_PAT: token },
    });

    const server = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
    expect(server.env).toEqual({ RISEUP_PAT: true });
    const credential = await prisma.secret.findUniqueOrThrow({ where: { id: server.secretId! } });
    expect(credential.ciphertext).not.toContain(token);
    expect(JSON.parse(await secrets.load(credential.ciphertext, credential.id))).toEqual({
      env: { RISEUP_PAT: token },
    });
    expect(await prisma.botMcpServer.count({ where: { botId, serverId } })).toBe(1);

    const history = JSON.stringify({
      messages: await prisma.message.findMany({ where: { threadId } }),
      events: await prisma.event.findMany({ where: { threadId } }),
      server,
    });
    expect(history).toContain('"status":"connected"');
    expect(history).not.toContain(token);
  });
});
