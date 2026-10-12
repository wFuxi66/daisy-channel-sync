import type { Db } from "@/lib/db";

export interface SyncJob {
  id: string;
  kind: "sync_listing" | "reconcile_connection";
  listing_id: string | null;
  connection_id: string;
  generation: number;
  attempts: number;
}

/** Durée du bail d'un worker sur un job ; doit dépasser largement le timeout d'un appel partenaire. */
const LEASE_SECONDS = 60;

/**
 * Demande une synchro de toutes les publications d'un créneau.
 * À appeler dans la même transaction que la modification qui la motive (pattern outbox) :
 * si la transaction échoue, la demande disparaît avec elle ; si elle réussit, la demande existe.
 */
export async function enqueueSlotSync(db: Db, slotId: string, now: Date): Promise<void> {
  await db`
    insert into sync_jobs (kind, listing_id, connection_id, priority_at, run_after)
    select 'sync_listing', l.id, l.connection_id, s.starts_at, ${now}
    from listings l join slots s on s.id = l.slot_id
    where l.slot_id = ${slotId}
    on conflict (listing_id) where kind = 'sync_listing'
    do update set generation = sync_jobs.generation + 1,
                  run_after = least(sync_jobs.run_after, excluded.run_after)`;
}

export async function enqueueListingSync(db: Db, listingId: string, now: Date): Promise<void> {
  await db`
    insert into sync_jobs (kind, listing_id, connection_id, priority_at, run_after)
    select 'sync_listing', l.id, l.connection_id, s.starts_at, ${now}
    from listings l join slots s on s.id = l.slot_id
    where l.id = ${listingId}
    on conflict (listing_id) where kind = 'sync_listing'
    do update set generation = sync_jobs.generation + 1,
                  run_after = least(sync_jobs.run_after, excluded.run_after)`;
}

export async function enqueueReconcile(db: Db, connectionId: string, now: Date): Promise<void> {
  await db`
    insert into sync_jobs (kind, connection_id, priority_at, run_after)
    values ('reconcile_connection', ${connectionId}, ${now}, ${now})
    on conflict (connection_id) where kind = 'reconcile_connection'
    do update set generation = sync_jobs.generation + 1,
                  run_after = least(sync_jobs.run_after, excluded.run_after)`;
}

/**
 * Réserve des jobs échus. SKIP LOCKED : deux workers concurrents ne prennent jamais le même job,
 * et une publication donnée n'est donc synchronisée que par un seul worker à la fois.
 */
export async function claimJobs(db: Db, now: Date, limit: number): Promise<SyncJob[]> {
  const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000);
  return db<SyncJob[]>`
    update sync_jobs set locked_until = ${leaseUntil}
    where id in (
      select id from sync_jobs
      where run_after <= ${now} and (locked_until is null or locked_until < ${now})
      order by priority_at, run_after
      limit ${limit}
      for update skip locked)
    returning id, kind, listing_id, connection_id, generation, attempts`;
}

/**
 * Termine un job. S'il a été redemandé pendant qu'on le traitait (generation a bougé),
 * on ne le supprime pas : on le remet en file pour prendre en compte la nouvelle demande.
 */
export async function completeJob(db: Db, job: SyncJob, now: Date): Promise<void> {
  const deleted = await db`delete from sync_jobs where id = ${job.id} and generation = ${job.generation}`;
  if (deleted.count === 0) {
    await db`update sync_jobs set locked_until = null, attempts = 0, last_error = null, run_after = ${now}
             where id = ${job.id}`;
  }
}

/** Replanifie après un échec (compte comme une tentative) ou un report (pas une tentative). */
export async function rescheduleJob(
  db: Db,
  job: SyncJob,
  runAfter: Date,
  error: string,
  opts: { countAttempt: boolean },
): Promise<void> {
  await db`
    update sync_jobs
    set locked_until = null,
        run_after = ${runAfter},
        attempts = attempts + ${opts.countAttempt ? 1 : 0},
        last_error = ${error}
    where id = ${job.id}`;
}

/** Backoff exponentiel plafonné à 5 minutes, avec gigue pour ne pas synchroniser les relances. */
export function backoffDelayMs(attempts: number, random: number = Math.random()): number {
  const base = Math.min(5 * 60_000, 10_000 * 2 ** attempts);
  return Math.round(base * (0.5 + random / 2));
}
