# Daisy : synchroniser sans jamais surréserver (Sujet A)

Moteur de synchronisation des disponibilités entre Daisy et des plateformes partenaires (Artisia, l'API décrite dans l'annexe du sujet A).
Stack : Next.js 16 (App Router), TypeScript, Supabase (Postgres 17), Vercel.

**Idée centrale : l'allotement.** Chaque place d'un créneau appartient à **un seul canal à la fois** :
le pool direct de Daisy, ou un partenaire via la `capacity` qu'on lui pousse. Artisia garantit déjà
`booked ≤ capacity` chez lui. Il suffit donc que Daisy garantisse :

```
ventes directes + Σ capacités confiées aux partenaires ≤ capacité du créneau
```

Avec ça, la surréservation est impossible par construction, même quand Artisia est lent, en erreur ou hors ligne.
Le reste du code sert à maintenir cet invariant malgré un partenaire peu fiable, et à le rendre lisible pour l'artisan.

---

## Sommaire

1. [Démarrer](#1-démarrer)
2. [Ce qui est livré](#2-ce-qui-est-livré)
3. [Architecture et choix](#3-architecture-et-choix)
4. [Réponses aux questions du sujet A](#4-réponses-aux-questions-du-sujet-a)
5. [Tests](#5-tests)
6. [Déploiement Vercel + Supabase](#6-déploiement-vercel--supabase)
7. [Limites connues et zones de doute](#7-limites-connues-et-zones-de-doute)
8. [Partie 2 : socle commun](#8-partie-2--socle-commun)

---

## 1. Démarrer

Prérequis : Node 22, Docker.

```bash
npm install
cp .env.example .env.local
npm run db:up          # Postgres 17 local (port 54329), base de dev + base de test
npm run db:migrate     # applique supabase/migrations/*.sql
npm test               # 55 tests, ~30 s (base réelle, pas de mock SQL)
```

Démo complète (3 terminaux) :

```bash
npm run mock:artisia   # faux Artisia + faux 2e partenaire sur :4010 (latence, 500, doublons de webhooks...)
npm run build && npm start
npm run db:seed        # 1 atelier, 2 partenaires, 6 créneaux ; relie les sessions et pousse les capacités
```

Puis ouvrir http://localhost:3000 (back-office). Avec `DEMO_MODE=1`, des boutons permettent de simuler une vente
sur un partenaire ou de **couper Artisia** pour observer la panne en direct. Le cron se déclenche à la main :

```bash
curl -H "Authorization: Bearer dev-cron-secret" http://localhost:3000/api/cron/sync
```

Si le port 3000 est pris : `npx next start -p 3100` et `APP_URL=http://localhost:3100 npm run mock:artisia`.

---

## 2. Ce qui est livré

| Attendu minimal | Où |
|---|---|
| Modèle de données (créneaux, capacités, réservations externes) | `supabase/migrations/20261012120000_channel_sync.sql` |
| Moteur de synchronisation bidirectionnelle | Daisy → partenaire : `src/sync/listing-sync.ts`, `allocation.ts`, `jobs.ts`, `worker.ts` · partenaire → Daisy : `webhooks.ts`, `reconcile.ts` |
| Pipeline de réception des webhooks | `src/app/api/webhooks/artisia/[connectionId]/route.ts` → `src/sync/webhooks.ts` |

En plus : un client HTTP Artisia typé (`src/partners/artisia/client.ts`), un faux Artisia qui reproduit les défauts de
l'annexe (`fake.ts`, utilisé par les tests **et** le mock de démo), un back-office minimal qui montre l'état de chaque
canal (`src/app/page.tsx`), et un cron (`/api/cron/sync`).

```
src/
├── app/                         Next.js : back-office, server actions, routes webhook et cron
├── partners/
│   ├── types.ts                 contrat PartnerApi + PartnerError typée
│   └── artisia/                 client HTTP, signature HMAC, faux Artisia
└── sync/                        le domaine (aucune dépendance à Next)
    ├── allocation.ts            règles d'allotement : fonctions pures
    ├── state.ts                 lecture de l'état d'un créneau (avec verrou)
    ├── bookings.ts              réservation directe, capacité, annulation, détection de surréservation
    ├── listing-sync.ts          synchro d'une publication (décider → appeler → constater)
    ├── observations.ts          prise en compte d'un état vu chez le partenaire (ordre, dérive)
    ├── webhooks.ts              signature → inbox dédupliquée → traitement transactionnel
    ├── reconcile.ts             filet de sécurité GET /sessions
    ├── connections.ts           rate limit partagé, disjoncteur, santé
    ├── jobs.ts / worker.ts      outbox, bail, backoff, tick du cron
    └── dashboard.ts             ce que voit l'artisan
```

---

## 3. Architecture et choix

### 3.1 Vue d'ensemble

```
  Widget / back-office                              Artisia (et autres partenaires)
          │ bookDirect()                                  ▲                │
          ▼                                               │ PATCH capacity │ webhooks signés
 ┌──────────────────┐  même transaction   ┌───────────┐   │ (absolu,       ▼
 │ slots (verrou)   │────────────────────▶│ sync_jobs │───┘  rejouable)  ┌────────────────┐
 │ bookings         │                     │ (outbox)  │                  │ inbound_events │
 │ listings         │◀────────────────────┴───────────┘                  │ (inbox, unique │
 └──────────────────┘   réponse 200 = vérité            ◀────────────────│  par event_id) │
          ▲                                               traitement      └────────────────┘
          │            GET /sessions toutes les 5 min (et au retour d'une panne)
          └──────────────────────────────── reconcile ──────────────────────────
```

### 3.2 Modèle de données

| Table | Rôle |
|---|---|
| `slots` | Le créneau Daisy et **sa capacité réelle** (la seule source de vérité sur le nombre de places). |
| `bookings` | Toutes les réservations : `channel = direct` ou `partner` (+ `external_booking_id`). Unique `(connection_id, external_booking_id)`. |
| `partner_connections` | Un compte d'atelier chez un partenaire (clé API, secret webhook) + **santé** (échecs consécutifs, hors ligne depuis…). |
| `listings` | Un créneau publié chez un partenaire. `confirmed_capacity` (dernière capacité confirmée par lui), `inflight_capacity` (envoyée sans réponse), `partner_booked`, `partner_updated_at` (horloge du partenaire). |
| `inbound_events` | Inbox des webhooks, unique `(connection_id, event_id)`. Sert aussi de journal et permet de rejouer. |
| `sync_jobs` | Outbox : **une ligne par publication à synchroniser**. Les demandes successives se fusionnent (`generation`). |
| `partner_rate_windows` | Compteur d'appels par clé et par minute pleine, partagé entre instances serverless. |
| `alerts` | Ce que l'artisan doit savoir et que le système ne peut pas trancher seul. |

### 3.3 Allotement : qui peut vendre quoi

`src/sync/allocation.ts`, fonctions pures, testées unitairement.

- **Places détenues par un partenaire** = `max(capacité confirmée, capacité envoyée non confirmée, ventes connues)`.
  On reste pessimiste : une capacité envoyée dont on n'a pas eu la réponse a **peut-être** été appliquée.
- **Disponible en direct** = `capacité − ventes directes − Σ places détenues par les partenaires`.
- **Cible d'un partenaire** = ses ventes + une vitrine de `min(partner_window, ⌊places restantes / (nb partenaires + 1)⌋)`
  places invendues. Daisy direct compte comme une part. Conséquence voulue : **les dernières places restent dans le pool
  direct**, où la garantie est transactionnelle et où l'atelier ne paie pas de commission.
- **Plafond** d'un partenaire = `capacité − ventes directes − places détenues par les autres partenaires`. On ne pousse
  jamais au-dessus. C'est la règle « reprendre avant de donner » : une place ne peut aller chez un partenaire que si
  elle est libre **maintenant**. Reprendre est toujours permis, car c'est le partenaire qui arbitre : il refuse de
  descendre sous ses ventes (`409`).

Après chaque vente, d'un côté comme de l'autre, la vitrine de chaque partenaire est recalculée : rechargée tant qu'il
reste des places, réduite quand le créneau se remplit.

### 3.4 Synchronisation sortante (Daisy → partenaire)

`syncListing()` procède en trois temps, **sans jamais tenir un verrou pendant un appel réseau** :

1. **Décider** : dans une transaction courte, avec le créneau verrouillé (`SELECT … FOR UPDATE`), on calcule la
   capacité voulue et on l'inscrit dans `inflight_capacity` **avant** d'appeler. Si on donne des places, elles
   quittent le pool direct à ce commit.
2. **Appeler** : `PATCH /sessions/{id} {capacity}`, avec un timeout de 8 s.
3. **Constater** : une réponse `200` renvoie l'état réel de la session, ce qui lève l'incertitude. Un timeout ou une
   500 la laissent en place, et le job sera rejoué. Un `409 capacity_below_booked` nous apprend le vrai `booked`, et
   on recalcule.

**Pourquoi le `PATCH capacity` et pas le `POST /bookings` d'Artisia ?** Le `POST` n'est pas idempotent : après un
timeout, on ne sait pas s'il faut réessayer, et réessayer peut doubler une réservation. Il créerait aussi chez Artisia
de fausses réservations (visibles, peut-être commissionnées) pour chaque vente Daisy. Le `PATCH` porte une **valeur
absolue** : le rejouer dix fois produit le même état. Toute la robustesse du moteur repose sur cette propriété.

**File de jobs (outbox).** Toute modification qui touche aux places (vente, capacité, annulation, webhook) insère la
demande de synchro **dans la même transaction**. Si la transaction échoue, la demande disparaît ; si elle réussit, la
demande existe forcément. Un job ne dit pas « mets 3 » mais « réaligne cette publication » : il recalcule la cible au
moment où il tourne, donc dix demandes rapprochées produisent un seul appel. Les jobs sont pris avec
`FOR UPDATE SKIP LOCKED` et un bail : une publication n'est jamais synchronisée par deux workers à la fois.
Les cours les plus proches passent en premier.

**Rate limit.** Le budget est de 50 appels par clé et par minute pleine (Artisia en autorise 60, sans fenêtre glissante).
Il est compté en base, donc partagé entre toutes les fonctions Vercel. Une fois le budget atteint, les jobs sont
reportés à la minute suivante sans que ce soit compté comme un échec.

**Disjoncteur.** Après 3 échecs consécutifs (timeout, 5xx, réseau), la connexion est déclarée hors ligne : on ne fait
plus qu'une sonde toutes les 30 s. La première sonde réussie rétablit la connexion et lance une réconciliation complète.

### 3.5 Webhooks entrants (partenaire → Daisy)

`handleArtisiaWebhook()` (la route Next n'est qu'un adaptateur) :

1. Vérification HMAC sur le **corps brut**, en temps constant → sinon `401`.
2. **Stockage dédupliqué** : `INSERT … ON CONFLICT (connection_id, event_id) DO UPDATE SET delivery_count + 1`.
   Un doublon est reconnu en une requête.
3. Traitement immédiat (en base uniquement, quelques ms), dans une transaction : effets + `processed_at` ensemble.
4. Réponse `200` en quelques ms, bien avant les 5 s d'Artisia. Les appels sortants (lents) partent **après** la
   réponse, via `after()`.

Si le traitement échoue, l'événement reste dans l'inbox (`processed_at` nul) et le cron le rejoue. On répond quand
même `200`, puisque l'événement est en lieu sûr chez nous.

Désordre (jusqu'à 30 s) :
- `booking.cancelled` avant `booking.created` : on pose une annulation (tombstone), et la création qui arrive
  ensuite ne la ressuscite pas. L'annulation est un état terminal.
- `session.updated`, réponses `PATCH` et `GET /sessions` : un état n'est appliqué que s'il est au moins aussi récent
  que le dernier connu, **selon l'horloge d'Artisia** (`updated_at`), comparée à elle-même et jamais à la nôtre (elle
  dérive). Voir `observations.ts`.

### 3.6 Réconciliation

Artisia n'a pas d'endpoint « ce qui a changé depuis », mais `GET /sessions` donne l'état courant de toutes les sessions
en **un appel par atelier** (1 appel / 5 min / atelier, négligeable face aux 60/min). La réconciliation :
- relie automatiquement les sessions dont `external_ref = daisy_slot_<id>` ;
- signale celles qui ne sont reliées à rien (créées à la main chez Artisia : leurs places échappent à la protection) ;
- met à jour les ventes annoncées et signale les écarts : **webhook de réservation perdu** (la place est comptée, il
  manque le client) ou **annulation jamais reçue** ;
- détecte une capacité modifiée hors Daisy, la reprend en compte puis la réaligne.

### 3.7 Ce que j'ai délibérément écarté

- **Création des sessions chez le partenaire** : l'annexe ne fournit aucun `POST /sessions`. Hypothèse : elles sont
  créées par l'intégration ou par l'artisan avec `external_ref`, et la réconciliation les relie.
- **Annulation d'une réservation partenaire depuis Daisy** (`DELETE /bookings`) : c'est le même pattern (job +
  `404` = déjà fait), mais hors du périmètre « disponibilités ».
- **Authentification du back-office et RLS par atelier** : RLS activée sans policy (rien n'est exposé à la clé
  anonyme), et le serveur passe par une connexion Postgres directe. En production : Supabase Auth, et une vérification
  d'appartenance dans chaque server action.
- **Secrets en clair dans `partner_connections`** : en production, Supabase Vault.
- **Le widget public** (sujet B) : le back-office ne sert qu'à **voir** le moteur fonctionner.

---

## 4. Réponses aux questions du sujet A

### Q1. Concurrence critique : deux réservations sur la dernière place au même instant

**Comportement exact.** À un instant donné, la dernière place appartient à un seul canal. Il n'y a donc pas de course
entre Daisy et le partenaire : chacun arbitre seul, sur son propre stock.

- **Cas normal (synchro à jour)** : la dernière place est dans le pool direct. D'après la règle de part équitable, les
  partenaires n'ont plus de vitrine quand il reste moins de places que de canaux.
  - La réservation Daisy ouvre une transaction, verrouille la ligne du créneau, constate 1 place disponible, insère
    et valide. Une autre réservation Daisy concurrente attend le verrou, voit 0 place et reçoit `409 slot_full`
    (`bookings.ts`). Testé avec 20 réservations simultanées : exactement 1 passe.
  - Le client Artisia voit le cours complet (`capacity = booked`) : c'est Artisia qui refuse (`not_enough_seats`).
- **Cas transitoire (une réduction de vitrine pas encore confirmée)** : la place est encore chez Artisia. Daisy voit 0
  place disponible en direct et refuse. Le client Artisia l'obtient, le webhook l'enregistre.

Dans les deux cas, il y a **exactement une vente**. La réservation Daisy n'appelle jamais le partenaire : sa latence ne
dépend pas des 3 à 6 s d'Artisia.

**Conditions précises dans lesquelles une surréservation reste possible :**
1. L'artisan **réduit lui-même** la capacité sous le nombre de places vendues (un tour en panne). C'est permis, sa
   décision prime, et c'est signalé aussitôt.
2. La capacité est **modifiée à la main dans l'interface Artisia**. Le risque dure entre la modification et sa
   détection (webhook `session.updated`, ou 5 min au pire), puis Daisy réaligne et alerte.
3. Un `PATCH` parti en timeout **atterrit plus tard qu'un PATCH suivant**. Sans `ETag`, le dernier écrit gagne. Même
   détection, même correction.
4. Une session Artisia **non reliée** à Daisy (`external_ref` nul) : signalée, mais non protégée.
5. Artisia ne garantit pas réellement `booked ≤ capacity` de façon atomique : c'est l'hypothèse de la
   [question technique](#84-question-technique-en-amont).

**Si elle arrive** : alerte « N place(s) vendue(s) au-delà de la capacité », avec la répartition par canal. Pas
d'annulation automatique : c'est à l'artisan de choisir qui prévenir. Annuler la vente directe la plus récente coûte
moins cher, puisqu'il n'y a pas de commission partenaire perdue.

### Q2. Artisia hors ligne pendant 20 minutes

**Ce que voit l'artisan** (`src/app/_components/connections-panel.tsx`) :
- sur la carte Artisia, un badge rouge **« Injoignable depuis 14:25 (20 min) »**, la date du dernier échange réussi et
  le nombre de mises à jour en attente ;
- le message : *« Artisia ne répond plus. Vos ventes Daisy continuent normalement. Les places déjà confiées à Artisia
  restent réservées à Artisia : aucune surréservation n'est possible. Tout se remettra à jour automatiquement à son
  retour. »* ;
- sur chaque créneau, la ligne Artisia passe en « mise à jour en attente » ou « envoi non confirmé » ;
- l'autre partenaire reste « Synchronisé » : une panne est isolée par connexion.

**Pendant la panne** : Daisy vend normalement, sans aucune dépendance au partenaire. Les places confiées à Artisia sont
**gelées** : on ne peut ni les reprendre ni en donner d'autres. C'est le coût de la panne, quelques ventes directes
éventuellement bloquées, jamais une surréservation. Si la place de marché Artisia continue de vendre pendant que son
API est tombée (le pire cas, testé), elle ne peut vendre que son allotement. Le disjoncteur limite les appels à une
sonde toutes les 30 s.

**Rattrapage** (`tests/outage.test.ts`, et vérifié en démo réelle) :
1. La première sonde réussie fait repasser la connexion au vert et **déclenche immédiatement une réconciliation**
   (`GET /sessions`) : ventes faites pendant la panne, capacités réelles, sessions orphelines.
2. Toutes les publications sont réalignées, **cours les plus proches d'abord**, dans le budget de 50 appels par minute
   (300 sessions → environ 6 min, sans un seul `429`).
3. Artisia rejoue ses webhooks (1 min, 5 min, 30 min, 2 h) : ils arrivent dans l'inbox, les doublons sont absorbés, et
   les clients des réservations faites pendant la panne apparaissent dans Daisy.
4. Ce qui ne revient jamais (webhook abandonné après 2 h 37) est détecté par la réconciliation et signalé.

### Q3. Idempotence : le même webhook reçu trois fois

**Mécanisme** (`tests/webhooks.test.ts` : « le même webhook reçu 3 fois ne crée qu'une réservation ») :
1. Une **contrainte unique `(connection_id, event_id)`** sur l'inbox. La 1re livraison insère la ligne, les 2e et 3e ne
   font qu'incrémenter `delivery_count`, et le handler répond `200 {duplicate: true}` sans rien retraiter.
2. Le traitement verrouille l'événement (`FOR UPDATE SKIP LOCKED`), écrit ses effets **et** `processed_at` dans la
   même transaction. Le webhook et le cron ne peuvent pas traiter deux fois le même événement.
3. Deuxième filet, indépendant de `event_id` : unique `(connection_id, external_booking_id)` sur `bookings`, au cas où le
   partenaire réémettrait la même réservation sous un nouvel `event_id`.

**Coût technique :**
- **Écriture** : un `INSERT` indexé par livraison, avant traitement (environ 1 ms). C'est le prix de « stocker d'abord ».
- **Stockage** : environ 1 Ko de JSON par événement. Les `event_id` ne servent que pendant la fenêtre de rejeu
  d'Artisia (2 h 37 au maximum), donc purge après 7 jours. Pour 70 ateliers à environ 200 événements par jour, ça fait
  environ 100 k lignes, soit négligeable.
- **Données personnelles** : le payload contient nom et email du client. La purge à 7 jours est aussi une exigence RGPD.
- **Dépendance** : on suppose que l'`event_id` est stable entre les rejeux (c'est ce que dit l'annexe).
- **Bénéfice gratuit** : un journal brut de ce qu'a envoyé le partenaire, et la possibilité de **rejouer** après un
  correctif. Voir le ticket n°1 du tri, plus bas.

### Q4. « Ne jamais surréserver » ou « ne jamais bloquer une vente » ?

**Mon choix : ne jamais surréserver.** L'allotement le garantit par construction. Le prix à payer : il arrive qu'une
place soit en vente sur un canal alors qu'un client la voulait sur un autre. Par exemple, les toutes dernières places
d'un cours ne sont proposées que sur Daisy, ou deux places invendues restent bloquées chez Artisia pendant une panne.

**Pourquoi** : une surréservation, c'est un client qui se déplace pour rien devant 8 tours occupés, un avis négatif, et
une commission Artisia **perdue** (non remboursée si l'atelier annule). Une vente « bloquée », c'est une place qui reste
en vente, la plupart du temps sur le canal le plus rentable pour l'atelier (Daisy, sans commission). L'asymétrie est
nette.

**Ce que je dirais à l'artisan qui perd une vente Artisia** :
> « Vos derniers créneaux libres sont gardés sur votre site Daisy plutôt que sur Artisia. C'est ce qui garantit qu'aucun
> client ne se présente à un cours complet. Ces places ne sont pas perdues, elles restent en vente sans commission. Si
> vous préférez exposer davantage de places sur Artisia, vous pouvez augmenter le nombre de places confiées à chaque
> plateforme : le risque de surréservation reste nul, mais plus de places peuvent rester invendues chez un partenaire
> pendant que des clients Daisy les cherchent. »

Le réglage existe (`studios.partner_window`, 2 par défaut). Évolution naturelle : reprendre automatiquement les places
invendues des partenaires à J-1, quand la vente de dernière minute passe surtout par le site de l'atelier.

---

## 5. Tests

Les tests tournent sur un **vrai Postgres** (verrous, contraintes, `SKIP LOCKED` : rien de tout ça ne se mocke
sérieusement). Les partenaires sont simulés par `FakeArtisia`, branché sur le **vrai** `ArtisiaClient` via un `fetch`
simulé. Le temps est contrôlé (`ctx.now()`) : une panne de 20 minutes se teste en 2 secondes.

| Fichier | Ce qui est prouvé |
|---|---|
| `allocation.test.ts` | Règles pures : places détenues, part équitable, plafond, fantômes, annulation. |
| `concurrency.test.ts` | **Q1** : 20 réservations simultanées → 1 succès ; course Daisy/Artisia dans les deux configurations ; deux partenaires en rafale. |
| `webhooks.test.ts` | **Q3** : triple livraison, double `event_id`, signature, désordre création/annulation et `session.updated`, session inconnue puis reliée, événement empoisonné. |
| `sync.test.ts` | Timeout appliqué / non appliqué, `409`, annulation de créneau, capacité sous les ventes, dérive de capacité, webhook perdu, course réconciliation/PATCH, **rate limit** (120 sessions → jamais plus de 50 appels/min, 0 × `429`), priorité aux cours proches. |
| `outage.test.ts` | **Q2** : 20 minutes de panne minute par minute, invariant vérifié à chaque minute, état affiché, rattrapage complet. |
| `artisia-client.test.ts` | Traduction HTTP → erreurs : 500 sans corps, 409, 429, 404, timeout, réseau. |
| `chaos.test.ts` | Des centaines d'actions aléatoires (ventes de chaque côté, annulations, pannes, timeouts appliqués ou non, 500, webhooks dupliqués, perdus, désordonnés). Après **chaque** action : places réellement ouvertes à la vente ≤ capacité. Puis convergence exacte Daisy ⇄ partenaires. |

```bash
npm test                 # 55 tests
npm run test:chaos       # campagne longue : 100 graines × 250 actions
```

Le test chaos a trouvé **deux vrais défauts** pendant le développement. Les deux sont corrigés et couverts par un test
dédié :
1. **Une réconciliation appliquait un instantané `GET` dépassé** par une réponse `PATCH` arrivée entre-temps. Elle
   sous-estimait alors ce que détenait le partenaire. Corrigé en n'appliquant une observation que si elle est plus
   récente selon l'horloge du partenaire (`observations.ts`).
2. **Une réservation fantôme** (annulation jamais reçue) était comptée comme « déjà détenue » par le partenaire, et le
   moteur l'autorisait à remonter sa capacité jusqu'à ce niveau, **sans la prendre sur le pool libre**. La place
   fantôme devenait une place réellement vendable. Corrigé par le plafond explicite de `partnerCeiling()`.

C'est l'argument principal de ma stratégie de test : sur ce genre de problème, les cas qu'on imagine ne suffisent pas.

---

## 6. Déploiement Vercel + Supabase

1. **Supabase** : `supabase link --project-ref <ref>`, puis `supabase db push` (migrations de `supabase/migrations`).
2. **Vercel** : variables `DATABASE_URL` (pooler Supavisor en **mode transaction**, port 6543 ; le client désactive
   les requêtes préparées pour ça) et `CRON_SECRET`. `DEMO_MODE` reste vide en production.
3. **Cron** : `vercel.json` déclenche `/api/cron/sync` chaque minute (plan Pro). Sur le plan Hobby (un cron par jour),
   on passe par `pg_cron` + `pg_net` côté Supabase :
   ```sql
   select cron.schedule('daisy-sync', '* * * * *', $$
     select net.http_get(
       url := 'https://<app>.vercel.app/api/cron/sync',
       headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>'))
   $$);
   ```
4. **Chez Artisia** : déclarer l'URL de webhook `https://<app>.vercel.app/api/webhooks/artisia/<connection_id>`.

Le cron n'est qu'un filet de sécurité. En temps normal, la synchro part dans la seconde après chaque événement,
grâce à `after()`.

---

## 7. Limites connues et zones de doute

- **Fenêtre de dérive** : une capacité modifiée hors Daisy, ou un vieux `PATCH` qui atterrit en retard, est détecté
  par webhook ou, au pire, par la réconciliation suivante (5 min). Pendant cette fenêtre, la protection repose sur la
  bonne foi du partenaire.
- **Réservation fantôme** (webhook d'annulation perdu) : sans danger, puisqu'elle bloque une place au lieu d'en
  ouvrir une. Mais la liste des participants est fausse jusqu'à ce que l'artisan vérifie. Une alerte le dit. Il n'y a
  pas d'endpoint Artisia pour lister les réservations, donc pas de correction automatique.
- **Alerte « ventes inconnues » parfois prématurée** juste après une panne : la réconciliation passe avant le rejeu des
  webhooks par Artisia. Elle se résout seule à la réconciliation suivante.
- **Pagination de `GET /sessions`** : non documentée. J'ai supposé qu'un appel renvoie tout. Si ce n'est pas le cas,
  la réconciliation devient une boucle de pages, dans le même budget d'appels.
- **Format des payloads** `booking.cancelled` et `session.updated` : non documentés. J'ai supposé qu'ils ont la même
  forme que `booking.created` et qu'une session (validation zod : un écart lèverait une alerte `event_failed`, pas un
  crash).
- **Horloge partenaire monotone par session** : l'ordonnancement repose sur `updated_at`. Si Artisia ne l'incrémente
  pas à chaque changement, deux états pourraient être confondus.

---

## 8. Partie 2 : socle commun

### 8.1 Journal de bord

- **Sujet reçu** le vendredi 9 octobre à 12 h 18, **réalisé** le lundi 12 octobre.
- **Temps alloué : 6 h**, le haut de la fourchette du sujet. J'ai choisi de l'utiliser en entier parce que la valeur
  du sujet A est dans les cas limites, et qu'un cas limite se prouve par un test, pas par une phrase.
- **Ordre de travail** : décision d'architecture d'abord, invariant et fonctions pures ensuite, réseau en dernier.
  L'historique Git suit les mêmes étapes.

| Étape | Contenu |
|---|---|
| 1. Lecture et cadrage | Lecture des trois sujets, choix du A (cœur du channel manager, le plus riche en arbitrages). Relevé des pièges de l'annexe : `POST` non idempotent, pas d'`ETag`, pas de réconciliation par lot, webhooks dupliqués, désordonnés ou perdus. |
| 2. Décision structurante | Allotement plutôt que pool partagé + réservations miroir. Le choix du `PATCH` absolu découle de l'annexe : c'est le seul appel rejouable sans risque. |
| 3. Modèle et invariant | Schéma SQL, fonctions pures d'allotement et leurs tests unitaires, avant tout réseau. |
| 4. Moteur | Réservation directe atomique, outbox, synchro en trois temps, client Artisia, rate limit, disjoncteur. |
| 5. Webhooks et réconciliation | Inbox dédupliquée, traitement transactionnel, désordre, réconciliation `GET /sessions`. |
| 6. Tests de scénario | Concurrence, panne de 20 min, rate limit, puis test chaos. |
| 7. Back-office et démo | Écran artisan (état par canal, panne, alertes), mock HTTP, seed, essai réel de bout en bout. |
| 8. README | Choix, réponses, limites. |

**Points de blocage :**
- La course entre réconciliation et `PATCH`, trouvée par le test de panne. Il a fallu un ordre fondé sur l'horloge du
  partenaire, la seule fiable pour ordonner ses propres états.
- La réservation fantôme qui ouvrait une vraie place, trouvée par le test chaos (graine 42, étape 237). Elle m'a
  obligé à distinguer « ce qu'on compte comme détenu » (pessimiste, sans danger) de « ce qu'on a le droit de donner »
  (plafond strict).

**Écarté délibérément :** widget, authentification, Vault, création de sessions chez le partenaire, annulation d'une
réservation partenaire depuis Daisy, métriques et observabilité (je mesurerais d'abord le délai de convergence et le
nombre d'alertes par semaine).

### 8.2 Tri de tickets (par appétence personnelle)

1. **(#1) Le partenaire a changé le format de ses dates, plus aucune réservation n'entre.** Incident en cours, de l'argent qui ne rentre pas, et c'est le terrain de ce projet. Avec une inbox comme celle-ci, rien n'est perdu : on corrige le parseur et on rejoue.
2. **(#7) L'export comptable ne correspond pas aux relevés bancaires.** Données fausses, sur de l'argent : la confiance se perd vite.
3. **(#5) 60 % d'abandon à l'étape des coordonnées.** Une enquête avec un chiffre à faire bouger.
4. **(#2) Le calendrier rame au-delà de 200 cours.** Problème mesurable, cause probablement localisable (N+1, rendu).
5. **(#6) API publique pour les futurs partenaires.** Très intéressant, mais demande un cadrage produit que je n'aurais pas en arrivant.
6. **(#3) Paiement sur place par TPE.** Intégration fournisseur, beaucoup de dépendances externes.
7. **(#8) Design system.** Utile à long terme, moins mon terrain.
8. **(#4) Filtre par type de cours.** Simple et utile, mais peu de matière.

**Ce que ça traduit** : je suis d'abord attiré par les problèmes où **la donnée est fausse ou bloquée en production**
(1, 7), puis par ceux qui **se mesurent** (5, 2). Les chantiers de fond (6, 8) m'intéressent une fois le terrain
connu. Ce n'est pas un ordre de priorité métier : le #4 passerait avant le #8 dans un vrai sprint, parce qu'une demande
récurrente des artisans à une heure de travail se livre tout de suite.

### 8.3 Question ouverte : mes deux premières semaines

**Semaine 1 : comprendre sans casser.**
- J1-J2 : environnement local, déploiement de bout en bout, lecture du schéma de la base et des flux d'argent et de
  réservation. Une demi-journée avec la personne du care : les tickets du widget sont le motif de contact n°2.
- J2-J3 : **une première PR en production**, petite et réelle (un bug du backlog). Le but est d'apprendre le chemin
  complet (revue, CI, déploiement, rollback), pas d'impressionner.
- J3-J5 : cartographier les zones à risque : synchro partenaires, paiements, export comptable. Pour chacune : comment
  sait-on qu'elle est cassée ? Je liste ce qui n'est pas observé.

**Semaine 2 : prendre un sujet de bout en bout.**
- Un sujet de taille moyenne avec un impact clair, choisi avec l'équipe. Par exemple, rendre la réception des données
  partenaires robuste aux changements de format (le ticket n°1 ne doit pas pouvoir se reproduire en silence), ou
  instrumenter le tunnel du widget pour expliquer l'abandon.
- Une page de documentation sur ce que j'ai appris et qui n'était écrit nulle part.
- Un point en fin de semaine 2 : ce que j'ai compris, ce qui me semble risqué, ce que je propose pour le mois suivant.

**Ce que je ne ferais pas** : réécrire quoi que ce soit. Une base de quatre ans qui sert 70 ateliers tous les jours a
des raisons d'être comme elle est. Il faut les connaître avant de les juger.

### 8.4 Question technique en amont

**Artisia garantit-il atomiquement `booked ≤ capacity` ?** Autrement dit, sa création de réservation et le `PATCH`
de capacité sont-ils sérialisés de son côté ? Si un `PATCH {capacity: 1}` et une réservation arrivent au même instant,
le partenaire peut-il accepter les deux et finir à `booked = 2, capacity = 1` ?

Toute la garantie de l'allotement s'appuie là-dessus. L'annexe le laisse entendre (le `409 capacity_below_booked`
existe), sans le dire.

**Hypothèse de travail retenue : oui.** Si la réponse était non, il y aurait un risque résiduel au moment de chaque
réduction de vitrine. Je le réduirais en ne reprenant des places à un partenaire que lorsque sa vitrine est déjà
vide côté ventes récentes, et en surveillant `booked > capacity` à chaque réconciliation.
