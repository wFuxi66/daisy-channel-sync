import type { Db } from "@/lib/db";
import { PartnerError, type PartnerApi } from "@/partners/types";
import type { PartnerConnection, SyncContext } from "./context";
import { enqueueReconcile } from "./jobs";

/** Marge sous la limite Artisia (60/min) : dérive d'horloge, appels manuels, imprévus. */
export const CALLS_PER_MINUTE_BUDGET = 50;
/** Échecs consécutifs avant de déclarer la connexion dégradée. */
export const FAILURES_BEFORE_DEGRADED = 3;
/** Connexion dégradée : un seul appel « sonde » par intervalle, les autres attendent. */
export const PROBE_INTERVAL_MS = 30_000;

/** Appel non tenté (budget épuisé, disjoncteur ouvert) : à replanifier sans compter d'échec. */
export class DeferredCall extends Error {
  constructor(
    readonly retryAt: Date,
    reason: string,
  ) {
    super(reason);
    this.name = "DeferredCall";
  }
}

export async function loadConnection(db: Db, connectionId: string): Promise<PartnerConnection | null> {
  const [row] = await db`select * from partner_connections where id = ${connectionId}`;
  if (!row) return null;
  return {
    id: row.id,
    studioId: row.studio_id,
    provider: row.provider,
    label: row.label,
    apiBaseUrl: row.api_base_url,
    apiKey: row.api_key,
    webhookSecret: row.webhook_secret,
    consecutiveFailures: row.consecutive_failures,
    degradedSince: row.degraded_since,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastError: row.last_error,
    lastReconciledAt: row.last_reconciled_at,
  };
}

/**
 * Point de passage obligé de tout appel sortant vers un partenaire :
 * disjoncteur, budget de rate limit, puis bilan de santé de la connexion.
 */
export async function callPartner<T>(
  ctx: SyncContext,
  connection: PartnerConnection,
  call: (api: PartnerApi) => Promise<T>,
): Promise<T> {
  const now = ctx.now();

  if (connection.degradedSince && connection.lastFailureAt) {
    const nextProbe = connection.lastFailureAt.getTime() + PROBE_INTERVAL_MS;
    if (now.getTime() < nextProbe) throw new DeferredCall(new Date(nextProbe), "partenaire indisponible, en attente de sonde");
  }

  const budget = await acquireCallBudget(ctx.sql, connection.id, now);
  if (!budget.ok) throw new DeferredCall(budget.retryAt, "budget d'appels de la minute épuisé");

  try {
    const result = await call(ctx.partnerFor(connection));
    await recordSuccess(ctx, connection.id);
    return result;
  } catch (error) {
    if (error instanceof PartnerError && error.isOutage) await recordFailure(ctx, connection.id, error.message);
    throw error;
  }
}

/** Compteur par minute pleine, partagé entre toutes les instances serverless via la base. */
export async function acquireCallBudget(
  db: Db,
  connectionId: string,
  now: Date,
): Promise<{ ok: true } | { ok: false; retryAt: Date }> {
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const [row] = await db<{ calls: number }[]>`
    insert into partner_rate_windows (connection_id, window_start, calls)
    values (${connectionId}, ${windowStart}, 1)
    on conflict (connection_id, window_start) do update set calls = partner_rate_windows.calls + 1
    returning calls`;
  if (row.calls <= CALLS_PER_MINUTE_BUDGET) return { ok: true };
  // Quelques secondes après la minute suivante, pour absorber la dérive d'horloge avec Artisia.
  return { ok: false, retryAt: new Date(windowStart.getTime() + 62_000) };
}

async function recordSuccess(ctx: SyncContext, connectionId: string): Promise<void> {
  const now = ctx.now();
  const [row] = await ctx.sql<{ was_degraded: boolean }[]>`
    with before as (select degraded_since from partner_connections where id = ${connectionId} for update)
    update partner_connections p
    set consecutive_failures = 0, degraded_since = null, last_success_at = ${now}
    from before
    where p.id = ${connectionId}
    returning before.degraded_since is not null as was_degraded`;
  // Retour à la normale : on lance un rattrapage complet (webhooks perdus, ventes pendant la coupure).
  if (row?.was_degraded) await enqueueReconcile(ctx.sql, connectionId, now);
}

async function recordFailure(ctx: SyncContext, connectionId: string, message: string): Promise<void> {
  const now = ctx.now();
  await ctx.sql`
    update partner_connections
    set consecutive_failures = consecutive_failures + 1,
        last_failure_at = ${now},
        last_error = ${message},
        degraded_since = case
          when consecutive_failures + 1 >= ${FAILURES_BEFORE_DEGRADED} then coalesce(degraded_since, ${now})
          else degraded_since end
    where id = ${connectionId}`;
}
