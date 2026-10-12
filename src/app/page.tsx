import { connection } from "next/server";
import { Suspense } from "react";
import { getSql } from "@/lib/db";
import { getDashboard } from "@/sync/dashboard";
import { resolveAlertAction } from "./actions";
import { ConnectionsPanel } from "./_components/connections-panel";
import { SyncNowButton } from "./_components/slot-forms";
import { SlotsTable } from "./_components/slots-table";

export default function Page() {
  return (
    <main className="mx-auto max-w-4xl space-y-8 px-4 py-8">
      <Suspense fallback={<p className="text-sm text-stone-500">Chargement…</p>}>
        <StudioDashboard />
      </Suspense>
    </main>
  );
}

async function StudioDashboard() {
  await connection(); // données temps réel : rendu à chaque requête
  const sql = getSql();
  // Démo mono-atelier : en production, l'atelier vient de la session de l'artisan.
  const [studio] = await sql<{ id: string }[]>`select id from studios order by created_at limit 1`;
  if (!studio) return <p>Aucun atelier. Lancer <code>npm run db:seed</code>.</p>;

  const now = new Date();
  const dashboard = await getDashboard(sql, studio.id, now);
  if (!dashboard) return null;
  const demo = process.env.DEMO_MODE === "1";

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-stone-500">{dashboard.studio.name}</p>
          <h1 className="text-2xl font-semibold">Canaux de vente</h1>
          <p className="mt-1 max-w-xl text-sm text-stone-600">
            Chaque place appartient à un seul canal à la fois. Les plateformes partenaires reçoivent au plus{" "}
            {dashboard.studio.partnerWindow} place(s) invendue(s) chacune ; les dernières places restent sur Daisy.
          </p>
        </div>
        <SyncNowButton />
      </header>

      <ConnectionsPanel connections={dashboard.connections} now={now} demo={demo} />

      {dashboard.alerts.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">À traiter</h2>
          {dashboard.alerts.map((alert) => (
            <div key={alert.id} className="flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
              <p>{alert.message}</p>
              <form action={resolveAlertAction}>
                <input type="hidden" name="alertId" value={alert.id} />
                <button className="shrink-0 text-xs text-stone-600 underline">Marquer comme traité</button>
              </form>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-semibold">Prochains créneaux</h2>
        <SlotsTable slots={dashboard.slots} now={now} demo={demo} />
      </section>
    </>
  );
}
