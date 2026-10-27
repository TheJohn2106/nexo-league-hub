-- Nexo League Hub — schéma initial.
-- Toutes les dates sont des timestamptz (stockées en UTC) ; l'affichage applique communities.timezone.
-- Chaque table métier porte community_id (directement ou via son parent) : l'isolation est appliquée côté serveur.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE communities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  tagline text NOT NULL DEFAULT '',
  timezone text NOT NULL DEFAULT 'Europe/Brussels',
  -- Couleurs/logo/liens publics. Aucun secret ici.
  branding jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Secrets d'intégration (webhook Discord…) : jamais renvoyés aux pages publiques.
  discord_webhook_url text,
  discord_reminder_hours integer NOT NULL DEFAULT 48 CHECK (discord_reminder_hours BETWEEN 1 AND 336),
  join_policy text NOT NULL DEFAULT 'approval' CHECK (join_policy IN ('approval','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE CHECK (email = lower(email)),
  password_hash text,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 40),
  avatar_url text,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR password_hash IS NULL)
);
CREATE UNIQUE INDEX users_display_name_idx ON users (lower(display_name));

CREATE TABLE driver_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  iracing_cust_id bigint UNIQUE CHECK (iracing_cust_id > 0),
  preferred_number integer CHECK (preferred_number BETWEEN 0 AND 999),
  country text NOT NULL DEFAULT '' CHECK (length(country) <= 2),
  -- Coordonnées privées : visibles par l'intéressé et les organisateurs uniquement.
  private_contact text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

CREATE TABLE rate_limits (
  key_hash text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discord_identities (
  discord_id text PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  username text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oauth_states (
  state_hash text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('discord','iracing')),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  verifier text,
  return_to text NOT NULL DEFAULT '/',
  expires_at timestamptz NOT NULL
);

CREATE TABLE memberships (
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'driver' CHECK (role IN ('owner','organizer','steward','captain','driver')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','refused','removed')),
  message text NOT NULL DEFAULT '' CHECK (length(message) <= 500),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id)
);

CREATE TABLE championships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  rules_md text NOT NULL DEFAULT '',
  rules_version integer NOT NULL DEFAULT 1 CHECK (rules_version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed','finished','cancelled')),
  capacity integer NOT NULL DEFAULT 20 CHECK (capacity BETWEEN 1 AND 200),
  registration_deadline timestamptz,
  categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  cars jsonb NOT NULL DEFAULT '[]'::jsonb,
  require_category boolean NOT NULL DEFAULT false,
  require_car boolean NOT NULL DEFAULT false,
  require_team boolean NOT NULL DEFAULT false,
  number_policy text NOT NULL DEFAULT 'unique' CHECK (number_policy IN ('unique','free','none')),
  -- Présences : délais exprimés en heures/minutes avant le départ de la manche.
  presence_deadline_hours integer NOT NULL DEFAULT 48 CHECK (presence_deadline_hours BETWEEN 0 AND 720),
  checkin_opens_minutes integer NOT NULL DEFAULT 60 CHECK (checkin_opens_minutes BETWEEN 0 AND 1440),
  checkin_closes_minutes integer NOT NULL DEFAULT 10 CHECK (checkin_closes_minutes BETWEEN 0 AND 1440),
  offer_ttl_hours integer NOT NULL DEFAULT 12 CHECK (offer_ttl_hours BETWEEN 1 AND 168),
  protest_window_hours integer NOT NULL DEFAULT 48 CHECK (protest_window_hours BETWEEN 1 AND 336),
  -- Barème complet (voir src/lib/scoring/types.ts).
  scoring jsonb NOT NULL,
  -- Informations serveur : visibles uniquement des participants confirmés et des organisateurs.
  server_info text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (community_id, slug),
  UNIQUE (id, community_id)
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  championship_id uuid NOT NULL REFERENCES championships(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  captain_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (championship_id, name)
);

CREATE TABLE registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  championship_id uuid NOT NULL REFERENCES championships(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','reserve','refused','withdrawn')),
  category text,
  car text,
  team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  race_number integer CHECK (race_number BETWEEN 0 AND 999),
  rules_version integer NOT NULL,
  rules_accepted_at timestamptz NOT NULL,
  reserve_rank integer,
  note text NOT NULL DEFAULT '',
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (championship_id, user_id)
);
CREATE INDEX registrations_status_idx ON registrations(championship_id, status);

CREATE TABLE rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  championship_id uuid NOT NULL REFERENCES championships(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  name text NOT NULL,
  track text NOT NULL,
  track_config text NOT NULL DEFAULT '',
  starts_at timestamptz NOT NULL,
  original_starts_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('draft','scheduled','postponed','cancelled','completed')),
  capacity integer CHECK (capacity BETWEEN 1 AND 200),
  is_joker_eligible boolean NOT NULL DEFAULT true,
  server_info text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (championship_id, number)
);

CREATE TABLE round_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('practice','qualifying','race')),
  label text NOT NULL,
  ordinal integer NOT NULL DEFAULT 1,
  starts_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
  coefficient numeric NOT NULL DEFAULT 1 CHECK (coefficient >= 0 AND coefficient <= 10),
  awards_points boolean NOT NULL DEFAULT false,
  awards_pole boolean NOT NULL DEFAULT false,
  -- Association explicite avec la sous-session iRacing (aucune découverte automatique).
  iracing_subsession_id bigint UNIQUE CHECK (iracing_subsession_id > 0),
  -- Numéro de simsession dans la sous-session (0 = course principale côté iRacing ; null = détecter par type).
  iracing_simsession_number integer,
  results_status text NOT NULL DEFAULT 'none' CHECK (results_status IN ('none','provisional','final')),
  UNIQUE (round_id, kind, ordinal)
);

