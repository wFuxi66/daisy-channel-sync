import type { Db, Sql } from "@/lib/db";
import { computeAvailability, isOnSale, type SlotState } from "./allocation";
import { raiseAlert, resolveAlert } from "./alerts";
import { enqueueSlotSync } from "./jobs";
import { loadSlotState } from "./state";

export class BookingRefused extends Error {
  constructor(
    readonly code: "slot_full" | "slot_cancelled" | "slot_started" | "slot_not_found",
    readonly available: number = 0,
  ) {
    super(code);
    this.name = "BookingRefused";
  }
}

export interface DirectBookingInput {
  slotId: string;
  seats: number;
  customerName: string;
  customerEmail: string;
}

/**
 * Réservation prise sur Daisy (widget, back-office).
 *
 * Le créneau est verrouillé le temps de vérifier et d'écrire : deux réservations concurrentes
 * sur la dernière place sont sérialisées, la seconde voit 0 place et reçoit `slot_full`.
 * Aucun appel partenaire ici : les places du pool direct appartiennent à Daisy seule,
 * la vente ne dépend donc ni de la latence ni de la disponibilité des partenaires.
 */
export async function bookDirect(sql: Sql, input: DirectBookingInput, now: Date): Promise<{ bookingId: string }> {
  if (!Number.isInteger(input.seats) || input.seats <= 0) throw new RangeError("seats doit être un entier positif");

  return sql.begin(async (tx) => {
    const slot = await loadSlotState(tx, input.slotId, { lock: true });
    if (!slot) throw new BookingRefused("slot_not_found");
    if (slot.status === "cancelled") throw new BookingRefused("slot_cancelled");
    if (!isOnSale(slot, now)) throw new BookingRefused("slot_started");

    const { directAvailable } = computeAvailability(slot, now);
    if (input.seats > directAvailable) throw new BookingRefused("slot_full", directAvailable);

    const [booking] = await tx<{ id: string }[]>`
      insert into bookings (slot_id, channel, seats, customer_name, customer_email)
      values (${input.slotId}, 'direct', ${input.seats}, ${input.customerName}, ${input.customerEmail})
      returning id`;
    // Moins de places restantes : les vitrines partenaires doivent peut-être rétrécir.
    await enqueueSlotSync(tx, input.slotId, now);
    return { bookingId: booking.id };
  });
}

/**
 * L'artisan change la capacité dans Daisy, à la hausse comme à la baisse, y compris sous
 * le nombre de places déjà vendues (atelier qui perd un tour, par exemple) : c'est sa décision,
 * on l'applique et on signale la surréservation qui en résulte plutôt que de la refuser.
 */
export async function updateSlotCapacity(sql: Sql, slotId: string, capacity: number, now: Date): Promise<void> {
  if (!Number.isInteger(capacity) || capacity < 0) throw new RangeError("capacity doit être un entier positif ou nul");
  await sql.begin(async (tx) => {
    const slot = await loadSlotState(tx, slotId, { lock: true });
    if (!slot) throw new BookingRefused("slot_not_found");
    await tx`update slots set capacity = ${capacity}, updated_at = ${now} where id = ${slotId}`;
    await checkOverbooking(tx, { ...slot, capacity }, now);
    await enqueueSlotSync(tx, slotId, now);
  });
}

/** Annulation d'un créneau (fermeture pour vacances, etc.) : les partenaires ferment la session. */
export async function cancelSlot(sql: Sql, slotId: string, now: Date): Promise<void> {
  await sql.begin(async (tx) => {
    const slot = await loadSlotState(tx, slotId, { lock: true });
    if (!slot) throw new BookingRefused("slot_not_found");
    await tx`update slots set status = 'cancelled', updated_at = ${now} where id = ${slotId}`;
    await enqueueSlotSync(tx, slotId, now);
  });
}

/**
 * Surréservation avérée = plus de places VENDUES que de places réelles.
 * Le système ne choisit pas qui annuler : il prévient l'artisan avec les éléments pour décider.
 */
export async function checkOverbooking(db: Db, slot: SlotState, now: Date): Promise<void> {
  const availability = computeAvailability(slot, now);
  const dedupeKey = `overbooked:${slot.id}`;
  if (availability.overbookedBy > 0) {
    await raiseAlert(db, {
      studioId: slot.studioId,
      slotId: slot.id,
      kind: "overbooked",
      message:
        `${availability.overbookedBy} place(s) vendue(s) au-delà de la capacité ` +
        `(${availability.soldDirect} en direct, ${availability.soldPartners} via partenaires, capacité ${slot.capacity}).`,
      dedupeKey,
    });
  } else {
    await resolveAlert(db, dedupeKey, now);
  }
}
