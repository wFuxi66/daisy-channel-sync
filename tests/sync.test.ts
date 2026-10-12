import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bookDirect, cancelSlot, updateSlotCapacity } from "@/sync/bookings";
import { CALLS_PER_MINUTE_BUDGET } from "@/sync/connections";
import { enqueueReconcile } from "@/sync/jobs";
import { syncListing } from "@/sync/listing-sync";
import { runWorker } from "@/sync/worker";
import { World, testSql, type Partner } from "./helpers/world";

const sql = testSql();
afterAll(() => sql.end());

const customer = { customerName: "Camille Roux", customerEmail: "camille@example.com" };

async function listingRow(listingId: string) {
  const [row] = await sql`select confirmed_capacity, inflight_capacity, partner_booked from listings where id = ${listingId}`;
  return row;
}

describe("synchronisation sortante (Daisy → partenaire)", () => {
  let world: World;
  let artisia: Partner;
  let slotId: string;
  let listingId: string;
  let sessionId: string;

  beforeEach(async () => {
    world = await World.create(sql);
    artisia = await world.addPartner("artisia");
    slotId = await world.addSlot({ capacity: 8 });
    ({ listingId, sessionId } = await world.publish(slotId, artisia));
  });

  it("pousse la vitrine initiale et la confirme", async () => {
    await world.settle();
    expect(artisia.fake.sessions.get(sessionId)!.capacity).toBe(2);
    expect(await listingRow(listingId)).toMatchObject({ confirmed_capacity: 2, inflight_capacity: null });
    expect((await world.availability(slotId)).directAvailable).toBe(6);
  });

  it("timeout sur un don de places : on les considère données tant que ce n'est pas confirmé", async () => {
    artisia.fake.faults.timeoutRate = 1; // la requête est appliquée chez Artisia, mais la réponse se perd
    await expect(syncListing(world.ctx, listingId)).rejects.toMatchObject({ kind: "timeout" });

    expect(artisia.fake.sessions.get(sessionId)!.capacity).toBe(2); // appliqué chez eux
    expect(await listingRow(listingId)).toMatchObject({ confirmed_capacity: 0, inflight_capacity: 2 });
    // Prudence : ces 2 places ne sont plus vendables en direct.
    expect((await world.availability(slotId)).directAvailable).toBe(6);

    artisia.fake.faults.timeoutRate = 0;
    await world.settle(); // rejeu du même PATCH absolu : sans effet de bord
    expect(await listingRow(listingId)).toMatchObject({ confirmed_capacity: 2, inflight_capacity: null });
  });

  it("timeout sur une reprise de places : on les laisse au partenaire tant que ce n'est pas confirmé", async () => {
    await world.settle();
    // L'artisan baisse la capacité : la vitrine Artisia doit passer de 2 à 1.
    await updateSlotCapacity(sql, slotId, 3, world.clock.now());
    artisia.fake.faults.timeoutRate = 1;
    artisia.fake.faults.applyOnTimeout = false; // cette fois la requête n'est jamais arrivée
    await runWorker(world.ctx);

    expect(artisia.fake.sessions.get(sessionId)!.capacity).toBe(2);
    expect(await listingRow(listingId)).toMatchObject({ confirmed_capacity: 2, inflight_capacity: 1 });
    expect((await world.availability(slotId)).directAvailable).toBe(1); // 3 - 2 détenues

    artisia.fake.faults.timeoutRate = 0;
    await world.settle();
    expect(artisia.fake.sessions.get(sessionId)!.capacity).toBe(1);
    expect((await world.availability(slotId)).directAvailable).toBe(2);
  });

  it("409 capacity_below_booked : on apprend le vrai nombre de ventes et on recalcule", async () => {
    await world.settle();
    // Artisia vend 2 places mais les webhooks se perdent.
    artisia.fake.sell(sessionId, 2);
    artisia.fake.takeWebhooks();

    // L'artisan réduit la capacité : Daisy veut ramener la vitrine Artisia à 1, croyant ses ventes à 0.
    await updateSlotCapacity(sql, slotId, 2, world.clock.now());
    await world.settle();

    // Le PATCH à 1 a été refusé (409), le moteur a appris booked = 2 et s'est aligné.
    expect(artisia.fake.calls.map((c) => c.status)).toContain(409);
    expect(await listingRow(listingId)).toMatchObject({ partner_booked: 2, confirmed_capacity: 2, inflight_capacity: null });
    expect(await world.realSeatsSold(slotId)).toBe(2);
    expect((await world.availability(slotId)).directAvailable).toBe(0);
  });

  it("annulation du créneau : la session partenaire est fermée", async () => {
    await world.settle();
    await cancelSlot(sql, slotId, world.clock.now());
    await world.settle();
    expect(artisia.fake.sessions.get(sessionId)).toMatchObject({ status: "cancelled", capacity: 0 });
  });

  it("baisse de capacité sous les ventes : appliquée, signalée comme surréservation", async () => {
    await world.settle();
    for (let i = 0; i < 4; i++) await bookDirect(sql, { slotId, seats: 1, ...customer }, world.clock.now());
    await updateSlotCapacity(sql, slotId, 3, world.clock.now());

    const alerts = await sql`select kind, message from alerts where resolved_at is null`;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("overbooked");
    expect(alerts[0].message).toMatch(/1 place\(s\) vendue\(s\) au-delà/);
  });

  it("modification de capacité faite directement chez Artisia : détectée, signalée, corrigée", async () => {
    await world.settle();
    artisia.fake.artisanSetCapacity(sessionId, 8);
    await world.settle();

    expect(artisia.fake.sessions.get(sessionId)!.capacity).toBe(2);
    const [alert] = await sql`select kind from alerts where resolved_at is null`;
    expect(alert.kind).toBe("capacity_drift");
  });

  it("course réconciliation / PATCH : un instantané GET dépassé n'écrase pas une réponse plus récente", async () => {
    await world.settle(); // Artisia : capacité 2
    const staleSnapshot = await artisia.fake.client().listSessions(); // photo prise à capacité 2

    // Entre la photo et son traitement, une baisse de capacité est poussée et confirmée (2 → 1).
    await updateSlotCapacity(sql, slotId, 3, world.clock.now());
    await world.settle();
    expect(await listingRow(listingId)).toMatchObject({ confirmed_capacity: 1 });

    // La réconciliation applique la vieille photo : elle doit être ignorée (horloge partenaire).
    const { applyPartnerObservation } = await import("@/sync/observations");
    const old = staleSnapshot[0];
    const result = await applyPartnerObservation(
      sql,
      listingId,
      { capacity: old.capacity, booked: old.booked, status: old.status, updatedAt: old.updatedAt },
      { fromOwnPatch: false, now: world.clock.now() },
    );
    expect(result.fresh).toBe(false);
    expect(await listingRow(listingId)).toMatchObject({ confirmed_capacity: 1 });
    expect(await sql`select 1 from alerts`).toHaveLength(0);
  });

  it("webhook perdu : la réconciliation retrouve la vente et prévient l'artisan", async () => {
    await world.settle();
    artisia.fake.sell(sessionId, 1);
    artisia.fake.takeWebhooks(); // perdu

    await enqueueReconcile(sql, artisia.connectionId, world.clock.now());
    await world.settle();

    expect(await listingRow(listingId)).toMatchObject({ partner_booked: 1 });
    // La place est comptée : le pool direct en tient compte.
    expect((await world.availability(slotId)).soldPartners).toBe(1);
    const [alert] = await sql`select kind, message from alerts where resolved_at is null`;
    expect(alert.kind).toBe("unknown_partner_bookings");
  });
});

