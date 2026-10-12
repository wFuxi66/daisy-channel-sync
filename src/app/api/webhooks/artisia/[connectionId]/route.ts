import { after } from "next/server";
import { productionContext } from "@/sync/runtime";
import { handleArtisiaWebhook } from "@/sync/webhooks";
import { runWorker } from "@/sync/worker";

/**
 * Réception des webhooks Artisia (une URL par connexion d'atelier).
 * Toute la logique est dans `handleArtisiaWebhook`, testée sans serveur HTTP.
 */
export async function POST(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  const ctx = productionContext();
  // Corps BRUT : la signature porte sur les octets reçus, pas sur un JSON re-sérialisé.
  const rawBody = await request.text();
  const result = await handleArtisiaWebhook(ctx, connectionId, rawBody, request.headers.get("x-artisia-signature"));

  // Les appels sortants (lents) partent après la réponse : Artisia a son 200 en quelques ms.
  if (result.status === 200) after(() => runWorker(ctx, { deadlineMs: 20_000 }));
  return Response.json(result.body, { status: result.status });
}
