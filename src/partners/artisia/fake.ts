import { ArtisiaClient } from "./client";

/**
 * Faux Artisia en mémoire : reproduit le contrat de `partner-api.md`, pannes comprises.
 *
 * Il sert aux tests (branché sur le VRAI ArtisiaClient via un `fetch` simulé, donc la traduction
 * HTTP → erreurs est testée aussi) et au serveur mock de démo (scripts/mock-artisia.ts).
 * Hypothèse structurante, assumée côté Artisia : `booked <= capacity` est garanti atomiquement.
 * Ici c'est trivial, JavaScript étant mono-thread.
 */

export interface FakeSession {
  session_id: string;
  external_ref: string | null;
  title: string;
  starts_at: string;
  duration_minutes: number;
  capacity: number;
  booked: number;
  status: "published" | "cancelled";
  updated_at: string;
}

export interface FakeBooking {
  booking_id: string;
  session_id: string;
  seats: number;
  status: "confirmed" | "cancelled";
  customer: { name: string; email: string };
}

export interface WebhookEvent {
  event_id: string;
  type: "booking.created" | "booking.cancelled" | "session.updated";
  occurred_at: string;
  data: Record<string, unknown>;
}

export interface Faults {
  /** Plateforme hors ligne : tous les appels API échouent (connexion refusée). */
  down: boolean;
  /** Part des appels qui répondent 500 sans corps. */
  serverErrorRate: number;
  /** Part des appels qui expirent côté client. */
  timeoutRate: number;
  /** Un appel qui expire a-t-il quand même été appliqué ? (le pire cas : oui) */
  applyOnTimeout: boolean;
  /** Part des webhooks livrés deux ou trois fois. */
  duplicateRate: number;
  /** Part des webhooks jamais livrés. */
  dropRate: number;
}

export const NO_FAULTS: Faults = {
  down: false,
  serverErrorRate: 0,
  timeoutRate: 0,
  applyOnTimeout: true,
  duplicateRate: 0,
  dropRate: 0,
};

export const RATE_LIMIT_PER_MINUTE = 60;

export interface FakeResponse {
  status: number;
  body?: unknown;
}

export class FakeArtisia {
  readonly sessions = new Map<string, FakeSession>();
  readonly bookings = new Map<string, FakeBooking>();
  /** Événements émis, pas encore livrés à Daisy. */
  pendingWebhooks: WebhookEvent[] = [];
  /** Journal des appels API reçus (pour vérifier le rate limit côté test). */
  readonly calls: { at: Date; method: string; path: string; status: number }[] = [];
  /** Appels qui n'ont pas atteint l'API (plateforme hors ligne). */
  unreachableCalls = 0;
  faults: Faults = { ...NO_FAULTS };

