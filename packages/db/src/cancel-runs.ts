import type { Prisma } from "./client.js";
import { persistCancelledRunWorkRecord } from "./events.js";

/** The caller selects authorized runs and owns the surrounding transaction and cleanup. */
export async function cancelRunsInTransaction(
  tx: Prisma.TransactionClient,
  runs: ReadonlyArray<{ id: string; taskId: string }>,
  cancelledAt: Date,
  options: { preserveWork?: boolean } = {},
): Promise<void> {
  if (runs.length === 0) return;
  const runIds = runs.map((run) => run.id);
  await tx.run.updateMany({
    where: { id: { in: runIds } },
    data: {
      status: "cancelled",
      completedAt: cancelledAt,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  await tx.attempt.updateMany({
    where: { runId: { in: runIds }, status: "running" },
    data: { status: "cancelled", finishedAt: cancelledAt },
  });
  await tx.task.updateMany({
    where: { id: { in: runs.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
  if (options.preserveWork !== false) {
    for (const run of runs) await persistCancelledRunWorkRecord(tx, run.id);
  }
}
