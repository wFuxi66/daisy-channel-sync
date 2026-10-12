import { describe, expect, it } from "vitest";
import { ArtisiaClient } from "@/partners/artisia/client";
import { PartnerError } from "@/partners/types";

const session = {
  session_id: "art_ses_8812",
  external_ref: "daisy_slot_4471",
  title: "Tour de potier débutant",
  starts_at: "2027-01-16T14:00:00+01:00",
  duration_minutes: 120,
  capacity: 8,
  booked: 3,
  status: "published",
  updated_at: "2027-01-09T11:22:04Z",
};

function clientReturning(response: () => Promise<Response> | Response, timeoutMs = 50) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return response();
  };
  return { client: new ArtisiaClient({ baseUrl: "https://api.artisia.example/v1/", apiKey: "k", timeoutMs, fetch: fetchStub }), calls };
}

async function errorOf(promise: Promise<unknown>): Promise<PartnerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PartnerError) return error;
    throw error;
  }
  throw new Error("aucune erreur levée");
}

describe("ArtisiaClient", () => {
  it("envoie le PATCH authentifié et traduit la session", async () => {
    const { client, calls } = clientReturning(() => Response.json({ ...session, capacity: 6 }));
    const result = await client.updateSession("art_ses_8812", { capacity: 6 });

    expect(calls[0].url).toBe("https://api.artisia.example/v1/sessions/art_ses_8812");
    expect(calls[0].init?.method).toBe("PATCH");
    expect(calls[0].init?.body).toBe('{"capacity":6}');
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer k");
    expect(result).toMatchObject({ sessionId: "art_ses_8812", capacity: 6, booked: 3, externalRef: "daisy_slot_4471" });
    expect(result.updatedAt.toISOString()).toBe("2027-01-09T11:22:04.000Z");
  });

  it("500 sans corps → erreur serveur, rejouable, comptée comme panne", async () => {
    const { client } = clientReturning(() => new Response(null, { status: 500 }));
    const error = await errorOf(client.listSessions());
    expect(error).toMatchObject({ kind: "server", status: 500, retryable: true, isOutage: true });
  });

  it("409 → conflit métier avec son corps, non rejouable tel quel", async () => {
    const { client } = clientReturning(() => Response.json({ error: "capacity_below_booked", booked: 7 }, { status: 409 }));
    const error = await errorOf(client.updateSession("s", { capacity: 6 }));
    expect(error).toMatchObject({ kind: "conflict", retryable: false, body: { booked: 7 } });
  });

  it("429 → rejouable mais pas une panne du partenaire", async () => {
    const { client } = clientReturning(() => new Response(null, { status: 429 }));
    expect(await errorOf(client.listSessions())).toMatchObject({ kind: "rate_limited", retryable: true, isOutage: false });
  });

  it("404 → erreur client, non rejouable", async () => {
    const { client } = clientReturning(() => Response.json({ error: "not_found" }, { status: 404 }));
    expect(await errorOf(client.updateSession("x", { capacity: 1 }))).toMatchObject({ kind: "client", retryable: false });
  });

  it("pas de réponse dans le délai → timeout (l'appel a peut-être été appliqué)", async () => {
    const fetchStub: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const client = new ArtisiaClient({ baseUrl: "https://x/v1", apiKey: "k", timeoutMs: 20, fetch: fetchStub });
    expect(await errorOf(client.listSessions())).toMatchObject({ kind: "timeout", retryable: true, isOutage: true });
  });

  it("connexion impossible → erreur réseau", async () => {
    const { client } = clientReturning(() => Promise.reject(new TypeError("fetch failed")));
    expect(await errorOf(client.listSessions())).toMatchObject({ kind: "network", retryable: true });
  });
});