  private seq = 0;
  private lastUpdatedAt = 0;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
    readonly name = "artisia",
  ) {}

  // ---------------------------------------------------------------- Côté atelier (création)

  createSession(input: { externalRef: string | null; title: string; startsAt: Date; capacity?: number; durationMinutes?: number }): FakeSession {
    const session: FakeSession = {
      session_id: this.id("ses"),
      external_ref: input.externalRef,
      title: input.title,
      starts_at: input.startsAt.toISOString(),
      duration_minutes: input.durationMinutes ?? 120,
      capacity: input.capacity ?? 0,
      booked: 0,
      status: "published",
      updated_at: this.stamp(),
    };
    this.sessions.set(session.session_id, session);
    return session;
  }

  // ---------------------------------------------------------------- Côté clients Artisia

  /** Un client réserve sur la marketplace Artisia. Refusé s'il n'y a pas la place. */
  sell(sessionId: string, seats: number, customer = { name: "Client Artisia", email: "client@artisia.test" }) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "published") return { ok: false as const, error: "session_unavailable" };
    if (session.booked + seats > session.capacity) return { ok: false as const, error: "not_enough_seats" };

    session.booked += seats;
    session.updated_at = this.stamp();
    const booking: FakeBooking = { booking_id: this.id("bk"), session_id: sessionId, seats, status: "confirmed", customer };
    this.bookings.set(booking.booking_id, booking);
    this.emit("booking.created", { booking_id: booking.booking_id, session_id: sessionId, seats, customer });
    return { ok: true as const, booking };
  }

  cancelBooking(bookingId: string): boolean {
    const booking = this.bookings.get(bookingId);
    if (!booking || booking.status === "cancelled") return false;
    const session = this.sessions.get(booking.session_id)!;
    booking.status = "cancelled";
    session.booked -= booking.seats;
    session.updated_at = this.stamp();
    this.emit("booking.cancelled", {
      booking_id: bookingId,
      session_id: booking.session_id,
      seats: booking.seats,
      customer: booking.customer,
    });
    return true;
  }

  /** L'artisan modifie la capacité directement dans l'interface Artisia (hors Daisy). */
  artisanSetCapacity(sessionId: string, capacity: number): void {
    const session = this.sessions.get(sessionId)!;
    session.capacity = Math.max(capacity, session.booked);
    session.updated_at = this.stamp();
    this.emit("session.updated", { ...session });
  }

  // ---------------------------------------------------------------- API REST (ce que Daisy appelle)

  /** Sémantique de l'API, sans les pannes réseau (ajoutées par `fetch` ou par le serveur mock). */
  handle(method: string, path: string, body?: unknown): FakeResponse {
    const response = this.route(method, path, body);
    this.calls.push({ at: this.now(), method, path, status: response.status });
    return response;
  }

  private route(method: string, path: string, body?: unknown): FakeResponse {
    if (this.callsInCurrentMinute() >= RATE_LIMIT_PER_MINUTE) return { status: 429 };

    if (method === "GET" && path === "/sessions") {
      return { status: 200, body: { sessions: [...this.sessions.values()].map((s) => ({ ...s })) } };
    }

    const patch = path.match(/^\/sessions\/([^/]+)$/);
    if (method === "PATCH" && patch) {
      const session = this.sessions.get(decodeURIComponent(patch[1]));
      if (!session) return { status: 404, body: { error: "not_found" } };
      const input = (body ?? {}) as { capacity?: number; status?: FakeSession["status"] };
      if (input.capacity !== undefined && input.capacity < session.booked) {
        return { status: 409, body: { error: "capacity_below_booked", booked: session.booked } };
      }
      // Pas de contrôle de version : le dernier PATCH gagne, silencieusement (comme le vrai).
      if (input.capacity !== undefined) session.capacity = input.capacity;
      if (input.status !== undefined) session.status = input.status;
      session.updated_at = this.stamp();
      this.emit("session.updated", { ...session });
      return { status: 200, body: { ...session } };
    }

    return { status: 404, body: { error: "not_found" } };
  }

  private callsInCurrentMinute(): number {
    const minute = Math.floor(this.now().getTime() / 60_000);
    return this.calls.filter((c) => Math.floor(c.at.getTime() / 60_000) === minute).length;
  }

  /** `fetch` simulé, avec pannes, pour brancher le vrai ArtisiaClient sur ce faux. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v1/, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

    if (this.faults.down) {
      this.unreachableCalls++;
      throw new TypeError("fetch failed");
    }
    if (this.random() < this.faults.timeoutRate) {
      if (this.faults.applyOnTimeout) this.handle(method, path, body);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    if (this.random() < this.faults.serverErrorRate) return new Response(null, { status: 500 });

    const response = this.handle(method, path, body);
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  };

  client(apiKey = "test-key"): ArtisiaClient {
    return new ArtisiaClient({ baseUrl: "https://artisia.test/v1", apiKey, fetch: this.fetch });
  }

  // ---------------------------------------------------------------- Webhooks

  /**
   * Retire les webhooks en attente et applique les défauts de livraison :
   * pertes, doublons (2 ou 3 exemplaires) et, si demandé, désordre.
   */
  takeWebhooks(options: { shuffle?: boolean } = {}): WebhookEvent[] {
    const deliveries: WebhookEvent[] = [];
    for (const event of this.pendingWebhooks) {
      if (this.random() < this.faults.dropRate) continue;
      const copies = this.random() < this.faults.duplicateRate ? (this.random() < 0.5 ? 2 : 3) : 1;
      for (let i = 0; i < copies; i++) deliveries.push(event);
    }
    this.pendingWebhooks = [];
    if (options.shuffle) {
      for (let i = deliveries.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [deliveries[i], deliveries[j]] = [deliveries[j], deliveries[i]];
      }
    }
    return deliveries;
  }

  private emit(type: WebhookEvent["type"], data: Record<string, unknown>): void {
    // L'horloge d'Artisia dérive de quelques secondes par rapport à la nôtre.
    const occurredAt = new Date(this.now().getTime() + 3_000).toISOString();
    this.pendingWebhooks.push({ event_id: this.id("evt"), type, occurred_at: occurredAt, data });
  }

  private stamp(): string {
    // Horodatage strictement croissant, même si l'horloge de test ne bouge pas.
    this.lastUpdatedAt = Math.max(this.now().getTime() + 3_000, this.lastUpdatedAt + 1);
    return new Date(this.lastUpdatedAt).toISOString();
  }

  private id(prefix: string): string {
    return `${this.name}_${prefix}_${++this.seq}`;
  }
}
