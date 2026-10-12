"use client";

import { useActionState } from "react";
import { bookDirectAction, updateCapacityAction, syncNowAction, type ActionResult } from "@/app/actions";

function Feedback({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return <p className={`text-xs ${state.ok ? "text-emerald-700" : "text-red-700"}`}>{state.message}</p>;
}

export function BookingForm({ slotId, disabled }: { slotId: string; disabled: boolean }) {
  const [state, action, pending] = useActionState(bookDirectAction, null);
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="slotId" value={slotId} />
      <div className="flex flex-wrap gap-1">
        <input name="customerName" placeholder="Nom" required className="w-28 rounded border border-stone-300 px-2 py-1 text-xs" />
        <input name="customerEmail" type="email" placeholder="Email" required className="w-36 rounded border border-stone-300 px-2 py-1 text-xs" />
        <input name="seats" type="number" min={1} max={10} defaultValue={1} className="w-12 rounded border border-stone-300 px-2 py-1 text-xs" />
        <button disabled={disabled || pending} className="rounded bg-stone-900 px-2 py-1 text-xs text-white disabled:opacity-40">
          {pending ? "…" : "Réserver"}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function CapacityForm({ slotId, capacity }: { slotId: string; capacity: number }) {
  const [state, action, pending] = useActionState(updateCapacityAction, null);
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="slotId" value={slotId} />
      <div className="flex gap-1">
        <input name="capacity" type="number" min={0} defaultValue={capacity} className="w-14 rounded border border-stone-300 px-2 py-1 text-xs" />
        <button disabled={pending} className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-100">
          Capacité
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function SyncNowButton() {
  const [state, action, pending] = useActionState(syncNowAction, null);
  return (
    <form action={action} className="flex items-center gap-3">
      <Feedback state={state} />
      <button disabled={pending} className="rounded-lg bg-stone-900 px-3 py-2 text-sm text-white disabled:opacity-50">
        {pending ? "Synchronisation…" : "Synchroniser maintenant"}
      </button>
    </form>
  );
}
