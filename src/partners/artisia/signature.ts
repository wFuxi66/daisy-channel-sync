import { createHmac, timingSafeEqual } from "node:crypto";

/** En-tête `X-Artisia-Signature: sha256=<hmac hex>`, calculé sur le corps brut. */
export function signArtisiaPayload(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

/**
 * Vérifie sur le corps BRUT (avant tout JSON.parse : un re-sérialisé ne donnerait pas les mêmes octets)
 * et en temps constant, pour ne pas laisser deviner la signature octet par octet.
 */
export function verifyArtisiaSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(signArtisiaPayload(rawBody, secret), "utf8");
  const received = Buffer.from(header.trim(), "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
