import { afterAll, describe, expect, it } from "vitest";
import { bookDirect, BookingRefused, updateSlotCapacity } from "@/sync/bookings";
import { enqueueReconcile } from "@/sync/jobs";
import { runWorker } from "@/sync/worker";
import { World, seededRandom, testSql } from "./helpers/world";

const sql = testSql();
afterAll(() => sql.end());

/**
 * Test « chaos » : des centaines d'actions aléatoires (mais rejouables via la graine) avec des
 * partenaires qui cumulent tous les défauts de l'annexe. L'invariant est vérifié APRÈS CHAQUE
 * action sur la vérité terrain : ventes directes en base + ventes réellement faites chez chacun.
 */
describe("chaos : jamais de surréservation, quelles que soient les pannes", () => {
  // CHAOS_SEEDS=200 npx vitest run chaos  → campagne longue sur 200 graines.
  const count = Number(process.env.CHAOS_SEEDS ?? 0);
  const seeds = count > 0 ? Array.from({ length: count }, (_, i) => i + 1) : [1, 7, 42, 1337, 2027];
  for (const seed of seeds) {
    it(`graine ${seed}`, async () => {
      const random = seededRandom(seed);
      const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];

      const world = await World.create(sql, { partnerWindow: 1 + Math.floor(random() * 3) });
      const partners = [await world.addPartner("artisia", random), await world.addPartner("atelio", random)];
      for (const p of partners) {
        p.fake.faults = { down: false, serverErrorRate: 0.05, timeoutRate: 0.05, applyOnTimeout: true, duplicateRate: 0.1, dropRate: 0.03 };
      }

      const slots: { slotId: string; sessions: Map<string, string> }[] = [];
      for (let i = 0; i < 3; i++) {
        const slotId = await world.addSlot({ capacity: 4 + Math.floor(random() * 6), startsInHours: 100 + i });
        const sessions = new Map<string, string>();
        for (const p of partners) sessions.set(p.connectionId, (await world.publish(slotId, p)).sessionId);
        slots.push({ slotId, sessions });
      }

      for (let step = 0; step < 250; step++) {
        const slot = pick(slots);
        const partner = pick(partners);
        const roll = random();

        if (roll < 0.25) {
          try {
            await bookDirect(sql, { slotId: slot.slotId, seats: 1 + Math.floor(random() * 2), customerName: "C", customerEmail: "c@x.fr" }, world.clock.now());
          } catch (error) {
            if (!(error instanceof BookingRefused)) throw error;
          }
        } else if (roll < 0.5) {
          partner.fake.sell(slot.sessions.get(partner.connectionId)!, 1 + Math.floor(random() * 2));
        } else if (roll < 0.55) {
          const confirmed = [...partner.fake.bookings.values()].filter((b) => b.status === "confirmed");
          if (confirmed.length) partner.fake.cancelBooking(pick(confirmed).booking_id);
        } else if (roll < 0.58) {
          // L'artisan ajoute une place (les baisses sous les ventes sont une décision assumée, testée ailleurs).
          await updateSlotCapacity(sql, slot.slotId, (await world.capacity(slot.slotId)) + 1, world.clock.now());
        } else if (roll < 0.62) {
          partner.fake.faults.down = !partner.fake.faults.down;
        } else if (roll < 0.65) {
          partner.fake.faults.applyOnTimeout = random() < 0.5;
        } else if (roll < 0.8) {
          await world.deliverWebhooks(partner, { shuffle: true });
        } else if (roll < 0.83) {
          await enqueueReconcile(sql, partner.connectionId, world.clock.now());
        } else {
          await runWorker(world.ctx, { maxJobs: 10 });
          world.clock.advance(Math.floor(random() * 90_000));
        }

        for (const { slotId } of slots) {
          const capacity = await world.capacity(slotId);
          const sold = await world.realSeatsSold(slotId);
          expect(sold, `graine ${seed}, étape ${step} : ${sold} vendues pour ${capacity} places`).toBeLessThanOrEqual(capacity);
          // Plus fort : même les places simplement OUVERTES à la vente chez les partenaires tiennent dans la capacité.
          const committed = await world.realSeatsCommitted(slotId);
          expect(committed, `graine ${seed}, étape ${step} : ${committed} places engagées pour ${capacity}`).toBeLessThanOrEqual(capacity);
        }
      }

      // Retour au calme : plus de pannes, Artisia relivre, une réconciliation finale.
      for (const p of partners) {
        p.fake.faults = { down: false, serverErrorRate: 0, timeoutRate: 0, applyOnTimeout: true, duplicateRate: 0, dropRate: 0 };
        await enqueueReconcile(sql, p.connectionId, world.clock.now());
      }
      await world.settle(200);

      for (const { slotId, sessions } of slots) {
        expect(await world.realSeatsCommitted(slotId)).toBeLessThanOrEqual(await world.capacity(slotId));
        for (const p of partners) {
          const session = p.fake.sessions.get(sessions.get(p.connectionId)!)!;
          const [listing] = await sql`
            select confirmed_capacity, inflight_capacity, partner_booked from listings
            where external_session_id = ${session.session_id}`;
          // Daisy et le partenaire ont convergé vers le même état.
          expect(listing).toEqual({ confirmed_capacity: session.capacity, inflight_capacity: null, partner_booked: session.booked });
        }
      }
    });
  }
});
