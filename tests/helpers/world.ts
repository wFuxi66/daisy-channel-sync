import { createSql, type Sql } from "@/lib/db";
import { FakeArtisia } from "@/partners/artisia/fake";
import { signArtisiaPayload } from "@/partners/artisia/signature";
import { computeAvailability } from "@/sync/allocation";
import type { SyncContext } from "@/sync/context";
import { enqueueListingSync } from "@/sync/jobs";
import { externalRefForSlot } from "@/sync/reconcile";
import { loadSlotState } from "@/sync/state";
import { handleArtisiaWebhook } from "@/sync/webhooks";
import { runWorker } from "@/sync/worker";
import { TEST_DATABASE_URL } from "./env";

/** Générateur pseudo-aléatoire déterministe (mulberry32) : un scénario se rejoue à l'identique. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Clock {
  constructor(private t = Date.parse("2027-01-10T09:00:00Z")) {}
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
  set(date: Date): void {
    this.t = date.getTime();
  }
}

export interface Partner {
  connectionId: string;
  secret: string;
  fake: FakeArtisia;
}

/**
 * Un monde de test : une base réelle, une horloge contrôlée, des faux partenaires.
 * Les tables sont vidées à chaque nouveau monde.
 */
export class World {
  readonly clock = new Clock();
  readonly partners: Partner[] = [];
  readonly ctx: SyncContext;
  studioId = "";

  private constructor(readonly sql: Sql) {
    this.ctx = {
      sql,
      now: this.clock.now,
      partnerFor: (connection) => {
        const partner = this.partners.find((p) => p.connectionId === connection.id);
        if (!partner) throw new Error(`pas de faux partenaire pour ${connection.id}`);
        return partner.fake.client(connection.apiKey);
      },
    };
  }

  static async create(sql: Sql, options: { partnerWindow?: number } = {}): Promise<World> {
    await sql`truncate studios, partner_connections, slots, listings, bookings, inbound_events,
              sync_jobs, partner_rate_windows, alerts restart identity cascade`;
    const world = new World(sql);
    const [studio] = await sql<{ id: string }[]>`
      insert into studios (name, partner_window) values ('Atelier Terre & Feu', ${options.partnerWindow ?? 2})
      returning id`;
    world.studioId = studio.id;
    return world;
  }

  async addPartner(label: string, random: () => number = Math.random): Promise<Partner> {
    const secret = `whsec_${label}`;
    const [row] = await this.sql<{ id: string }[]>`
      insert into partner_connections (studio_id, provider, label, api_base_url, api_key, webhook_secret)
      values (${this.studioId}, 'artisia', ${label}, 'https://artisia.test/v1', ${`key_${label}`}, ${secret})
      returning id`;
    const partner = { connectionId: row.id, secret, fake: new FakeArtisia(this.clock.now, random, label) };
    this.partners.push(partner);
    return partner;
  }

  async addSlot(options: { capacity: number; startsInHours?: number; title?: string }): Promise<string> {
    const startsAt = new Date(this.clock.now().getTime() + (options.startsInHours ?? 72) * 3600_000);
    const [row] = await this.sql<{ id: string }[]>`
      insert into slots (studio_id, title, starts_at, duration_minutes, capacity)
      values (${this.studioId}, ${options.title ?? "Tour de potier — débutant"}, ${startsAt}, 120, ${options.capacity})
      returning id`;
    return row.id;
  }

  /** Publie le créneau chez le partenaire : session créée chez lui (capacité 0) + publication chez nous. */
  async publish(slotId: string, partner: Partner): Promise<{ listingId: string; sessionId: string }> {
    const [slot] = await this.sql<{ title: string; starts_at: Date }[]>`select title, starts_at from slots where id = ${slotId}`;
    const session = partner.fake.createSession({ externalRef: externalRefForSlot(slotId), title: slot.title, startsAt: slot.starts_at });
    const [row] = await this.sql<{ id: string }[]>`
      insert into listings (slot_id, connection_id, external_session_id)
      values (${slotId}, ${partner.connectionId}, ${session.session_id})
      returning id`;
    await enqueueListingSync(this.sql, row.id, this.clock.now());
    return { listingId: row.id, sessionId: session.session_id };
  }

  /** Livre les webhooks en attente chez ce partenaire, en passant par le vrai handler (signature comprise). */
  async deliverWebhooks(partner: Partner, options: { shuffle?: boolean } = {}) {
    const results = [];
    for (const event of partner.fake.takeWebhooks(options)) {
      const raw = JSON.stringify(event);
      results.push(await handleArtisiaWebhook(this.ctx, partner.connectionId, raw, signArtisiaPayload(raw, partner.secret)));
    }
    return results;
  }

  /**
   * Fait tourner le système jusqu'au repos : webhooks livrés, file de synchro vide.
   * Avance l'horloge jusqu'aux jobs replanifiés plus tard (backoff, rate limit).
   */
  async settle(maxRounds = 50): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      let activity = 0;
      for (const partner of this.partners) activity += (await this.deliverWebhooks(partner)).length;
      activity += (await runWorker(this.ctx, { deadlineMs: 60_000 })).processed;
      if (activity > 0) continue;

      const [next] = await this.sql<{ run_after: Date }[]>`select min(run_after) as run_after from sync_jobs`;
      if (!next?.run_after) return;
      this.clock.set(new Date(Math.max(next.run_after.getTime(), this.clock.now().getTime()) + 1));
    }
    throw new Error("le système ne s'est pas stabilisé");
  }

  async availability(slotId: string) {
    const slot = await loadSlotState(this.sql, slotId, { lock: false });
    return computeAvailability(slot!, this.clock.now());
  }

  /** La vérité terrain : ventes directes en base + ventes réellement enregistrées chez chaque partenaire. */
  async realSeatsSold(slotId: string): Promise<number> {
    const [direct] = await this.sql<{ seats: number }[]>`
      select coalesce(sum(seats), 0)::int as seats from bookings
      where slot_id = ${slotId} and channel = 'direct' and status = 'confirmed'`;
    let partnerSeats = 0;
    for (const partner of this.partners) {
      for (const session of partner.fake.sessions.values()) {
        if (session.external_ref === externalRefForSlot(slotId)) partnerSeats += session.booked;
      }
    }
    return direct.seats + partnerSeats;
  }

  /** Places engagées en réalité : ventes directes + capacité réellement ouverte chez chaque partenaire. */
  async realSeatsCommitted(slotId: string): Promise<number> {
    const [direct] = await this.sql<{ seats: number }[]>`
      select coalesce(sum(seats), 0)::int as seats from bookings
      where slot_id = ${slotId} and channel = 'direct' and status = 'confirmed'`;
    let partnerCapacity = 0;
    for (const partner of this.partners) {
      for (const session of partner.fake.sessions.values()) {
        if (session.external_ref === externalRefForSlot(slotId) && session.status === "published") {
          partnerCapacity += session.capacity;
        }
      }
    }
    return direct.seats + partnerCapacity;
  }

  async capacity(slotId: string): Promise<number> {
    const [slot] = await this.sql<{ capacity: number }[]>`select capacity from slots where id = ${slotId}`;
    return slot.capacity;
  }
}

let shared: Sql | undefined;
export function testSql(): Sql {
  shared ??= createSql(TEST_DATABASE_URL, { max: 20, onnotice: () => {} });
  return shared;
}
