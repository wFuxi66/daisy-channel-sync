import { cancelSlotAction, simulatePartnerSaleAction } from "@/app/actions";
import type { ChannelView, SlotView } from "@/sync/dashboard";
import { formatAgo, formatSlotDate } from "./format";
import { BookingForm, CapacityForm } from "./slot-forms";

const SYNC_LABEL: Record<ChannelView["syncState"], { text: string; style: string }> = {
  synced: { text: "à jour", style: "text-emerald-700" },
  pending: { text: "mise à jour en attente", style: "text-amber-700" },
  unconfirmed: { text: "envoi non confirmé", style: "text-amber-700" },
};

function ChannelLine({ channel, now, demo }: { channel: ChannelView; now: Date; demo: boolean }) {
  const sync = SYNC_LABEL[channel.syncState];
  return (
    <li className="flex flex-wrap items-center gap-x-2 text-xs">
      <span className="font-medium">{channel.label}</span>
      <span>
        {channel.sold} vendue(s) · {channel.onSale} en vente
      </span>
      <span className={sync.style} title={channel.lastSyncError ?? undefined}>
        {sync.text}
        {channel.syncState !== "synced" && channel.lastSyncedAt ? ` (dernière synchro ${formatAgo(channel.lastSyncedAt, now)})` : ""}
      </span>
      {demo && (
        <form action={simulatePartnerSaleAction}>
          <input type="hidden" name="listingId" value={channel.listingId} />
          <button className="rounded border border-dashed border-stone-300 px-1.5 text-[11px] text-stone-500 hover:bg-stone-100">
            démo : 1 vente {channel.label}
          </button>
        </form>
      )}
    </li>
  );
}

export function SlotsTable({ slots, now, demo }: { slots: SlotView[]; now: Date; demo: boolean }) {
  if (slots.length === 0) return <p className="text-sm text-stone-500">Aucun créneau à venir.</p>;
  return (
    <div className="space-y-3">
      {slots.map((slot) => {
        const a = slot.availability;
        const sold = a.soldDirect + a.soldPartners;
        const cancelled = slot.status === "cancelled";
        return (
          <article key={slot.id} className={`rounded-xl border bg-white p-4 ${a.overbookedBy > 0 ? "border-red-300" : "border-stone-200"}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="font-semibold">
                  {slot.title} {cancelled && <span className="text-sm font-normal text-red-700">(annulé)</span>}
                </h3>
                <p className="text-sm text-stone-500">{formatSlotDate(slot.startsAt)}</p>
              </div>
              <p className="text-sm">
                <strong>{sold}</strong>/{slot.capacity} places vendues
                {a.overbookedBy > 0 && <span className="ml-2 font-semibold text-red-700">{a.overbookedBy} en trop</span>}
              </p>
            </div>

            <ul className="mt-3 space-y-1">
              <li className="text-xs">
                <span className="font-medium">Daisy (direct)</span> · {a.soldDirect} vendue(s) · {a.directAvailable} en vente
              </li>
              {slot.channels.map((channel) => (
                <ChannelLine key={channel.listingId} channel={channel} now={now} demo={demo} />
              ))}
            </ul>

            {!cancelled && (
              <div className="mt-3 flex flex-wrap items-start gap-4 border-t border-stone-100 pt-3">
                <BookingForm slotId={slot.id} disabled={a.directAvailable === 0} />
                <CapacityForm slotId={slot.id} capacity={slot.capacity} />
                <form action={cancelSlotAction}>
                  <input type="hidden" name="slotId" value={slot.id} />
                  <button className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50">Annuler le créneau</button>
                </form>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
