import { afterAll, describe, expect, it } from "vitest";
import { bookDirect, BookingRefused } from "@/sync/bookings";
import { FAILURES_BEFORE_DEGRADED } from "@/sync/connections";
import { getDashboard } from "@/sync/dashboard";
import { runSyncTick } from "@/sync/worker";
import { World, testSql } from "./helpers/world";

const sql = testSql();
afterAll(() => sql.end());

describe("Q2 — Artisia hors ligne pendant 20 minutes", () => {
  it("Daisy continue de vendre, rien n'est surréservé, et tout se rattrape au retour", async () => {
    const world = await World.create(sql);
    const artisia = await world.addPartner("Artisia");
    const atelio = await world.addPartner("Atelio");
    const slots: { slotId: string; artisiaSession: string; atelioSession: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const slotId = await world.addSlot({ capacity: 8, startsInHours: 48 + i * 24 });
      const a = await world.publish(slotId, artisia);
      const b = await world.publish(slotId, atelio);
      slots.push({ slotId, artisiaSession: a.sessionId, atelioSession: b.sessionId });
    }
    await world.settle();

    // ---- Panne : l'API Artisia ne répond plus, ses webhooks restent bloqués chez elle.
    // Pire cas retenu : leur place de marché continue de vendre (dans la limite de leur allotement).
    artisia.fake.faults.down = true;
    const outageStart = world.clock.now();
    let directSales = 0;
    let directRefusals = 0;

    for (let minute = 0; minute < 20; minute++) {
      for (const { slotId, artisiaSession, atelioSession } of slots) {
        try {
          await bookDirect(sql, { slotId, seats: 1, customerName: "Client", customerEmail: "c@example.com" }, world.clock.now());
          directSales++;
        } catch (error) {
          if (!(error instanceof BookingRefused)) throw error;
          directRefusals++;
        }
        if (minute % 3 === 0) artisia.fake.sell(artisiaSession, 1);
        if (minute % 4 === 0) atelio.fake.sell(atelioSession, 1);
      }
      await world.deliverWebhooks(atelio); // l'autre partenaire, lui, fonctionne
      await runSyncTick(world.ctx);

      // Invariant vérifié à chaque minute, sur la vérité terrain (ventes réelles chez chacun).
      for (const { slotId } of slots) expect(await world.realSeatsSold(slotId)).toBeLessThanOrEqual(8);
      world.clock.advance(60_000);
    }

    // ---- Ce que voit l'artisan pendant la panne.
    const during = await getDashboard(sql, world.studioId, world.clock.now());
    const artisiaView = during!.connections.find((c) => c.label === "Artisia")!;
    const atelioView = during!.connections.find((c) => c.label === "Atelio")!;
    expect(artisiaView.health).toBe("offline");
    expect(artisiaView.degradedSince!.getTime()).toBeGreaterThanOrEqual(outageStart.getTime());
    expect(artisiaView.pendingSyncs).toBeGreaterThan(0);
    expect(atelioView.health).toBe("ok"); // une panne chez l'un n'affecte pas l'autre
    expect(directSales).toBeGreaterThan(0);

    // Disjoncteur : au plus une sonde toutes les 30 s une fois la connexion déclarée hors ligne.
    expect(artisia.fake.unreachableCalls).toBeLessThanOrEqual(FAILURES_BEFORE_DEGRADED + 20 * 2 + 4);

    // ---- Retour à la normale : Artisia rejoue ses webhooks (1 min, 5 min...), notre worker sonde.
    artisia.fake.faults.down = false;
    await world.settle();

    const after = await getDashboard(sql, world.studioId, world.clock.now());
    const recovered = after!.connections.find((c) => c.label === "Artisia")!;
    expect(recovered.health).toBe("ok");
    expect(recovered.lastReconciledAt!.getTime()).toBeGreaterThan(outageStart.getTime());
    expect(recovered.pendingSyncs).toBe(0);

    for (const { slotId, artisiaSession } of slots) {
      const view = after!.slots.find((s) => s.id === slotId)!;
      expect(view.availability.overbookedBy).toBe(0);
      expect(view.availability.overcommittedBy).toBe(0);
      expect(await world.realSeatsSold(slotId)).toBeLessThanOrEqual(8);
      // Daisy connaît toutes les ventes Artisia de la panne, avec les clients.
      const channel = view.channels.find((c) => c.label === "Artisia")!;
      expect(channel.sold).toBe(artisia.fake.sessions.get(artisiaSession)!.booked);
      expect(channel.syncState).toBe("synced");
    }
    expect(after!.alerts).toEqual([]);
  });
});
