import type postgres from "postgres";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { verifyArtisiaSignature } from "@/partners/artisia/signature";
import { raiseAlert } from "./alerts";
import { checkOverbooking } from "./bookings";
import { loadConnection } from "./connections";
import type { SyncContext } from "./context";
import { enqueueListingSync, enqueueReconcile, enqueueSlotSync } from "./jobs";
import { applyPartnerObservation } from "./observations";
import { loadSlotState } from "./state";

/** Au-delà, l'événement est considéré comme empoisonné : on alerte et on arrête de le rejouer. */
export const MAX_EVENT_ATTEMPTS = 10;

const envelopeSchema = z.object({
  event_id: z.string().min(1),
  type: z.string().min(1),
  occurred_at: z.string().nullish(),
  data: z.unknown(),
});

const bookingDataSchema = z.object({
  booking_id: z.string().min(1),
  session_id: z.string().min(1),
  // Hypothèse : présent aussi sur booking.cancelled. Sinon le tombstone prend 1 (il ne compte pas).
  seats: z.number().int().positive().optional(),
  customer: z.object({ name: z.string().nullish(), email: z.string().nullish() }).nullish(),
});

const sessionDataSchema = z.object({
  session_id: z.string().min(1),
  capacity: z.number().int().nonnegative(),
  booked: z.number().int().nonnegative(),
  status: z.string(),
  updated_at: z.coerce.date(),
});

export interface WebhookResponse {
  status: number;
  body: { received: boolean; duplicate?: boolean; error?: string };
}

/**
 * Réception d'un webhook Artisia. Objectif : répondre 2xx bien avant les 5 s du partenaire.
 * Ordre : signature → stockage dédupliqué → traitement (base uniquement, quelques ms).
 * Si le traitement échoue, l'événement reste dans l'inbox et le cron le rejouera :
 * on répond quand même 200, car l'événement est en lieu sûr chez nous.
 */
export async function handleArtisiaWebhook(
  ctx: SyncContext,
  connectionId: string,
  rawBody: string,
  signature: string | null,
): Promise<WebhookResponse> {
  if (!z.uuid().safeParse(connectionId).success) return { status: 404, body: { received: false, error: "unknown_connection" } };
  const connection = await loadConnection(ctx.sql, connectionId);
  if (!connection) return { status: 404, body: { received: false, error: "unknown_connection" } };

  if (!verifyArtisiaSignature(rawBody, signature, connection.webhookSecret)) {
    return { status: 401, body: { received: false, error: "invalid_signature" } };
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { received: false, error: "invalid_json" } };
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return { status: 400, body: { received: false, error: "invalid_envelope" } };

  const stored = await storeEvent(ctx.sql, connectionId, envelope.data, ctx.now());
  if (!stored.duplicate) {
    try {
      await processEvent(ctx, stored.id);
    } catch (error) {
      console.error("webhook stocké mais non traité, le cron le rejouera", { eventId: stored.id, error });
    }
  }
  return { status: 200, body: { received: true, duplicate: stored.duplicate } };
}

/**
 * La déduplication : contrainte unique (connection_id, event_id).
 * Un doublon ne fait qu'incrémenter `delivery_count` (utile pour observer le partenaire).
 */
export async function storeEvent(
  db: Db,
  connectionId: string,
  envelope: z.infer<typeof envelopeSchema>,
  now: Date,
): Promise<{ id: string; duplicate: boolean }> {
  const occurredAt = envelope.occurred_at ? new Date(envelope.occurred_at) : null;
  const [row] = await db<{ id: string; delivery_count: number }[]>`
    insert into inbound_events (connection_id, event_id, type, occurred_at, payload, received_at)
    values (${connectionId}, ${envelope.event_id}, ${envelope.type},
            ${occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null},
            ${db.json(envelope as postgres.JSONValue)}, ${now})
    on conflict (connection_id, event_id)
    do update set delivery_count = inbound_events.delivery_count + 1
    returning id, delivery_count`;
  return { id: row.id, duplicate: row.delivery_count > 1 };
}

interface EventRow {
  id: string;
  connection_id: string;
  type: string;
  payload: { data: unknown };
  attempts: number;
}

type Outcome = { done: true } | { done: false; reason: string };

/**
 * Applique un événement de l'inbox. Tout se fait dans une transaction : soit l'événement est
 * marqué traité ET ses effets sont écrits, soit rien. SKIP LOCKED évite que le webhook et le cron
 * traitent le même événement en même temps.
 */
