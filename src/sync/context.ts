import type { Sql } from "@/lib/db";
import type { PartnerApi } from "@/partners/types";

export interface PartnerConnection {
  id: string;
  studioId: string;
  provider: "artisia";
  label: string;
  apiBaseUrl: string;
  apiKey: string;
  webhookSecret: string;
  consecutiveFailures: number;
  degradedSince: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  lastReconciledAt: Date | null;
}

/**
 * Dépendances du moteur, injectées pour que les tests contrôlent le temps et les partenaires.
 * Le temps métier (échéances, backoff, fenêtres de rate limit) passe toujours par `now()`.
 */
export interface SyncContext {
  sql: Sql;
  now: () => Date;
  partnerFor: (connection: PartnerConnection) => PartnerApi;
}
