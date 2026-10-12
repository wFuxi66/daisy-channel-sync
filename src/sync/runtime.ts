import { getSql } from "@/lib/db";
import { ArtisiaClient } from "@/partners/artisia/client";
import type { SyncContext } from "./context";

/** Contexte de production : vraie horloge, vrais clients HTTP. */
export function productionContext(): SyncContext {
  return {
    sql: getSql(),
    now: () => new Date(),
    partnerFor: (connection) => new ArtisiaClient({ baseUrl: connection.apiBaseUrl, apiKey: connection.apiKey }),
  };
}
