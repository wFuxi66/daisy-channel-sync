import type { Db } from "@/lib/db";

export type AlertKind =
  | "overbooked"
  | "unknown_partner_bookings"
  | "missing_partner_cancellations"
  | "capacity_drift"
  | "unlinked_session"
  | "event_failed";

/** Une alerte ouverte par clé : la relever à nouveau met simplement son message à jour. */
export async function raiseAlert(
  db: Db,
  alert: {
    studioId: string;
    slotId?: string | null;
    connectionId?: string | null;
    kind: AlertKind;
    message: string;
    dedupeKey: string;
  },
): Promise<void> {
  await db`
    insert into alerts (studio_id, slot_id, connection_id, kind, message, dedupe_key)
    values (${alert.studioId}, ${alert.slotId ?? null}, ${alert.connectionId ?? null},
            ${alert.kind}, ${alert.message}, ${alert.dedupeKey})
    on conflict (dedupe_key) where resolved_at is null do update set message = excluded.message`;
}

export async function resolveAlert(db: Db, dedupeKey: string, now: Date): Promise<void> {
  await db`update alerts set resolved_at = ${now} where dedupe_key = ${dedupeKey} and resolved_at is null`;
}