export async function processEvent(ctx: SyncContext, eventRowId: string): Promise<"processed" | "pending" | "skipped"> {
  const now = ctx.now();
  return ctx.sql.begin(async (tx) => {
    const [event] = await tx<EventRow[]>`
      select id, connection_id, type, payload, attempts from inbound_events
      where id = ${eventRowId} and processed_at is null
      for update skip locked`;
    if (!event) return "skipped";

    let outcome: Outcome;
    try {
      // Savepoint : une erreur annule les effets de l'événement, pas la mise à jour du compteur.
      outcome = await tx.savepoint((sp) => applyEvent(sp, event, now));
    } catch (error) {
      outcome = { done: false, reason: error instanceof Error ? error.message : String(error) };
    }

    if (outcome.done) {
      await tx`update inbound_events set processed_at = ${now}, last_error = null where id = ${event.id}`;
      return "processed";
    }

    await tx`update inbound_events set attempts = attempts + 1, last_error = ${outcome.reason} where id = ${event.id}`;
    if (event.attempts + 1 >= MAX_EVENT_ATTEMPTS) {
      const [conn] = await tx<{ studio_id: string }[]>`select studio_id from partner_connections where id = ${event.connection_id}`;
      await raiseAlert(tx, {
        studioId: conn.studio_id,
        connectionId: event.connection_id,
        kind: "event_failed",
        message: `Un événement partenaire (${event.type}) n'a pas pu être traité : ${outcome.reason}`,
        dedupeKey: `event_failed:${event.id}`,
      });
    }
    return "pending";
  });
}

async function applyEvent(db: Db, event: EventRow, now: Date): Promise<Outcome> {
  switch (event.type) {
    case "booking.created":
    case "booking.cancelled":
      return applyBookingEvent(db, event, now);
    case "session.updated":
      return applySessionUpdated(db, event, now);
    default:
      // Type inconnu : conservé dans l'inbox pour analyse, sans effet.
      return { done: true };
  }
}

async function findListing(db: Db, connectionId: string, sessionId: string): Promise<{ id: string; slot_id: string } | null> {
  const [row] = await db<{ id: string; slot_id: string }[]>`
    select id, slot_id from listings where connection_id = ${connectionId} and external_session_id = ${sessionId}`;
  return row ?? null;
}

async function applyBookingEvent(db: Db, event: EventRow, now: Date): Promise<Outcome> {
  const data = bookingDataSchema.parse(event.payload.data);
  const listing = await findListing(db, event.connection_id, data.session_id);
  if (!listing) {
    // Session pas encore reliée : la réconciliation va la découvrir, on rejouera l'événement ensuite.
    await enqueueReconcile(db, event.connection_id, now);
    return { done: false, reason: `session inconnue ${data.session_id}` };
  }

  await loadSlotState(db, listing.slot_id, { lock: true });
  const seats = data.seats ?? 1;

  if (event.type === "booking.created") {
    // Si l'annulation est arrivée avant (désordre), le tombstone existe déjà : on ne ressuscite pas.
    await db`
      insert into bookings (slot_id, channel, connection_id, external_booking_id, seats, customer_name, customer_email, created_at)
      values (${listing.slot_id}, 'partner', ${event.connection_id}, ${data.booking_id}, ${seats},
              ${data.customer?.name ?? null}, ${data.customer?.email ?? null}, ${now})
      on conflict (connection_id, external_booking_id) do nothing`;
  } else {
    // Annulation : état terminal. Si la création n'est pas encore arrivée, on pose un tombstone.
    await db`
      insert into bookings (slot_id, channel, connection_id, external_booking_id, seats, status, created_at, cancelled_at)
      values (${listing.slot_id}, 'partner', ${event.connection_id}, ${data.booking_id}, ${seats}, 'cancelled', ${now}, ${now})
      on conflict (connection_id, external_booking_id)
      do update set status = 'cancelled', cancelled_at = coalesce(bookings.cancelled_at, excluded.cancelled_at)`;
  }

  const slot = await loadSlotState(db, listing.slot_id, { lock: false });
  if (slot) await checkOverbooking(db, slot, now);
  // Les ventes ont bougé : on recalcule les vitrines de tous les canaux du créneau.
  await enqueueSlotSync(db, listing.slot_id, now);
  return { done: true };
}

async function applySessionUpdated(db: Db, event: EventRow, now: Date): Promise<Outcome> {
  const data = sessionDataSchema.parse(event.payload.data);
  const listing = await findListing(db, event.connection_id, data.session_id);
  if (!listing) {
    await enqueueReconcile(db, event.connection_id, now);
    return { done: true };
  }

  await loadSlotState(db, listing.slot_id, { lock: true });
  const { fresh } = await applyPartnerObservation(
    db,
    listing.id,
    { capacity: data.capacity, booked: data.booked, status: data.status, updatedAt: data.updated_at },
    { fromOwnPatch: false, now },
  );
  if (fresh) await enqueueListingSync(db, listing.id, now);
  return { done: true };
}

/** Rejoue les événements restés en attente (traitement échoué, session pas encore reliée). */
export async function processPendingEvents(ctx: SyncContext, limit = 100): Promise<number> {
  const rows = await ctx.sql<{ id: string }[]>`
    select id from inbound_events
    where processed_at is null and attempts < ${MAX_EVENT_ATTEMPTS}
    order by received_at limit ${limit}`;
  let processed = 0;
  for (const row of rows) {
    if ((await processEvent(ctx, row.id)) === "processed") processed++;
  }
  return processed;
}
