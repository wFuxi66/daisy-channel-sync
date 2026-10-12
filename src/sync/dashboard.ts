import type { Db } from "@/lib/db";
import { bookedOnPartner, computeAvailability, heldByPartner, type Availability } from "./allocation";
import { loadSlotStates } from "./state";

/** Ce que voit l'artisan : état des connexions, des créneaux par canal, et ce qui demande son attention. */

export type ConnectionHealth = "ok" | "unstable" | "offline";

export interface ConnectionView {
  id: string;
  label: string;
  health: ConnectionHealth;
  degradedSince: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastReconciledAt: Date | null;
  pendingSyncs: number;
}

export type ListingSyncState = "synced" | "pending" | "unconfirmed";

export interface ChannelView {
  listingId: string;
  connectionId: string;
  label: string;
  sold: number;
  /** Capacité publiée chez le partenaire, telle que confirmée par lui. */
  publishedCapacity: number;
  /** Places invendues que le partenaire peut vendre en ce moment. */
  onSale: number;
  syncState: ListingSyncState;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
}

export interface SlotView {
  id: string;
  title: string;
  startsAt: Date;
  capacity: number;
  status: "scheduled" | "cancelled";
  availability: Availability;
  channels: ChannelView[];
}

export interface AlertView {
  id: string;
  kind: string;
  message: string;
  slotId: string | null;
  createdAt: Date;
}

export interface Dashboard {
  studio: { id: string; name: string; partnerWindow: number };
  connections: ConnectionView[];
  slots: SlotView[];
  alerts: AlertView[];
}

export async function getDashboard(db: Db, studioId: string, now: Date): Promise<Dashboard | null> {
  const [studio] = await db<{ id: string; name: string; partner_window: number }[]>`
    select id, name, partner_window from studios where id = ${studioId}`;
  if (!studio) return null;

  const connections = await db`
    select c.*, (select count(*) from sync_jobs j where j.connection_id = c.id)::int as pending_syncs
    from partner_connections c where c.studio_id = ${studioId} order by c.created_at`;

  const slotRows = await db<{ id: string; title: string }[]>`
    select id, title from slots
    where studio_id = ${studioId} and starts_at > ${new Date(now.getTime() - 24 * 3600_000)}
    order by starts_at limit 100`;
  const states = await loadSlotStates(db, slotRows.map((s) => s.id));

  const listingMeta = await db<{ id: string; last_synced_at: Date | null; last_sync_error: string | null; has_job: boolean }[]>`
    select l.id, l.last_synced_at, l.last_sync_error,
           exists (select 1 from sync_jobs j where j.listing_id = l.id) as has_job
    from listings l where l.slot_id = any(${slotRows.map((s) => s.id)}::uuid[])`;
  const metaById = new Map(listingMeta.map((m) => [m.id, m]));
  const labelByConnection = new Map(connections.map((c) => [c.id as string, c.label as string]));

  const alerts = await db<{ id: string; kind: string; message: string; slot_id: string | null; created_at: Date }[]>`
    select id, kind, message, slot_id, created_at from alerts
    where studio_id = ${studioId} and resolved_at is null order by created_at desc`;

  return {
    studio: { id: studio.id, name: studio.name, partnerWindow: studio.partner_window },
    connections: connections.map((c) => ({
      id: c.id,
      label: c.label,
      health: c.degraded_since ? "offline" : c.consecutive_failures > 0 ? "unstable" : "ok",
      degradedSince: c.degraded_since,
      lastSuccessAt: c.last_success_at,
      lastError: c.last_error,
      lastReconciledAt: c.last_reconciled_at,
      pendingSyncs: c.pending_syncs,
    })),
    slots: states.map((slot) => ({
      id: slot.id,
      title: slotRows.find((s) => s.id === slot.id)!.title,
      startsAt: slot.startsAt,
      capacity: slot.capacity,
      status: slot.status,
      availability: computeAvailability(slot, now),
      channels: slot.listings.map((l) => {
        const meta = metaById.get(l.id);
        const sold = bookedOnPartner(l);
        return {
          listingId: l.id,
          connectionId: l.connectionId,
          label: labelByConnection.get(l.connectionId) ?? "Partenaire",
          sold,
          publishedCapacity: l.confirmedCapacity,
          onSale: Math.max(0, heldByPartner(l) - sold),
          syncState: l.inflightCapacity !== null ? "unconfirmed" : meta?.has_job ? "pending" : "synced",
          lastSyncedAt: meta?.last_synced_at ?? null,
          lastSyncError: meta?.last_sync_error ?? null,
        };
      }),
    })),
    alerts: alerts.map((a) => ({ id: a.id, kind: a.kind, message: a.message, slotId: a.slot_id, createdAt: a.created_at })),
  };
}
