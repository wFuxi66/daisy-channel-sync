/** Données de démo partagées par le seed (base) et le mock Artisia (mémoire). */

export const DEMO_STUDIO_ID = "5a1d0000-0000-4000-8000-000000000001";

export const DEMO_CONNECTIONS = [
  {
    id: "c0aa0000-0000-4000-8000-0000000000a1",
    label: "Artisia",
    apiKey: "demo_artisia_key",
    webhookSecret: "demo_artisia_whsec",
  },
  {
    // Deuxième plateforme simulée avec le même contrat d'API (seul l'adaptateur Artisia existe).
    id: "c0aa0000-0000-4000-8000-0000000000a2",
    label: "Atelio",
    apiKey: "demo_atelio_key",
    webhookSecret: "demo_atelio_whsec",
  },
] as const;

export const MOCK_PORT = Number(process.env.MOCK_ARTISIA_PORT ?? 4010);
export const MOCK_ORIGIN = `http://localhost:${MOCK_PORT}`;
