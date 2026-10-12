import { productionContext } from "@/sync/runtime";
import { runSyncTick } from "@/sync/worker";

export const maxDuration = 60;

/**
 * Filet de sécurité appelé chaque minute (Vercel Cron, ou pg_cron sur le plan Hobby) :
 * rejeu des webhooks en attente, réconciliations de routine, vidage de la file de synchro.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runSyncTick(productionContext(), { deadlineMs: 45_000 });
  return Response.json(result);
}
