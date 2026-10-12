import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { signArtisiaPayload, verifyArtisiaSignature } from "@/partners/artisia/signature";
import { handleArtisiaWebhook, MAX_EVENT_ATTEMPTS, processPendingEvents } from "@/sync/webhooks";
import { runWorker } from "@/sync/worker";
import { World, testSql, type Partner } from "./helpers/world";

const sql = testSql();
afterAll(() => sql.end());

function send(world: World, partner: Partner, event: object, secret = partner.secret) {
  const raw = JSON.stringify(event);
  return handleArtisiaWebhook(world.ctx, partner.connectionId, raw, signArtisiaPayload(raw, secret));
}

async function partnerBookings(slotId: string) {
  return sql<{ external_booking_id: string; seats: number; status: string }[]>`
    select external_booking_id, seats, status from bookings where slot_id = ${slotId} and channel = 'partner'`;
}

describe("signature", () => {
  it("accepte la bonne signature et refuse un corps modifié d'un octet", () => {
    const sig = signArtisiaPayload('{"a":1}', "secret");
    expect(verifyArtisiaSignature('{"a":1}', sig, "secret")).toBe(true);
    expect(verifyArtisiaSignature('{"a":2}', sig, "secret")).toBe(false);
    expect(verifyArtisiaSignature('{"a":1}', null, "secret")).toBe(false);
    expect(verifyArtisiaSignature('{"a":1}', "sha256=court", "secret")).toBe(false);
  });
});

