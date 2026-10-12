/**
 * Contrat minimal qu'un partenaire doit offrir pour que Daisy pilote ses disponibilités.
 * Volontairement réduit à ce dont le moteur a besoin : lire les sessions, régler leur capacité.
 */
export interface PartnerSession {
  sessionId: string;
  externalRef: string | null;
  title: string;
  startsAt: Date;
  capacity: number;
  booked: number;
  status: string;
  updatedAt: Date;
}

export interface SessionPatch {
  capacity?: number;
  status?: "published" | "cancelled";
}

export interface PartnerApi {
  listSessions(): Promise<PartnerSession[]>;
  updateSession(sessionId: string, patch: SessionPatch): Promise<PartnerSession>;
}

export type PartnerErrorKind =
  | "timeout" // pas de réponse dans le délai : l'appel a PEUT-ÊTRE été appliqué
  | "network" // connexion impossible
  | "server" // 5xx
  | "rate_limited" // 429
  | "conflict" // 409, réponse métier définitive
  | "client"; // autre 4xx : erreur de notre côté ou ressource disparue

export class PartnerError extends Error {
  constructor(
    readonly kind: PartnerErrorKind,
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "PartnerError";
  }

  /** Vaut-il la peine de réessayer plus tard ? */
  get retryable(): boolean {
    return this.kind === "timeout" || this.kind === "network" || this.kind === "server" || this.kind === "rate_limited";
  }

  /** L'échec dit-il quelque chose de la santé du partenaire ? (un 429 ou un 409 non) */
  get isOutage(): boolean {
    return this.kind === "timeout" || this.kind === "network" || this.kind === "server";
  }
}
