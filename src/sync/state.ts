import type { Db } from "@/lib/db";
import type { ListingState, SlotState } from "./allocation";

interface SlotRow {
  id: string;
  studio_id: string;
  capacity: number;
  status: "scheduled" | "cancelled";
  starts_at: Date;
  partner_window: number;
  direct_sold: number;
}

interface ListingRow {
  id: string;
  slot_id: string;
  connection_id: string;
  external_session_id: string;
  confirmed_capacity: number;
  inflight_capacity: number | null;
  partner_booked: number;
  partner_status: string;
  known_booked: number;
}

/**
 * Charge l'état d'un créneau. Avec `lock`, la ligne du créneau est verrouillée (FOR UPDATE)
 * jusqu'à la fin de la transaction : c'est LE point de sérialisation de toutes les écritures
 * qui touchent aux places de ce créneau (réservations, capacités, allotements).
 */
export async function loadSlotState(db: Db, slotId: string, opts: { lock: boolean }): Promise<SlotState | null> {
  if (opts.lock) {
    // Verrou d'abord, agrégats ensuite : les sommes sont lues une fois le verrou obtenu.
    const locked = await db`select id from slots where id = ${slotId} for update`;
    if (locked.length === 0) return null;
  }
  const states = await loadSlotStates(db, [slotId]);
  return states[0] ?? null;
}

/** Version par lot, sans verrou, pour les écrans. */
export async function loadSlotStates(db: Db, slotIds: string[]): Promise<SlotState[]> {
  if (slotIds.length === 0) return [];

  const slots = await db<SlotRow[]>`
    select s.id, s.studio_id, s.capacity, s.status, s.starts_at, st.partner_window,
           coalesce((select sum(b.seats) from bookings b
                     where b.slot_id = s.id and b.channel = 'direct' and b.status = 'confirmed'), 0)::int as direct_sold
    from slots s
    join studios st on st.id = s.studio_id
    where s.id = any(${slotIds}::uuid[])
    order by s.starts_at`;

  const listings = await db<ListingRow[]>`
    select l.id, l.slot_id, l.connection_id, l.external_session_id, l.confirmed_capacity,
           l.inflight_capacity, l.partner_booked, l.partner_status,
           coalesce((select sum(b.seats) from bookings b
                     where b.slot_id = l.slot_id and b.connection_id = l.connection_id
                       and b.status = 'confirmed'), 0)::int as known_booked
    from listings l
    where l.slot_id = any(${slotIds}::uuid[])
    order by l.created_at, l.id`;

  return slots.map((s) => ({
    id: s.id,
    studioId: s.studio_id,
    capacity: s.capacity,
    status: s.status,
    startsAt: s.starts_at,
    partnerWindow: s.partner_window,
    directSold: s.direct_sold,
    listings: listings.filter((l) => l.slot_id === s.id).map(toListingState),
  }));
}

function toListingState(row: ListingRow): ListingState {
  return {
    id: row.id,
    connectionId: row.connection_id,
    externalSessionId: row.external_session_id,
    confirmedCapacity: row.confirmed_capacity,
    inflightCapacity: row.inflight_capacity,
    partnerBooked: row.partner_booked,
    partnerStatus: row.partner_status,
    knownBooked: row.known_booked,
  };
}
