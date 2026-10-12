import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bookDirect, BookingRefused } from "@/sync/bookings";
import { World, testSql } from "./helpers/world";

const sql = testSql();
afterAll(() => sql.end());

const customer = (i: number) => ({ customerName: `Client ${i}`, customerEmail: `client${i}@example.com` });

describe("Q1 — la dernière place", () => {
  let world: World;
  beforeEach(async () => {
    world = await World.create(sql);
  });

  it("20 réservations directes simultanées sur 1 place : exactement 1 passe, 19 reçoivent slot_full", async () => {
    const slotId = await world.addSlot({ capacity: 8 });
    for (let i = 0; i < 7; i++) await bookDirect(sql, { slotId, seats: 1, ...customer(i) }, world.clock.now());

    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => bookDirect(sql, { slotId, seats: 1, ...customer(100 + i) }, world.clock.now())),
    );

    const ok = attempts.filter((a) => a.status === "fulfilled");
    const refused = attempts.filter((a) => a.status === "rejected").map((a) => (a as PromiseRejectedResult).reason);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(19);
    expect(refused.every((r) => r instanceof BookingRefused && r.code === "slot_full" && r.available === 0)).toBe(true);
    expect(await world.realSeatsSold(slotId)).toBe(8);
  });

  it("Daisy et Artisia au même instant, la dernière place est dans le pool direct : Daisy vend, Artisia refuse", async () => {
    const artisia = await world.addPartner("artisia");
    const slotId = await world.addSlot({ capacity: 8 });
    const { sessionId } = await world.publish(slotId, artisia);
    await world.settle();

    // 7 places parties en direct, la synchro tournant entre chaque vente (comme en production).
    // À mesure que le créneau se remplit, la vitrine d'Artisia rétrécit puis disparaît.
    for (let i = 0; i < 7; i++) {
      await bookDirect(sql, { slotId, seats: 1, ...customer(i) }, world.clock.now());
      await world.settle();
    }
    expect(artisia.fake.sessions.get(sessionId)!.capacity).toBe(0);

    const [daisy, partner] = await Promise.all([
      bookDirect(sql, { slotId, seats: 1, ...customer(99) }, world.clock.now()),
      Promise.resolve(artisia.fake.sell(sessionId, 1)),
    ]);
    expect(daisy.bookingId).toBeTruthy();
    expect(partner).toEqual({ ok: false, error: "not_enough_seats" });
    expect(await world.realSeatsSold(slotId)).toBe(8);
  });

  it("même course, mais la dernière place est encore détenue par Artisia : Artisia vend, Daisy refuse", async () => {
    const artisia = await world.addPartner("artisia");
    const slotId = await world.addSlot({ capacity: 4 });
    const { sessionId } = await world.publish(slotId, artisia);
    await world.settle(); // Artisia reçoit 2 places (4 restantes, 2 canaux)

    // 2 ventes directes, puis la course SANS laisser la synchro reprendre la place à Artisia.
    await bookDirect(sql, { slotId, seats: 1, ...customer(1) }, world.clock.now());
    await bookDirect(sql, { slotId, seats: 1, ...customer(2) }, world.clock.now());
    expect(artisia.fake.sessions.get(sessionId)!.capacity).toBe(2);
    artisia.fake.sell(sessionId, 1);

    const [daisy, partner] = await Promise.allSettled([
      bookDirect(sql, { slotId, seats: 1, ...customer(3) }, world.clock.now()),
      Promise.resolve(artisia.fake.sell(sessionId, 1)),
    ]);
    expect(daisy.status).toBe("rejected");
    expect((daisy as PromiseRejectedResult).reason).toMatchObject({ code: "slot_full" });
    expect(partner).toMatchObject({ status: "fulfilled", value: { ok: true } });

    await world.settle();
    expect(await world.realSeatsSold(slotId)).toBe(4);
    expect((await world.availability(slotId)).overbookedBy).toBe(0);
  });

  it("deux partenaires qui vendent en même temps ne peuvent pas se marcher dessus", async () => {
    const a = await world.addPartner("artisia");
    const b = await world.addPartner("atelio");
    const slotId = await world.addSlot({ capacity: 3 });
    const sa = await world.publish(slotId, a);
    const sb = await world.publish(slotId, b);
    await world.settle();

    // Chaque partenaire tente de vendre tout ce qu'il peut, en rafale.
    const salesA = Array.from({ length: 5 }, () => a.fake.sell(sa.sessionId, 1)).filter((s) => s.ok).length;
    const salesB = Array.from({ length: 5 }, () => b.fake.sell(sb.sessionId, 1)).filter((s) => s.ok).length;
    expect(salesA + salesB).toBeLessThanOrEqual(3);

    await world.settle();
    expect(await world.realSeatsSold(slotId)).toBeLessThanOrEqual(3);
  });

  it("refuse une réservation sur un créneau annulé ou déjà commencé", async () => {
    const slotId = await world.addSlot({ capacity: 8, startsInHours: 1 });
    world.clock.advance(2 * 3600_000);
    await expect(bookDirect(sql, { slotId, seats: 1, ...customer(1) }, world.clock.now())).rejects.toMatchObject({
      code: "slot_started",
    });
  });
});
