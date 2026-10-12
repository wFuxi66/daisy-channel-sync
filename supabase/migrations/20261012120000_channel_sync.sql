-- =============================================================================
-- Daisy — synchronisation des disponibilités avec les plateformes partenaires
--
-- Principe (détaillé dans le README) : ALLOTEMENT.
-- Chaque place d'un créneau appartient à un seul canal à un instant donné :
--   - soit au pool « direct » de Daisy (widget, back-office),
--   - soit à un partenaire, via la `capacity` qu'on lui a poussée.
-- Le partenaire garantit lui-même booked <= capacity chez lui ; Daisy garantit
--   ventes directes + Σ capacités partenaires <= capacité du créneau.
-- =============================================================================

create table studios (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Europe/Paris',
  -- Nombre maximum de places invendues confiées à chaque partenaire à la fois.
  partner_window int not null default 2 check (partner_window >= 0),
  created_at timestamptz not null default now()
);

-- Un compte d'atelier sur une plateforme partenaire (une clé API par atelier).
create table partner_connections (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  provider text not null check (provider in ('artisia')),
  label text not null,
  api_base_url text not null,
  api_key text not null,          -- en production : Supabase Vault, pas une colonne en clair
  webhook_secret text not null,   -- idem
  -- Santé de la connexion (disjoncteur) : alimentée par chaque appel sortant.
  consecutive_failures int not null default 0,
  degraded_since timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  last_reconciled_at timestamptz,
  created_at timestamptz not null default now()
);

create table slots (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references studios(id) on delete cascade,
  title text not null,
  starts_at timestamptz not null,
  duration_minutes int not null check (duration_minutes > 0),
  capacity int not null check (capacity >= 0),
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index slots_studio_starts_at_idx on slots (studio_id, starts_at);

-- Un créneau Daisy publié chez un partenaire (= une « session » Artisia).
create table listings (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references slots(id) on delete cascade,
  connection_id uuid not null references partner_connections(id) on delete cascade,
  external_session_id text not null,
  -- Dernière capacité dont le partenaire nous a confirmé la valeur (réponse 2xx, GET, webhook).
  confirmed_capacity int not null default 0 check (confirmed_capacity >= 0),
  -- Plus grande capacité envoyée sans confirmation (timeout, 500...). Null = rien en suspens.
  -- Tant qu'elle n'est pas levée, on considère que le partenaire PEUT l'avoir appliquée.
  inflight_capacity int check (inflight_capacity >= 0),
  -- Places vendues chez le partenaire selon le partenaire lui-même (réponses PATCH/GET, session.updated).
  partner_booked int not null default 0 check (partner_booked >= 0),
  partner_status text not null default 'published',
  -- Horloge du partenaire : comparée uniquement à elle-même, jamais à la nôtre.
  partner_updated_at timestamptz,
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  unique (slot_id, connection_id),
  unique (connection_id, external_session_id)
);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references slots(id) on delete cascade,
  channel text not null check (channel in ('direct', 'partner')),
  connection_id uuid references partner_connections(id) on delete cascade,
  external_booking_id text,
  seats int not null check (seats > 0),
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  customer_name text,
  customer_email text,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  check ((channel = 'direct') = (connection_id is null)),
  check ((channel = 'direct') = (external_booking_id is null)),
  -- Deuxième filet anti-doublon, indépendant de l'event_id du webhook.
  unique (connection_id, external_booking_id)
);
create index bookings_slot_confirmed_idx on bookings (slot_id) where status = 'confirmed';

-- Inbox des webhooks : on stocke d'abord, on traite ensuite.
create table inbound_events (
  id bigint generated always as identity primary key,
  connection_id uuid not null references partner_connections(id) on delete cascade,
  event_id text not null,
  type text not null,
  occurred_at timestamptz,        -- horloge partenaire, informatif uniquement
  payload jsonb not null,
  received_at timestamptz not null default now(),
  delivery_count int not null default 1,
  processed_at timestamptz,
  attempts int not null default 0,
  last_error text,
  -- La déduplication tient en une contrainte.
  unique (connection_id, event_id)
);
create index inbound_events_pending_idx on inbound_events (received_at) where processed_at is null;

-- Outbox : travail à faire vers les partenaires. Une seule ligne par cible
-- (les demandes se fusionnent), le job recalcule l'état voulu au moment où il tourne.
create table sync_jobs (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('sync_listing', 'reconcile_connection')),
  listing_id uuid references listings(id) on delete cascade,
  connection_id uuid not null references partner_connections(id) on delete cascade,
  priority_at timestamptz not null,  -- les cours les plus proches passent en premier
  run_after timestamptz not null,
  generation int not null default 1, -- incrémenté à chaque nouvelle demande, voir completeJob
  attempts int not null default 0,
  locked_until timestamptz,          -- bail du worker qui traite le job
  last_error text,
  created_at timestamptz not null default now(),
  check ((kind = 'sync_listing') = (listing_id is not null))
);
create unique index sync_jobs_listing_uidx on sync_jobs (listing_id) where kind = 'sync_listing';
create unique index sync_jobs_reconcile_uidx on sync_jobs (connection_id) where kind = 'reconcile_connection';
create index sync_jobs_due_idx on sync_jobs (run_after, priority_at);

-- Compteur d'appels par clé et par minute pleine (le rate limit Artisia n'est pas glissant).
create table partner_rate_windows (
  connection_id uuid not null references partner_connections(id) on delete cascade,
  window_start timestamptz not null,
  calls int not null default 0,
  primary key (connection_id, window_start)
);

-- Ce que l'artisan doit savoir et que le système ne peut pas régler seul.
create table alerts (
  id bigint generated always as identity primary key,
  studio_id uuid not null references studios(id) on delete cascade,
  slot_id uuid references slots(id) on delete cascade,
  connection_id uuid references partner_connections(id) on delete cascade,
  kind text not null check (kind in (
    'overbooked', 'unknown_partner_bookings', 'missing_partner_cancellations',
    'capacity_drift', 'unlinked_session', 'event_failed'
  )),
  message text not null,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index alerts_open_dedupe_uidx on alerts (dedupe_key) where resolved_at is null;

-- Le back-office et les jobs passent par une connexion Postgres serveur (rôle propriétaire).
-- RLS activée sans policy : rien n'est exposé via l'API REST Supabase (clé anon).
alter table studios enable row level security;
alter table partner_connections enable row level security;
alter table slots enable row level security;
alter table listings enable row level security;
alter table bookings enable row level security;
alter table inbound_events enable row level security;
alter table sync_jobs enable row level security;
alter table partner_rate_windows enable row level security;
alter table alerts enable row level security;
