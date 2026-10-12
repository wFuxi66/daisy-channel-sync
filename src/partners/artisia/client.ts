import { z } from "zod";
import { PartnerError, type PartnerApi, type PartnerSession, type SessionPatch } from "../types";

/** Au-delà, on abandonne l'appel : 10 % des réponses Artisia prennent 3 à 6 s. */
export const ARTISIA_TIMEOUT_MS = 8_000;

const sessionSchema = z.object({
  session_id: z.string(),
  external_ref: z.string().nullable(),
  title: z.string(),
  starts_at: z.coerce.date(),
  capacity: z.number().int().nonnegative(),
  booked: z.number().int().nonnegative(),
  status: z.string(),
  updated_at: z.coerce.date(),
});

export function toPartnerSession(raw: unknown): PartnerSession {
  const s = sessionSchema.parse(raw);
  return {
    sessionId: s.session_id,
    externalRef: s.external_ref,
    title: s.title,
    startsAt: s.starts_at,
    capacity: s.capacity,
    booked: s.booked,
    status: s.status,
    updatedAt: s.updated_at,
  };
}

export interface ArtisiaClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Client HTTP Artisia. Il ne réessaie jamais lui-même : il traduit chaque issue en résultat
 * ou en PartnerError typée, et c'est la file de jobs qui décide quand rejouer.
 */
export class ArtisiaClient implements PartnerApi {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ArtisiaClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listSessions(): Promise<PartnerSession[]> {
    const body = await this.request("GET", "/sessions");
    const sessions = z.object({ sessions: z.array(z.unknown()) }).parse(body).sessions;
    return sessions.map(toPartnerSession);
  }

  async updateSession(sessionId: string, patch: SessionPatch): Promise<PartnerSession> {
    const body = await this.request("PATCH", `/sessions/${encodeURIComponent(sessionId)}`, patch);
    return toPartnerSession(body);
  }

  private async request(method: string, path: string, payload?: unknown): Promise<unknown> {
    const { baseUrl, apiKey, timeoutMs = ARTISIA_TIMEOUT_MS } = this.options;
    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new PartnerError("timeout", `${method} ${path} : pas de réponse en ${timeoutMs} ms`);
      }
      throw new PartnerError("network", `${method} ${path} : ${error instanceof Error ? error.message : "erreur réseau"}`);
    }

    const body = await readJson(response);
    if (response.ok) return body;

    const message = `${method} ${path} : HTTP ${response.status}`;
    if (response.status === 429) throw new PartnerError("rate_limited", message, 429, body);
    if (response.status === 409) throw new PartnerError("conflict", message, 409, body);
    if (response.status >= 500) throw new PartnerError("server", message, response.status, body);
    throw new PartnerError("client", message, response.status, body);
  }
}

/** Les 500 Artisia arrivent sans corps : un corps absent ou illisible n'est pas une erreur en soi. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
