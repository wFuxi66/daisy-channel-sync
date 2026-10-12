/**
 * Serveur Artisia simulé pour la démo locale, avec le comportement de l'annexe :
 * latence (85 % < 300 ms, 10 % entre 3 et 6 s), 500 sans corps (4 %), 429 au-delà de 60 appels/min,
 * webhooks signés, parfois dupliqués et désordonnés, rejoués à 1 min, 5 min, 30 min puis 2 h.
 *
 * Plusieurs comptes (un par clé API) : chaque connexion de démo a le sien.
 * État en mémoire : relancer le seed après un redémarrage du mock.
 */
import http from "node:http";
import { FakeArtisia, type WebhookEvent } from "../src/partners/artisia/fake";
import { signArtisiaPayload } from "../src/partners/artisia/signature";
import { DEMO_CONNECTIONS, MOCK_PORT } from "./demo-data";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
/** Accélère la politique de réessai pour la démo (0.05 → 1 min devient 3 s). */
const RETRY_SCALE = Number(process.env.MOCK_RETRY_SCALE ?? 0.05);
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];

interface Delivery {
  event: WebhookEvent;
  attempt: number;
  dueAt: number;
}

interface Tenant {
  label: string;
  apiKey: string;
  secret: string;
  webhookUrl: string;
  fake: FakeArtisia;
  down: boolean;
  queue: Delivery[];
}

const tenants = new Map<string, Tenant>(
  DEMO_CONNECTIONS.map((c) => {
    const fake = new FakeArtisia(() => new Date(), Math.random, c.label.toLowerCase());
    fake.faults.duplicateRate = 0.02;
    return [
      c.apiKey,
      {
        label: c.label,
        apiKey: c.apiKey,
        secret: c.webhookSecret,
        webhookUrl: `${APP_URL}/api/webhooks/artisia/${c.id}`,
        fake,
        down: false,
        queue: [],
      },
    ];
  }),
);

function send(res: http.ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${MOCK_PORT}`);
  const tenant = tenants.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
  if (url.pathname === "/_sim/state" && req.method === "GET") {
    return send(res, 200, [...tenants.values()].map((t) => ({ label: t.label, down: t.down, sessions: [...t.fake.sessions.values()] })));
  }
  if (!tenant) return send(res, 401, { error: "unauthorized" });
  const body = await readBody(req).catch(() => undefined);

  // ---- Pilotage de la démo
  if (url.pathname === "/_sim/outage" && req.method === "POST") {
    tenant.down = Boolean((body as { down?: boolean })?.down);
    console.log(`[${tenant.label}] ${tenant.down ? "HORS LIGNE" : "de retour"}`);
    return send(res, 200, { down: tenant.down });
  }
  if (url.pathname === "/_sim/sessions" && req.method === "POST") {
    const input = body as { external_ref: string | null; title: string; starts_at: string };
    const session = tenant.fake.createSession({ externalRef: input.external_ref, title: input.title, startsAt: new Date(input.starts_at) });
    return send(res, 201, session);
  }
  const sell = url.pathname.match(/^\/_sim\/sessions\/([^/]+)\/sell$/);
  if (sell && req.method === "POST") {
    const result = tenant.fake.sell(decodeURIComponent(sell[1]), (body as { seats?: number })?.seats ?? 1);
    console.log(`[${tenant.label}] vente client ${sell[1]} : ${result.ok ? "OK" : result.error}`);
    return send(res, result.ok ? 201 : 409, result);
  }

  // ---- API Artisia, avec ses défauts
  if (!url.pathname.startsWith("/v1/")) return send(res, 404, { error: "not_found" });
  if (tenant.down) return req.socket.destroy(); // connexion coupée, comme une plateforme hors ligne

  const roll = Math.random();
  await sleep(roll < 0.85 ? 50 + Math.random() * 250 : roll < 0.95 ? 3000 + Math.random() * 3000 : 100);
  if (Math.random() < 0.04) {
    res.writeHead(500);
    return res.end();
  }
  const response = tenant.fake.handle(req.method ?? "GET", url.pathname.replace(/^\/v1/, ""), body);
  console.log(`[${tenant.label}] ${req.method} ${url.pathname} ${body ? JSON.stringify(body) : ""} → ${response.status}`);
  return send(res, response.status, response.body);
});

/** Pompe à webhooks : signature, doublons, léger désordre, politique de réessai d'Artisia. */
setInterval(async () => {
  const now = Date.now();
  for (const tenant of tenants.values()) {
    if (tenant.down) continue; // plateforme hors ligne : rien ne part
    for (const event of tenant.fake.takeWebhooks()) {
      tenant.queue.push({ event, attempt: 0, dueAt: now + Math.random() * 2000 });
    }
    const due = tenant.queue.filter((d) => d.dueAt <= now);
    tenant.queue = tenant.queue.filter((d) => d.dueAt > now);
    for (const delivery of due) {
      const raw = JSON.stringify(delivery.event);
      const ok = await fetch(tenant.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Artisia-Signature": signArtisiaPayload(raw, tenant.secret) },
        body: raw,
        signal: AbortSignal.timeout(5000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) continue;
      if (delivery.attempt >= RETRY_DELAYS_MS.length) {
        console.log(`[${tenant.label}] webhook ${delivery.event.event_id} abandonné définitivement`);
        continue;
      }
      tenant.queue.push({ ...delivery, attempt: delivery.attempt + 1, dueAt: now + RETRY_DELAYS_MS[delivery.attempt] * RETRY_SCALE });
    }
  }
}, 1000);

server.listen(MOCK_PORT, () => {
  console.log(`Mock Artisia sur http://localhost:${MOCK_PORT} — webhooks vers ${APP_URL}`);
});