CREATE TABLE attendances (
  round_id uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response text NOT NULL DEFAULT 'none' CHECK (response IN ('none','yes','no','maybe')),
  responded_at timestamptz,
  -- Place : confirmed (place attribuée), waitlist, offered (proposée à un réserviste), released (place libérée).
  seat text NOT NULL DEFAULT 'none' CHECK (seat IN ('none','confirmed','waitlist','offered','released')),
  waitlist_position integer,
  offer_expires_at timestamptz,
  checked_in_at timestamptz,
  -- Constat au départ : absent annoncé (response=no) ≠ absent au départ (no_show).
  start_status text CHECK (start_status IN ('started','no_show')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, user_id)
);
CREATE INDEX attendances_seat_idx ON attendances(round_id, seat);

CREATE TABLE attendance_events (
  id bigserial PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attendance_events_round_idx ON attendance_events(round_id, created_at);

-- Import : source brute conservée, aperçu avant validation, idempotence par empreinte.
CREATE TABLE result_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES round_sessions(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('iracing_api','iracing_json','manual','csv_template')),
  status text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','applied','superseded','discarded','failed')),
  payload_sha256 text,
  raw jsonb,
  parsed jsonb,
  error text,
  is_final boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_by uuid REFERENCES users(id),
  applied_at timestamptz
);
CREATE INDEX result_imports_session_idx ON result_imports(session_id, created_at DESC);
-- Une même source ne peut avoir qu'un import actif (aperçu ou appliqué) par session.
CREATE UNIQUE INDEX result_imports_dedupe_idx ON result_imports(session_id, payload_sha256)
  WHERE status IN ('preview','applied') AND payload_sha256 IS NOT NULL;

-- Résultat sportif tel que validé depuis l'import. Les corrections et pénalités sont des lignes séparées.
CREATE TABLE results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES round_sessions(id) ON DELETE CASCADE,
  import_id uuid NOT NULL REFERENCES result_imports(id),
  entry_key text NOT NULL,
  user_id uuid REFERENCES users(id),
  iracing_cust_id bigint,
  display_name text NOT NULL,
  team_name text,
  car text,
  car_class text,
  finish_position integer NOT NULL CHECK (finish_position > 0),
  class_position integer,
  start_position integer,
  laps integer,
  laps_led integer,
  best_lap_ms integer,
  best_lap_number integer,
  total_time_ms bigint,
  gap_ms bigint,
  gap_laps integer,
  incidents integer,
  status text NOT NULL CHECK (status IN ('classified','dnf','dns','dsq')),
  reason_out text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, entry_key)
);
CREATE INDEX results_user_idx ON results(user_id);

CREATE TABLE result_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id uuid NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  field text NOT NULL CHECK (field IN ('finish_position','status','laps','best_lap_ms','incidents','user_id','total_time_ms','start_position')),
  old_value text,
  new_value text,
  reason text NOT NULL CHECK (length(reason) >= 3),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id)
);

CREATE TABLE protests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES round_sessions(id) ON DELETE CASCADE,
  filed_by uuid NOT NULL REFERENCES users(id),
  against_user_id uuid REFERENCES users(id),
  lap integer,
  description text NOT NULL CHECK (length(description) BETWEEN 10 AND 4000),
  video_url text CHECK (video_url IS NULL OR video_url ~ '^https://'),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','under_review','decided','dismissed','withdrawn')),
  deadline timestamptz NOT NULL,
  decision text,
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE penalties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES round_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('time','positions','points','dsq','warning')),
  value integer NOT NULL DEFAULT 0,
  -- session : affecte le résultat/points de la course ; championship : retrait sur le total du championnat.
  scope text NOT NULL DEFAULT 'session' CHECK (scope IN ('session','championship')),
  reason text NOT NULL CHECK (length(reason) >= 3),
  protest_id uuid REFERENCES protests(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id)
);

CREATE TABLE iracing_connections (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cust_id bigint NOT NULL,
  tokens text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_failures (
  id bigserial PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  session_id uuid REFERENCES round_sessions(id) ON DELETE CASCADE,
  kind text NOT NULL,
  code text NOT NULL,
  message text NOT NULL,
  retry_after timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_outbox (
  id bigserial PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  kind text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','skipped','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  community_id uuid REFERENCES communities(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_community_idx ON audit_log(community_id, created_at DESC);
