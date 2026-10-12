"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { bookDirect, BookingRefused, cancelSlot, updateSlotCapacity } from "@/sync/bookings";
import { productionContext } from "@/sync/runtime";
import { runSyncTick, runWorker } from "@/sync/worker";

// Back-office de démonstration : pas d'authentification ici. En production, chaque action
// vérifierait la session Supabase Auth et l'appartenance du créneau à l'atelier de l'utilisateur.

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** Les appels partenaires partent après la réponse : l'artisan n'attend pas Artisia. */
function syncInBackground() {
  after(() => runWorker(productionContext(), { deadlineMs: 20_000 }));
}

const bookingForm = z.object({
  slotId: z.uuid(),
  seats: z.coerce.number().int().min(1).max(10),
  customerName: z.string().trim().min(1, "Nom requis"),
  customerEmail: z.email("Email invalide"),
});

export async function bookDirectAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const input = bookingForm.safeParse(Object.fromEntries(formData));
  if (!input.success) return { ok: false, message: input.error.issues[0].message };

  try {
    await bookDirect(getSql(), input.data, new Date());
  } catch (error) {
    if (error instanceof BookingRefused) return { ok: false, message: refusalMessage(error) };
    throw error;
  }
  syncInBackground();
  refresh();
  return { ok: true, message: `Réservation confirmée : ${input.data.seats} place(s) pour ${input.data.customerName}.` };
}

function refusalMessage(error: BookingRefused): string {
  switch (error.code) {
    case "slot_full":
      return error.available > 0
        ? `Il ne reste que ${error.available} place(s) vendable(s) sur ce créneau.`
        : "Ce créneau est complet.";
    case "slot_cancelled":
      return "Ce créneau a été annulé.";
    case "slot_started":
      return "Ce créneau a déjà commencé.";
    case "slot_not_found":
      return "Créneau introuvable.";
  }
}

const capacityForm = z.object({ slotId: z.uuid(), capacity: z.coerce.number().int().min(0).max(500) });

export async function updateCapacityAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const input = capacityForm.safeParse(Object.fromEntries(formData));
  if (!input.success) return { ok: false, message: "Capacité invalide" };
  await updateSlotCapacity(getSql(), input.data.slotId, input.data.capacity, new Date());
  syncInBackground();
  refresh();
  return { ok: true, message: `Capacité passée à ${input.data.capacity}. Les partenaires sont mis à jour.` };
}

export async function cancelSlotAction(formData: FormData): Promise<void> {
  const slotId = z.uuid().parse(formData.get("slotId"));
  await cancelSlot(getSql(), slotId, new Date());
  syncInBackground();
  refresh();
}

export async function resolveAlertAction(formData: FormData): Promise<void> {
  const alertId = z.coerce.number().int().parse(formData.get("alertId"));
  await getSql()`update alerts set resolved_at = now() where id = ${alertId}`;
  refresh();
}

export async function syncNowAction(): Promise<ActionResult> {
  const result = await runSyncTick(productionContext(), { deadlineMs: 20_000 });
  refresh();
  const { succeeded, deferred, failed } = result.worker;
  return {
    ok: failed === 0,
    message: `${succeeded} mise(s) à jour envoyée(s), ${deferred} reportée(s), ${failed} en échec (seront retentées).`,
  };
}

/** Démo uniquement : simule un client qui réserve sur la place de marché du partenaire (mock local). */
export async function simulatePartnerSaleAction(formData: FormData): Promise<void> {
  if (process.env.DEMO_MODE !== "1") throw new Error("DEMO_MODE désactivé");
  const listingId = z.uuid().parse(formData.get("listingId"));
  const [listing] = await getSql()<{ external_session_id: string; api_base_url: string; api_key: string }[]>`
    select l.external_session_id, c.api_base_url, c.api_key
    from listings l join partner_connections c on c.id = l.connection_id where l.id = ${listingId}`;
  if (!listing) return;
  const mockOrigin = new URL(listing.api_base_url).origin;
  await fetch(`${mockOrigin}/_sim/sessions/${encodeURIComponent(listing.external_session_id)}/sell`, {
    method: "POST",
    headers: { Authorization: `Bearer ${listing.api_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ seats: 1 }),
  }).catch(() => undefined);
  refresh();
}

/** Démo uniquement : coupe ou rétablit le partenaire simulé. */
export async function togglePartnerOutageAction(formData: FormData): Promise<void> {
  if (process.env.DEMO_MODE !== "1") throw new Error("DEMO_MODE désactivé");
  const connectionId = z.uuid().parse(formData.get("connectionId"));
  const down = formData.get("down") === "1";
  const [connection] = await getSql()<{ api_base_url: string; api_key: string }[]>`
    select api_base_url, api_key from partner_connections where id = ${connectionId}`;
  if (!connection) return;
  await fetch(`${new URL(connection.api_base_url).origin}/_sim/outage`, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.api_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ down }),
  }).catch(() => undefined);
  refresh();
}
