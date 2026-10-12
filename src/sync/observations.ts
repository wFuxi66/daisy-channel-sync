import type { Db } from "@/lib/db";
import { raiseAlert } from "./alerts";

/** État d'une session tel que vu chez le partenaire, horodaté par SON horloge. */
export interface PartnerObservation {
  capacity: number;
  booked: number;
  status: string;
  updatedAt: Date;
}

/**
 * Applique une observation de session, d'où qu'elle vienne : réponse à un PATCH, GET /sessions
 * ou webhook session.updated. Les trois peuvent arriver dans n'importe quel ordre ; seule une
 * observation au moins aussi récente que la dernière connue est prise en compte.
 * On compare l'horloge d'Artisia à elle-même, jamais à la nôtre (elle dérive).
 *
 * `fromOwnPatch` : c'est la réponse à NOTRE envoi, l'incertitude « en vol » est donc levée.
 * Même si la réponse est plus ancienne qu'une observation déjà reçue, cette dernière inclut
 * forcément l'effet de notre PATCH : la lever reste sûr.
 */
export async function applyPartnerObservation(
  db: Db,
  listingId: string,
  observation: PartnerObservation,
  options: { fromOwnPatch: boolean; now: Date },
): Promise<{ fresh: boolean }> {
  const [before] = await db<
    {
      slot_id: string;
      connection_id: string;
      studio_id: string;
      label: string;
      external_session_id: string;
      confirmed_capacity: number;
      inflight_capacity: number | null;
      partner_updated_at: Date | null;
    }[]
  >`
    select l.slot_id, l.connection_id, c.studio_id, c.label, l.external_session_id,
           l.confirmed_capacity, l.inflight_capacity, l.partner_updated_at
    from listings l join partner_connections c on c.id = l.connection_id
    where l.id = ${listingId}
    for update of l`;
  if (!before) return { fresh: false };

  const fresh = !before.partner_updated_at || observation.updatedAt.getTime() >= before.partner_updated_at.getTime();
  if (fresh) {
    await db`
      update listings
      set confirmed_capacity = ${observation.capacity}, partner_booked = ${observation.booked},
          partner_status = ${observation.status}, partner_updated_at = ${observation.updatedAt}
      where id = ${listingId}`;

    // Capacité différente alors qu'on n'avait rien envoyé : elle a changé sans nous.
    const drifted = before.inflight_capacity === null && observation.capacity !== before.confirmed_capacity;
    if (drifted && !options.fromOwnPatch) {
      await raiseAlert(db, {
        studioId: before.studio_id,
        slotId: before.slot_id,
        connectionId: before.connection_id,
        kind: "capacity_drift",
        message:
          `La capacité de la session ${before.external_session_id} a changé sur ${before.label} sans passer par Daisy ` +
          `(${before.confirmed_capacity} → ${observation.capacity}). Daisy la réaligne automatiquement ; ` +
          `pour changer le nombre de places, modifiez-le dans Daisy.`,
        dedupeKey: `capacity_drift:${listingId}`,
      });
    }
  }

  if (options.fromOwnPatch) {
    await db`
      update listings set inflight_capacity = null, last_synced_at = ${options.now}, last_sync_error = null
      where id = ${listingId}`;
  }
  return { fresh };
}
