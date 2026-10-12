/**
 * Jeu de démo : un atelier, deux plateformes partenaires (mock local), une semaine de créneaux.
 * Les sessions sont créées chez le mock avec `external_ref = daisy_slot_<id>` ; c'est la
 * réconciliation qui les relie aux créneaux Daisy, comme elle le ferait en production.
 */
import { createSql } from "../src/lib/db";
import { ArtisiaClient } from "../src/partners/artisia/client";
import { externalRefForSlot } from "../src/sync/reconcile";
import { runSyncTick } from "../src/sync/worker";
import { DEMO_CONNECTIONS, DEMO_STUDIO_ID, MOCK_ORIGIN } from "./demo-data";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL manquant (voir .env.example)");
const sql = createSql(url, { max: 2, onnotice: () => {} });

await sql`truncate studios, partner_connections, slots, listings, bookings, inbound_events,
          sync_jobs, partner_rate_windows, alerts restart identity cascade`;
await sql`insert into studios (id, name, partner_window) values (${DEMO_STUDIO_ID}, 'Atelier Terre & Feu', 2)`;
for (const c of DEMO_CONNECTIONS) {
  await sql`
    insert into partner_connections (id, studio_id, provider, label, api_base_url, api_key, webhook_secret)
    values (${c.id}, ${DEMO_STUDIO_ID}, 'artisia', ${c.label}, ${`${MOCK_ORIGIN}/v1`}, ${c.apiKey}, ${c.webhookSecret})`;
}

const courses = [
  { title: "Tour de potier — débutant", capacity: 8, hour: 14 },
  { title: "Modelage libre", capacity: 6, hour: 10 },
  { title: "Émaillage", capacity: 4, hour: 18 },
];
const slots: { id: string; title: string; startsAt: Date }[] = [];
for (let day = 1; day <= 6; day++) {
  const course = courses[day % courses.length];
  const startsAt = new Date();
  startsAt.setDate(startsAt.getDate() + day);
  startsAt.setHours(course.hour, 0, 0, 0);
  const [slot] = await sql<{ id: string }[]>`
    insert into slots (studio_id, title, starts_at, duration_minutes, capacity)
    values (${DEMO_STUDIO_ID}, ${course.title}, ${startsAt}, 120, ${course.capacity}) returning id`;
  slots.push({ id: slot.id, title: course.title, startsAt });
}

let mockReachable = true;
for (const c of DEMO_CONNECTIONS) {
  for (const slot of slots) {
    const response = await fetch(`${MOCK_ORIGIN}/_sim/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ external_ref: externalRefForSlot(slot.id), title: slot.title, starts_at: slot.startsAt.toISOString() }),
    }).catch(() => null);
    if (!response?.ok) mockReachable = false;
  }
}

if (mockReachable) {
  // Premier passage : réconciliation (liaison des sessions) puis envoi des capacités.
  const ctx = {
    sql,
    now: () => new Date(),
    partnerFor: (conn: { apiBaseUrl: string; apiKey: string }) => new ArtisiaClient({ baseUrl: conn.apiBaseUrl, apiKey: conn.apiKey }),
  };
  for (let i = 0; i < 3; i++) await runSyncTick(ctx, { deadlineMs: 30_000 });
  console.log(`Seed OK : ${slots.length} créneaux, ${DEMO_CONNECTIONS.length} partenaires reliés.`);
} else {
  console.warn(`Seed en base OK, mais mock Artisia injoignable sur ${MOCK_ORIGIN} : lancer \`npm run mock:artisia\` puis relancer le seed.`);
}
await sql.end();
