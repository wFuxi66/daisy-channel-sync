import { PartnerError } from "@/partners/types";
import { DeferredCall } from "./connections";
import type { SyncContext } from "./context";
import { backoffDelayMs, claimJobs, completeJob, enqueueReconcile, rescheduleJob, type SyncJob } from "./jobs";
import { syncListing } from "./listing-sync";
import { RECONCILE_INTERVAL_MS, reconcileConnection } from "./reconcile";
import { processPendingEvents } from "./webhooks";

export interface WorkerOptions {
  /** Plafond de jobs par passage. */
  maxJobs?: number;
  /** Temps réel maximum d'un passage (une fonction serverless a une durée limitée). */
  deadlineMs?: number;
  /** Jobs traités en parallèle. */
  batchSize?: number;
}

export interface WorkerStats {
  processed: number;
  succeeded: number;
  deferred: number;
  failed: number;
}

/** Vide la file de synchro, par lots, jusqu'à épuisement, plafond ou échéance. */
export async function runWorker(ctx: SyncContext, options: WorkerOptions = {}): Promise<WorkerStats> {
  const { maxJobs = 200, deadlineMs = 25_000, batchSize = 5 } = options;
  const startedAt = Date.now();
  const stats: WorkerStats = { processed: 0, succeeded: 0, deferred: 0, failed: 0 };

  while (stats.processed < maxJobs && Date.now() - startedAt < deadlineMs) {
    const jobs = await claimJobs(ctx.sql, ctx.now(), Math.min(batchSize, maxJobs - stats.processed));
    if (jobs.length === 0) break;
    const outcomes = await Promise.all(jobs.map((job) => runJob(ctx, job)));
    for (const outcome of outcomes) stats[outcome]++;
    stats.processed += jobs.length;
  }
  return stats;
}

async function runJob(ctx: SyncContext, job: SyncJob): Promise<"succeeded" | "deferred" | "failed"> {
  try {
    if (job.kind === "sync_listing") await syncListing(ctx, job.listing_id!);
    else await reconcileConnection(ctx, job.connection_id);
    await completeJob(ctx.sql, job, ctx.now());
    return "succeeded";
  } catch (error) {
    if (error instanceof DeferredCall) {
      await rescheduleJob(ctx.sql, job, error.retryAt, error.message, { countAttempt: false });
      return "deferred";
    }
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof PartnerError)) console.error("job de synchro en erreur", { job, error });
    // Un 429 malgré notre budget : la minute du partenaire n'est pas la nôtre, on attend la suivante.
    const delay = error instanceof PartnerError && error.kind === "rate_limited" ? 61_000 : backoffDelayMs(job.attempts);
    await rescheduleJob(ctx.sql, job, new Date(ctx.now().getTime() + delay), message, { countAttempt: true });
    return "failed";
  }
}

/** Planifie la réconciliation de routine de chaque connexion. */
export async function scheduleRoutineReconciliations(ctx: SyncContext): Promise<number> {
  const now = ctx.now();
  const due = await ctx.sql<{ id: string }[]>`
    select id from partner_connections
    where last_reconciled_at is null or last_reconciled_at < ${new Date(now.getTime() - RECONCILE_INTERVAL_MS)}`;
  for (const { id } of due) await enqueueReconcile(ctx.sql, id, now);
  return due.length;
}

/** Purge : l'inbox n'a besoin de garder les event_id que le temps des rejeux Artisia (≈ 2h40). */
export async function purgeOldRecords(ctx: SyncContext): Promise<void> {
  const now = ctx.now().getTime();
  await ctx.sql`delete from inbound_events where processed_at < ${new Date(now - 7 * 24 * 3600_000)}`;
  await ctx.sql`delete from partner_rate_windows where window_start < ${new Date(now - 3600_000)}`;
}

/** Un tick complet, tel que lancé par le cron chaque minute. */
export async function runSyncTick(ctx: SyncContext, options: WorkerOptions = {}) {
  const replayedEvents = await processPendingEvents(ctx);
  const reconciliations = await scheduleRoutineReconciliations(ctx);
  const worker = await runWorker(ctx, options);
  await purgeOldRecords(ctx);
  return { replayedEvents, reconciliations, worker };
}