describe("rate limit (60 appels/min chez Artisia)", () => {
  it(`ne dépasse jamais ${CALLS_PER_MINUTE_BUDGET} appels par minute pleine, et reporte le reste`, async () => {
    const world = await World.create(sql);
    const artisia = await world.addPartner("artisia");
    for (let i = 0; i < 120; i++) {
      const slotId = await world.addSlot({ capacity: 8, startsInHours: 24 + i });
      await world.publish(slotId, artisia);
    }

    const first = await runWorker(world.ctx);
    expect(first.succeeded).toBe(CALLS_PER_MINUTE_BUDGET);
    expect(first.deferred).toBe(120 - CALLS_PER_MINUTE_BUDGET);

    await world.settle();
    const perMinute = new Map<number, number>();
    for (const call of artisia.fake.calls) {
      const minute = Math.floor(call.at.getTime() / 60_000);
      perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
    }
    expect(Math.max(...perMinute.values())).toBeLessThanOrEqual(CALLS_PER_MINUTE_BUDGET);
    expect(artisia.fake.calls.every((c) => c.status !== 429)).toBe(true);
    expect([...artisia.fake.sessions.values()].every((s) => s.capacity === 2)).toBe(true);
  });

  it("les cours les plus proches sont synchronisés en premier", async () => {
    const world = await World.create(sql);
    const artisia = await world.addPartner("artisia");
    const late = await world.addSlot({ capacity: 8, startsInHours: 500 });
    const soon = await world.addSlot({ capacity: 8, startsInHours: 2 });
    const { sessionId: lateSession } = await world.publish(late, artisia);
    const { sessionId: soonSession } = await world.publish(soon, artisia);

    await runWorker(world.ctx, { maxJobs: 1 });
    expect(artisia.fake.sessions.get(soonSession)!.capacity).toBe(2);
    expect(artisia.fake.sessions.get(lateSession)!.capacity).toBe(0);
  });
});
