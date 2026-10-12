import { PartnerError, type PartnerSession } from "@/partners/types";
import { planListingUpdate } from "./allocation";
import { callPartner, loadConnection } from "./connections";
import type { SyncContext } from "./context";
import { enqueueListingSync } from "./jobs";
import { applyPartnerObservation } from "./observations";
import { loadSlotState } from "./state";

export type ListingSyncResult = "in_sync" | "updated" | "conflict";

/**
 * Aligne la capacité d'une publication partenaire sur la cible d'allotement.
 *
 * 1. Décision, dans une transaction courte avec le créneau verrouillé : on calcule la capacité
 *    voulue et on l'inscrit comme « en vol » AVANT d'appeler. Si on donne des places,
 *    elles quittent le pool direct dès ce commit.
 * 2. Appel au partenaire, hors transaction : on ne tient jamais un verrou pendant un appel réseau.
 * 3. Bilan : une réponse 200 fait foi et lève l'incertitude. Un timeout ou une 500 la laissent
 *    en place, et le job sera rejoué. Le PATCH porte une valeur absolue : le rejouer est sans risque.
 */
export async function syncListing(ctx: SyncContext, listingId: string): Promise<ListingSyncResult> {
  const decision = await ctx.sql.begin(async (tx) => {
    const [ref] = await tx<{ slot_id: string }[]>`select slot_id from listings where id = ${listingId}`;
    if (!ref) return null;
    const slot = await loadSlotState(tx, ref.slot_id, { lock: true });
    const listing = slot?.listings.find((l) => l.id === listingId);
    if (!slot || !listing) return null;

    const plan = planListingUpdate(slot, listing, ctx.now());
    if (!plan) return null;

    await tx`
      update listings
      set inflight_capacity = greatest(coalesce(inflight_capacity, 0), ${plan.capacity})
      where id = ${listingId}`;
    return { plan, connectionId: listing.connectionId, sessionId: listing.externalSessionId };
  });
  if (!decision) return "in_sync";

  const connection = await loadConnection(ctx.sql, decision.connectionId);
  if (!connection) return "in_sync";

  try {
    const session = await callPartner(ctx, connection, (api) =>
      api.updateSession(decision.sessionId, {
        capacity: decision.plan.capacity,
        ...(decision.plan.status ? { status: decision.plan.status } : {}),
      }),
    );
    await applyConfirmedSession(ctx, listingId, session);
    return "updated";
  } catch (error) {
    if (error instanceof PartnerError && error.kind === "conflict") {
      await applyConflict(ctx, listingId, error);
      return "conflict";
    }
    await ctx.sql`update listings set last_sync_error = ${errorMessage(error)} where id = ${listingId}`;
    throw error;
  }
}

/** Réponse 200 : l'état réel de la session après notre PATCH. L'incertitude est levée. */
async function applyConfirmedSession(ctx: SyncContext, listingId: string, session: PartnerSession): Promise<void> {
  const now = ctx.now();
  await ctx.sql.begin((tx) =>
    applyPartnerObservation(
      tx,
      listingId,
      { capacity: session.capacity, booked: session.booked, status: session.status, updatedAt: session.updatedAt },
      { fromOwnPatch: true, now },
    ),
  );
}

/**
 * 409 capacity_below_booked : le partenaire a vendu plus que ce que l'on savait
 * (webhook en retard ou perdu). Le PATCH n'a pas été appliqué ; on apprend le vrai `booked`
 * et on recalcule tout de suite. On ne lève PAS l'incertitude d'éventuels envois précédents.
 */
async function applyConflict(ctx: SyncContext, listingId: string, error: PartnerError): Promise<void> {
  const body = error.body as { error?: string; booked?: number } | undefined;
  const booked = typeof body?.booked === "number" ? body.booked : null;
  // Sans `booked`, rejouer tout de suite produirait le même refus : on laisse le backoff agir.
  if (booked === null) throw error;
  await ctx.sql.begin(async (tx) => {
    await tx`
      update listings
      set partner_booked = greatest(partner_booked, ${booked}),
          -- Il a vendu ce nombre de places : sa capacité réelle est au moins celle-là.
          confirmed_capacity = greatest(confirmed_capacity, ${booked}),
          last_sync_error = ${`refus du partenaire : ${body?.error ?? "conflict"}`}
      where id = ${listingId}`;
    await enqueueListingSync(tx, listingId, ctx.now());
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
