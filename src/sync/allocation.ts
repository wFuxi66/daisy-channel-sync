/**
 * Règles d'allotement — fonctions pures, sans base ni réseau.
 *
 * Invariant central : ventes directes + Σ places détenues par les partenaires <= capacité.
 * Une place « détenue » par un partenaire est une place qu'il PEUT vendre sans nous demander
 * notre avis : c'est la capacité qu'on lui a poussée (ou qu'on a peut-être poussée).
 */

export interface ListingState {
  id: string;
  connectionId: string;
  externalSessionId: string;
  confirmedCapacity: number;
  inflightCapacity: number | null;
  partnerBooked: number;
  partnerStatus: string;
  /** Places des réservations partenaires connues de Daisy (webhooks traités). */
  knownBooked: number;
}

export interface SlotState {
  id: string;
  studioId: string;
  capacity: number;
  status: "scheduled" | "cancelled";
  startsAt: Date;
  partnerWindow: number;
  directSold: number;
  listings: ListingState[];
}

/** Places vendues chez le partenaire : on retient la plus haute des deux sources. */
export function bookedOnPartner(listing: ListingState): number {
  return Math.max(listing.partnerBooked, listing.knownBooked);
}

/**
 * Places comptées comme détenues par le partenaire, de façon pessimiste : sa capacité (même
 * non confirmée, il l'a peut-être appliquée) ou ses ventes connues si elles sont plus hautes
 * (capacité modifiée sans nous, ou annulation jamais reçue). Surestimer ici est sans danger :
 * cela retire des places au pool direct, cela n'en donne à personne.
 */
export function heldByPartner(listing: ListingState): number {
  return Math.max(listing.confirmedCapacity, listing.inflightCapacity ?? 0, bookedOnPartner(listing));
}

export function isOnSale(slot: SlotState, now: Date): boolean {
  return slot.status === "scheduled" && slot.startsAt.getTime() > now.getTime();
}

export interface Availability {
  /** Ce que le widget et le back-office peuvent vendre tout de suite, sans risque. */
  directAvailable: number;
  /** Places confiées aux partenaires (vendues ou non). */
  heldByPartners: number;
  soldDirect: number;
  soldPartners: number;
  /** Places vendues au-delà de la capacité : surréservation avérée. */
  overbookedBy: number;
  /** Places promises au-delà de la capacité : surréservation possible tant que ce n'est pas résorbé. */
  overcommittedBy: number;
}

export function computeAvailability(slot: SlotState, now: Date): Availability {
  const heldByPartners = sum(slot.listings.map(heldByPartner));
  const soldPartners = sum(slot.listings.map(bookedOnPartner));
  const free = slot.capacity - slot.directSold - heldByPartners;
  return {
    directAvailable: isOnSale(slot, now) ? Math.max(0, free) : 0,
    heldByPartners,
    soldDirect: slot.directSold,
    soldPartners,
    overbookedBy: Math.max(0, slot.directSold + soldPartners - slot.capacity),
    overcommittedBy: Math.max(0, -free),
  };
}

/**
 * Capacité qu'on VOUDRAIT voir chez un partenaire : ses ventes + une petite vitrine de places libres.
 *
 * La vitrine est plafonnée à `partnerWindow` et à une part équitable des places restantes,
 * Daisy direct comptant comme une part. Conséquence voulue : les toutes dernières places
 * restent dans le pool direct (garantie transactionnelle, pas de commission).
 */
export function targetPartnerCapacity(slot: SlotState, listing: ListingState, now: Date): number {
  const booked = bookedOnPartner(listing);
  if (!isOnSale(slot, now)) return booked;

  const remaining = slot.capacity - slot.directSold - sum(slot.listings.map(bookedOnPartner));
  const fairShare = Math.floor(Math.max(0, remaining) / (slot.listings.length + 1));
  return booked + Math.min(slot.partnerWindow, fairShare);
}

export interface ListingPlan {
  capacity: number;
  status: "published" | "cancelled" | undefined;
}

/**
 * Capacité que le partenaire a peut-être en ce moment : la confirmée, ou une envoyée sans réponse.
 * C'est elle, et non le nombre de ventes, qui borne ce que le partenaire peut vendre.
 */
export function capacityBound(listing: ListingState): number {
  return Math.max(listing.confirmedCapacity, listing.inflightCapacity ?? 0);
}

/**
 * Plafond de capacité pour ce partenaire : ce qui reste une fois retirées les ventes directes
 * et les places détenues par les AUTRES partenaires. Le respecter garantit l'invariant.
 */
export function partnerCeiling(slot: SlotState, listing: ListingState): number {
  const others = slot.listings.filter((l) => l.id !== listing.id);
  return slot.capacity - slot.directSold - sum(others.map(heldByPartner));
}

/**
 * Ce qu'il faut envoyer au partenaire, ou null si tout est déjà aligné.
 *
 * Règle « reprendre avant de donner » : la capacité poussée ne dépasse jamais le plafond,
 * calculé avec les places des autres canaux telles qu'elles sont détenues À CET INSTANT
 * (y compris les envois non confirmés). Reprendre est toujours permis : c'est le partenaire
 * qui arbitre, il refuse de descendre sous ses ventes (409).
 *
 * Seule exception au plafond : on ne vise pas sous les ventes annoncées par le partenaire
 * (le PATCH serait refusé en boucle). Cela ne fait que fermer la vente chez lui, sans jamais
 * lui ouvrir de place au-delà de ce qu'il a déjà peut-être.
 */
export function planListingUpdate(slot: SlotState, listing: ListingState, now: Date): ListingPlan | null {
  const target = targetPartnerCapacity(slot, listing, now);
  const floor = Math.min(listing.partnerBooked, capacityBound(listing));
  const capacity = Math.max(floor, Math.min(target, partnerCeiling(slot, listing)));

  // On ne republie jamais une session que le partenaire a fermée : on ne pousse que l'annulation.
  const status = slot.status === "cancelled" && listing.partnerStatus !== "cancelled" ? "cancelled" : undefined;

  const aligned = capacity === listing.confirmedCapacity && listing.inflightCapacity === null;
  if (aligned && status === undefined) return null;
  return { capacity, status };
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}
