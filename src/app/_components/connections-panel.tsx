import { togglePartnerOutageAction } from "@/app/actions";
import type { ConnectionView } from "@/sync/dashboard";
import { formatAgo, formatTime } from "./format";

const HEALTH_STYLE = {
  ok: "bg-emerald-100 text-emerald-800",
  unstable: "bg-amber-100 text-amber-800",
  offline: "bg-red-100 text-red-800",
} as const;

function healthLabel(connection: ConnectionView, now: Date): string {
  if (connection.health === "offline" && connection.degradedSince) {
    return `Injoignable depuis ${formatTime(connection.degradedSince)} (${formatAgo(connection.degradedSince, now).replace("il y a ", "")})`;
  }
  if (connection.health === "unstable") return "Réponses instables";
  return "Synchronisé";
}

export function ConnectionsPanel({ connections, now, demo }: { connections: ConnectionView[]; now: Date; demo: boolean }) {
  return (
    <section className="grid gap-3 sm:grid-cols-2">
      {connections.map((c) => (
        <article key={c.id} className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold">{c.label}</h3>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${HEALTH_STYLE[c.health]}`}>{healthLabel(c, now)}</span>
          </div>
          <dl className="mt-3 space-y-1 text-sm text-stone-600">
            <div>
              Dernier échange réussi : {c.lastSuccessAt ? formatAgo(c.lastSuccessAt, now) : "jamais"}
            </div>
            <div>
              Mises à jour en attente : <strong>{c.pendingSyncs}</strong>
            </div>
            <div>Dernière vérification complète : {c.lastReconciledAt ? formatAgo(c.lastReconciledAt, now) : "jamais"}</div>
          </dl>
          {c.health === "offline" && (
            <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-900">
              {c.label} ne répond plus. Vos ventes Daisy continuent normalement. Les places déjà confiées à {c.label} restent
              réservées à {c.label} : aucune surréservation n&apos;est possible. Tout se remettra à jour automatiquement à son retour.
            </p>
          )}
          {demo && (
            <form action={togglePartnerOutageAction} className="mt-3 flex gap-2 text-xs">
              <input type="hidden" name="connectionId" value={c.id} />
              <button name="down" value="1" className="rounded border border-stone-300 px-2 py-1 hover:bg-stone-100">
                Démo : couper {c.label}
              </button>
              <button name="down" value="0" className="rounded border border-stone-300 px-2 py-1 hover:bg-stone-100">
                Rétablir
              </button>
            </form>
          )}
        </article>
      ))}
    </section>
  );
}