describe("Q3 — réception des webhooks", () => {
  let world: World;
  let artisia: Partner;
  let slotId: string;
  let sessionId: string;

  beforeEach(async () => {
    world = await World.create(sql);
    artisia = await world.addPartner("artisia");
    slotId = await world.addSlot({ capacity: 8 });
    ({ sessionId } = await world.publish(slotId, artisia));
    await world.settle();
  });

  it("le même webhook reçu 3 fois ne crée qu'une réservation", async () => {
    const event = {
      event_id: "evt_44810",
      type: "booking.created",
      occurred_at: "2027-01-14T09:31:07Z",
      data: { booking_id: "art_bk_5531", session_id: sessionId, seats: 1, customer: { name: "Sofia Nkemelu", email: "sofia@example.com" } },
    };
    const responses = [await send(world, artisia, event), await send(world, artisia, event), await send(world, artisia, event)];

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(responses.map((r) => r.body.duplicate)).toEqual([false, true, true]);
    expect(await partnerBookings(slotId)).toEqual([{ external_booking_id: "art_bk_5531", seats: 1, status: "confirmed" }]);
    const [stored] = await sql`select delivery_count, processed_at from inbound_events where event_id = 'evt_44810'`;
    expect(stored.delivery_count).toBe(3);
    expect(stored.processed_at).not.toBeNull();
  });

  it("deux event_id différents pour la même réservation : la contrainte (connexion, booking_id) protège encore", async () => {
    const data = { booking_id: "art_bk_1", session_id: sessionId, seats: 2 };
    await send(world, artisia, { event_id: "evt_a", type: "booking.created", data });
    await send(world, artisia, { event_id: "evt_b", type: "booking.created", data });
    expect(await partnerBookings(slotId)).toHaveLength(1);
  });

  it("refuse une signature invalide (401) sans rien stocker", async () => {
    const response = await send(world, artisia, { event_id: "evt_x", type: "booking.created", data: {} }, "mauvais-secret");
    expect(response.status).toBe(401);
    expect(await sql`select 1 from inbound_events where event_id = 'evt_x'`).toHaveLength(0);
  });

  it("répond 404 pour une connexion inconnue et 400 pour une enveloppe illisible", async () => {
    expect((await handleArtisiaWebhook(world.ctx, "pas-un-uuid", "{}", null)).status).toBe(404);
    const raw = JSON.stringify({ type: "booking.created" });
    const response = await handleArtisiaWebhook(world.ctx, artisia.connectionId, raw, signArtisiaPayload(raw, artisia.secret));
    expect(response.status).toBe(400);
  });

  it("désordre : l'annulation arrive avant la création, la réservation finit annulée", async () => {
    const data = { booking_id: "art_bk_9", session_id: sessionId, seats: 1 };
    await send(world, artisia, { event_id: "evt_2", type: "booking.cancelled", data });
    await send(world, artisia, { event_id: "evt_1", type: "booking.created", data });

    expect(await partnerBookings(slotId)).toEqual([{ external_booking_id: "art_bk_9", seats: 1, status: "cancelled" }]);
    expect((await world.availability(slotId)).soldPartners).toBe(0);
  });

  it("désordre : un session.updated plus ancien que l'état connu est ignoré", async () => {
    const base = { session_id: sessionId, capacity: 2, status: "published" };
    await send(world, artisia, { event_id: "evt_new", type: "session.updated", data: { ...base, booked: 2, updated_at: "2027-01-10T10:00:05Z" } });
    await send(world, artisia, { event_id: "evt_old", type: "session.updated", data: { ...base, booked: 1, updated_at: "2027-01-10T10:00:00Z" } });
    const [listing] = await sql`select partner_booked from listings where external_session_id = ${sessionId}`;
    expect(listing.partner_booked).toBe(2);
  });

  it("une vente partenaire déclenche la mise à jour des vitrines des autres canaux", async () => {
    const result = artisia.fake.sell(sessionId, 1);
    expect(result.ok).toBe(true);
    await world.deliverWebhooks(artisia);
    expect(await sql`select 1 from sync_jobs where kind = 'sync_listing'`).toHaveLength(1);
    await runWorker(world.ctx);
    // Artisia a vendu 1 place sur ses 2 : la synchro lui en redonne une (fenêtre de 2 invendues).
    expect(artisia.fake.sessions.get(sessionId)!.capacity).toBe(3);
  });

  it("session pas encore reliée : l'événement attend, la réconciliation relie, le rejeu le traite", async () => {
    const orphan = artisia.fake.createSession({
      externalRef: `daisy_slot_${slotId.replace(/.$/, "0")}`, // créneau inexistant chez nous
      title: "Session créée hors Daisy",
      startsAt: new Date("2027-01-20T10:00:00Z"),
    });
    const response = await send(world, artisia, {
      event_id: "evt_orphan",
      type: "booking.created",
      data: { booking_id: "art_bk_o", session_id: orphan.session_id, seats: 1 },
    });
    expect(response.status).toBe(200); // stocké, donc accepté

    const [pending] = await sql`select processed_at, attempts, last_error from inbound_events where event_id = 'evt_orphan'`;
    expect(pending.processed_at).toBeNull();
    expect(pending.last_error).toMatch(/session inconnue/);

    // La réconciliation ne peut pas la relier (pas de créneau Daisy) : alerte « non reliée ».
    await runWorker(world.ctx);
    const alerts = await sql`select kind from alerts where resolved_at is null`;
    expect(alerts.map((a) => a.kind)).toContain("unlinked_session");

    // Après MAX_EVENT_ATTEMPTS rejeux, l'événement est déclaré en échec et n'est plus rejoué.
    for (let i = 0; i < MAX_EVENT_ATTEMPTS; i++) await processPendingEvents(world.ctx);
    const [failed] = await sql`select attempts from inbound_events where event_id = 'evt_orphan'`;
    expect(failed.attempts).toBe(MAX_EVENT_ATTEMPTS);
    expect((await sql`select kind from alerts where kind = 'event_failed'`).length).toBe(1);
  });

  it("la réconciliation relie une session dont l'external_ref désigne un créneau Daisy", async () => {
    const otherSlot = await world.addSlot({ capacity: 6 });
    const session = artisia.fake.createSession({
      externalRef: `daisy_slot_${otherSlot}`,
      title: "Créée par l'intégration",
      startsAt: new Date("2027-01-21T10:00:00Z"),
    });
    await send(world, artisia, {
      event_id: "evt_early",
      type: "booking.created",
      data: { booking_id: "art_bk_early", session_id: session.session_id, seats: 1 },
    });
    // Le webhook a demandé une réconciliation ; elle crée la publication.
    await runWorker(world.ctx);
    expect(await sql`select 1 from listings where external_session_id = ${session.session_id}`).toHaveLength(1);

    await processPendingEvents(world.ctx);
    expect(await partnerBookings(otherSlot)).toHaveLength(1);
  });
});
