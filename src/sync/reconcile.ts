import type { Db } from "@/lib/db";
import type { PartnerSession } from "@/partners/types";
import { raiseAlert, resolveAlert } from "./alerts";
import { callPartner, loadConnection } from "./connections";
import type { PartnerConnection, SyncContext } from "./context";
import { enqueueListingSync } from "./jobs";
import { applyPartnerObservation } from "./observations";
import { loadSlotState } from "./state";

/** Fréquence de la réconciliation de routine ; elle est aussi lancée au retour d'une panne. */
export const RECONCILE_INTERVAL_MS = 5 * 60_000;

const EXTERNAL_REF = /^daisy_slot_([0-9a-f-]{36})$/i;

export function externalRefForSlot(slotId: string): string {
  return `daisy_slot_${slotId}`;
}

/**
 * Filet de sécurité contre les webhooks perdus : Artisia n'offre pas de « quoi de neuf depuis »,
 * mais `GET /sessions` donne l'état courant de toutes les sessions en UN appel par atelier.
 * On compare, on corrige ce qui peut l'être, on signale le reste.
 */
export async function reconcileConnection(ctx: SyncContext, connectionId: string): Promise<{ sessions: number }> {
  const connection = await loadConnection(ctx.sql, connectionId);
  if (!connection) return { sessions: 0 };

  const sessions = await callPartner(ctx, connection, (api) => api.listSessions());
  for (const session of sessions) {
    await reconcileSession(ctx, connection, session);
  }
  await ctx.sql`update partner_connections set last_reconciled_at = ${ctx.now()} where id = ${connectionId}`;
  return { sessions: sessions.length };
}

async function reconcileSession(ctx: SyncContext, connection: PartnerConnection, session: PartnerSession): Promise<void> {
  const now = ctx.now();
  await ctx.sql.begin(async (tx) => {
    const [listing] = await tx<{ id: string; slot_id: string }[]>`
      select id, slot_id from listings
      where connection_id = ${connection.id} and external_session_id = ${session.sessionId}`;

    if (!listing) {
      await linkOrReportSession(tx, connection, session, now);
      return;
    }

    const slot = await loadSlotState(tx, listing.slot_id, { lock: true });
    const state = slot?.listings.find((l) => l.id === listing.id);
    if (!slot || !state) return;

    // L'instantané a pu être dépassé pendant qu'on le parcourait (un PATCH a répondu entre-temps) :
    // dans ce cas on n'en tire rien, la prochaine réconciliation le fera.
    const { fresh } = await applyPartnerObservation(
      tx,
      listing.id,
      { capacity: session.capacity, booked: session.booked, status: session.status, updatedAt: session.updatedAt },
      { fromOwnPatch: false, now },
    );
    if (!fresh) return;

    // Écart entre ce que le partenaire annonce et les réservations que Daisy a reçues.
    const missing = session.booked - state.knownBooked;
    const missingKey = `unknown_partner_bookings:${listing.id}`;
    const phantomKey = `missing_partner_cancellations:${listing.id}`;
    if (missing > 0) {
      // Webhook de réservation perdu : la place est comptée (partner_booked), il manque le client.
      await raiseAlert(tx, {
        studioId: connection.studioId,
        slotId: slot.id,
        connectionId: connection.id,
        kind: "unknown_partner_bookings",
        message:
          `${connection.label} annonce ${session.booked} place(s) vendue(s), Daisy n'en connaît que ${state.knownBooked}. ` +
          `Les places sont bien bloquées ; les coordonnées des ${missing} client(s) manquant(s) sont à récupérer sur ${connection.label}.`,
        dedupeKey: missingKey,
      });
    } else if (missing < 0) {
      // Webhook d'annulation perdu : Daisy garde une réservation fantôme. Sans danger (elle bloque
      // une place au lieu d'en ouvrir une), mais la liste des participants est fausse.
      await raiseAlert(tx, {
        studioId: connection.studioId,
        slotId: slot.id,
        connectionId: connection.id,
        kind: "missing_partner_cancellations",
        message:
          `Daisy compte ${state.knownBooked} place(s) vendue(s) sur ${connection.label}, qui n'en annonce plus que ${session.booked}. ` +
          `Une annulation ne nous est probablement pas parvenue : vérifiez la liste des participants sur ${connection.label}.`,
        dedupeKey: phantomKey,
      });
    }
    if (missing <= 0) await resolveAlert(tx, missingKey, now);
    if (missing >= 0) await resolveAlert(tx, phantomKey, now);

    await enqueueListingSync(tx, listing.id, now);
  });
}

/**
 * Session inconnue : si son `external_ref` désigne un de nos créneaux, on crée la publication.
 * Sinon (créée à la main chez le partenaire, `external_ref` null), Daisy ne la pilote pas :
 * ses places échappent à l'allotement, l'artisan doit le savoir.
 */
async function linkOrReportSession(
  tx: Db,
  connection: PartnerConnection,
  session: PartnerSession,
  now: Date,
): Promise<void> {
  const slotId = session.externalRef?.match(EXTERNAL_REF)?.[1];
  const [slot] = slotId
    ? await tx`select id from slots where id = ${slotId} and studio_id = ${connection.studioId} for update`
    : [];

  if (!slot) {
    if (session.status === "published" && session.startsAt.getTime() > now.getTime()) {
      await raiseAlert(tx, {
        studioId: connection.studioId,
        connectionId: connection.id,
        kind: "unlinked_session",
        message:
          `La session « ${session.title} » du ${session.startsAt.toISOString()} existe sur ${connection.label} ` +
          `sans être reliée à un créneau Daisy : ses places ne sont pas protégées contre la surréservation.`,
        dedupeKey: `unlinked_session:${connection.id}:${session.sessionId}`,
      });
    }
    return;
  }

  const [listing] = await tx<{ id: string }[]>`
    insert into listings (slot_id, connection_id, external_session_id, confirmed_capacity, partner_booked,
                          partner_status, partner_updated_at, last_synced_at)
    values (${slot.id}, ${connection.id}, ${session.sessionId}, ${session.capacity}, ${session.booked},
            ${session.status}, ${session.updatedAt}, ${now})
    on conflict do nothing
    returning id`;
  if (listing) await enqueueListingSync(tx, listing.id, now);
}
