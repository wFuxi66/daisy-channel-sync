import { describe, expect, it } from "vitest";
import {
  computeAvailability,
  heldByPartner,
  planListingUpdate,
  targetPartnerCapacity,
  type ListingState,
  type SlotState,
} from "@/sync/allocation";

const now = new Date("2027-01-10T09:00:00Z");

function listing(overrides: Partial<ListingState> = {}): ListingState {
  return {
    id: "l1",
    connectionId: "c1",
    externalSessionId: "s1",
    confirmedCapacity: 0,
    inflightCapacity: null,
    partnerBooked: 0,
    partnerStatus: "published",
    knownBooked: 0,
    ...overrides,
  };
}

function slot(overrides: Partial<SlotState> = {}): SlotState {
  return {
    id: "slot",
    studioId: "studio",
    capacity: 8,
    status: "scheduled",
    startsAt: new Date("2027-01-16T13:00:00Z"),
    partnerWindow: 2,
    directSold: 0,
    listings: [],
    ...overrides,
  };
}

describe("places détenues par un partenaire", () => {
  it("compte une capacité envoyée mais non confirmée (elle a peut-être été appliquée)", () => {
    expect(heldByPartner(listing({ confirmedCapacity: 2, inflightCapacity: 4 }))).toBe(4);
  });

  it("ne descend jamais sous les ventes du partenaire, même si notre capacité connue est en retard", () => {
    expect(heldByPartner(listing({ confirmedCapacity: 2, partnerBooked: 3 }))).toBe(3);
    expect(heldByPartner(listing({ confirmedCapacity: 2, knownBooked: 5 }))).toBe(5);
  });
});

describe("disponibilité directe", () => {
  it("retire du pool direct tout ce qui est confié aux partenaires", () => {
    const s = slot({ directSold: 3, listings: [listing({ confirmedCapacity: 2 }), listing({ id: "l2", confirmedCapacity: 2 })] });
    expect(computeAvailability(s, now).directAvailable).toBe(1);
  });

  it("est nulle pour un créneau annulé ou déjà commencé", () => {
    expect(computeAvailability(slot({ status: "cancelled" }), now).directAvailable).toBe(0);
    expect(computeAvailability(slot({ startsAt: new Date("2027-01-10T08:00:00Z") }), now).directAvailable).toBe(0);
  });

  it("distingue surréservation avérée (vendu) et sur-engagement (promis)", () => {
    // Capacité réduite à 4 par l'artisan alors que 3 places sont vendues et 2 confiées à un partenaire.
    const s = slot({ capacity: 4, directSold: 3, listings: [listing({ confirmedCapacity: 2, partnerBooked: 1 })] });
    const a = computeAvailability(s, now);
    expect(a.overbookedBy).toBe(0); // 3 + 1 vendues <= 4
    expect(a.overcommittedBy).toBe(1); // 3 + 2 promises > 4
  });
});

describe("cible d'allotement", () => {
  it("donne à chaque partenaire une vitrine plafonnée par la fenêtre", () => {
    const s = slot({ listings: [listing(), listing({ id: "l2" })] });
    // 8 places restantes, 3 canaux : part équitable 2, fenêtre 2.
    expect(targetPartnerCapacity(s, s.listings[0], now)).toBe(2);
  });

  it("ajoute la vitrine aux ventes déjà faites chez le partenaire", () => {
    const l = listing({ partnerBooked: 3, confirmedCapacity: 4 });
    const s = slot({ listings: [l] });
    // Restant 5, 2 canaux : part 2, fenêtre 2 → 3 vendues + 2.
    expect(targetPartnerCapacity(s, l, now)).toBe(5);
  });

  it("garde les dernières places pour la vente directe", () => {
    const l = listing({ confirmedCapacity: 1 });
    // 7 vendues en direct, 1 restante, 2 canaux : part équitable 0.
    const s = slot({ directSold: 7, listings: [l] });
    expect(targetPartnerCapacity(s, l, now)).toBe(0);
  });

  it("ferme la vente partenaire sur un créneau annulé (capacité = ventes)", () => {
    const l = listing({ partnerBooked: 2, confirmedCapacity: 4 });
    expect(targetPartnerCapacity(slot({ status: "cancelled", listings: [l] }), l, now)).toBe(2);
  });

  it("partenaire_window = 0 désactive la vente partenaire de nouvelles places", () => {
    const l = listing();
    expect(targetPartnerCapacity(slot({ partnerWindow: 0, listings: [l] }), l, now)).toBe(0);
  });
});

describe("plan de mise à jour", () => {
  it("ne propose rien quand tout est aligné", () => {
    const l = listing({ confirmedCapacity: 2 });
    const s = slot({ listings: [l, listing({ id: "l2", confirmedCapacity: 2 })] });
    expect(planListingUpdate(s, s.listings[0], now)).toBeNull();
  });

  it("ne donne jamais plus que le pool direct n'a de libre (reprendre avant de donner)", () => {
    // Le partenaire B détient encore 5 places (réduction pas encore confirmée) : A ne peut recevoir qu'1 place.
    const a = listing({ id: "a" });
    const b = listing({ id: "b", confirmedCapacity: 5 });
    const s = slot({ directSold: 2, listings: [a, b] });
    expect(planListingUpdate(s, a, now)).toEqual({ capacity: 1, status: undefined });
  });

  it("une réservation fantôme (annulation jamais reçue) ne se transforme jamais en place ouverte", () => {
    // Daisy croit Artisia à 3 ventes (une annulation perdue), Artisia en a 2 pour une capacité de 2.
    const artisia = listing({ id: "a", confirmedCapacity: 2, partnerBooked: 2, knownBooked: 3 });
    const atelio = listing({ id: "b", confirmedCapacity: 1 });
    const s = slot({ capacity: 11, directSold: 8, listings: [artisia, atelio] });
    // Cible naïve : 3 ventes + vitrine. Plafond réel : 11 - 8 - 1 = 2. On reste à 2.
    expect(planListingUpdate(s, artisia, now)).toBeNull();
  });

  it("vise les ventes annoncées par le partenaire même au-dessus du plafond (sinon 409 en boucle)", () => {
    // Capacité réduite par l'artisan : plafond négatif, mais Artisia a déjà vendu 2 places.
    const l = listing({ confirmedCapacity: 4, partnerBooked: 2, knownBooked: 2 });
    const s = slot({ capacity: 3, directSold: 3, listings: [l] });
    expect(planListingUpdate(s, l, now)).toEqual({ capacity: 2, status: undefined });
  });

  it("rejoue un envoi incertain même si la cible égale la capacité confirmée", () => {
    const l = listing({ confirmedCapacity: 2, inflightCapacity: 3 });
    const s = slot({ listings: [l, listing({ id: "l2", confirmedCapacity: 2 })] });
    expect(planListingUpdate(s, l, now)).toEqual({ capacity: 2, status: undefined });
  });

  it("pousse l'annulation, mais ne republie jamais une session fermée par le partenaire", () => {
    const open = listing({ confirmedCapacity: 2 });
    expect(planListingUpdate(slot({ status: "cancelled", listings: [open] }), open, now)).toEqual({
      capacity: 0,
      status: "cancelled",
    });
    const closedByPartner = listing({ confirmedCapacity: 2, partnerStatus: "cancelled" });
    const s = slot({ listings: [closedByPartner, listing({ id: "l2", confirmedCapacity: 2 })] });
    expect(planListingUpdate(s, closedByPartner, now)).toBeNull();
  });
});
