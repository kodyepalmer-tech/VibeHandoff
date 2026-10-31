-- Combined picture of a fresh VibeHandoff / Vibe Handoff Enterprise database.
--
-- The running app does not execute this file. It applies migrations/*.sql
-- in order (see src/db.js). This file is the same end state, for reading
-- and for loading an empty schema.
--
-- PLATFORM_MODE=public (VibeHandoff) and PLATFORM_MODE=enterprise (Vibe Handoff Enterprise)
-- are separate deployments. They do not share this database and nothing
-- here copies a row from one mode to the other. Public profiles, reviews,
-- and leaderboards live beside organization quotas, memberships, and
-- audit logs so one engine can boot in either mode.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  oidc_issuer TEXT NOT NULL,
  oidc_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'publisher', 'member')),
  handle TEXT CHECK (handle IS NULL OR handle ~ '^[a-z0-9_]{3,24}$'),
  profile_bio TEXT NOT NULL DEFAULT '' CHECK (char_length(profile_bio) <= 280),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  UNIQUE (oidc_issuer, oidc_subject)
);

CREATE UNIQUE INDEX users_organization_email_idx ON users (organization_id, lower(email));
CREATE INDEX users_organization_id_idx ON users (organization_id);
CREATE UNIQUE INDEX users_handle_idx ON users (handle) WHERE handle IS NOT NULL;

CREATE TABLE applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by UUID NOT NULL REFERENCES users(id),
  multiplayer BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);

CREATE INDEX applications_organization_id_idx ON applications (organization_id);
CREATE INDEX applications_name_idx ON applications (organization_id, lower(name));

CREATE TABLE application_memberships (
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'publisher')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, user_id)
);

CREATE INDEX application_memberships_user_id_idx ON application_memberships (user_id);

CREATE TABLE tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (organization_id, slug)
);

CREATE TABLE application_tags (
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (application_id, tag_id)
);

CREATE TABLE releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'quarantine', 'validating', 'validated', 'rejected', 'published', 'unpublished'
  )),
  validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  validation_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  artifact_sha256 TEXT,
  artifact_bytes BIGINT,
  file_count INTEGER,
  quarantine_key TEXT,
  immutable_prefix TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  unpublished_at TIMESTAMPTZ,
  UNIQUE (application_id, version)
);

CREATE UNIQUE INDEX releases_one_published_idx
  ON releases (application_id)
  WHERE status = 'published';

CREATE INDEX releases_application_id_idx ON releases (application_id, created_at DESC);
CREATE INDEX releases_organization_id_idx ON releases (organization_id);

CREATE TABLE launch_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  application_id UUID NOT NULL REFERENCES applications(id),
  release_id UUID NOT NULL REFERENCES releases(id),
  user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX launch_events_application_id_idx ON launch_events (application_id, created_at DESC);
CREATE INDEX launch_events_organization_id_idx ON launch_events (organization_id, created_at DESC);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
  user_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  ip TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_organization_id_idx ON audit_logs (organization_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);

CREATE TABLE oidc_transactions (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX oidc_transactions_created_at_idx ON oidc_transactions (created_at);

CREATE TABLE rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  hit_count INTEGER NOT NULL
);

CREATE TABLE play_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  host_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (organization_id, code)
);

CREATE INDEX play_rooms_application_idx ON play_rooms (application_id, created_at DESC);

CREATE TABLE play_room_members (
  room_id UUID NOT NULL REFERENCES play_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  display_name TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE play_room_events (
  id BIGSERIAL PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES play_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX play_room_events_room_idx ON play_room_events (room_id, id);

-- Enterprise: an admin can tighten upload limits below the deployment ceiling.
-- No row means the process keeps MAX_UPLOAD_BYTES and MAX_USER_STORAGE_BYTES.
CREATE TABLE organization_quotas (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id),
  max_upload_bytes BIGINT NOT NULL CHECK (max_upload_bytes > 0),
  max_member_storage_bytes BIGINT NOT NULL CHECK (max_member_storage_bytes > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (max_upload_bytes <= max_member_storage_bytes)
);

-- Public store: one review per player per app.
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (application_id, user_id),
  CHECK (char_length(body) <= 2000)
);

CREATE INDEX reviews_application_idx ON reviews (application_id, created_at DESC);

-- Scores are per player. Enterprise reads stay inside the organization.
-- A public deployment reads every score stored for that app.
CREATE TABLE leaderboard_entries (
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  score BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, user_id)
);

CREATE INDEX leaderboard_entries_score_idx
  ON leaderboard_entries (application_id, score DESC, updated_at);

-- Progress saved by the parent gateway. The sandboxed app never writes this.
CREATE TABLE user_save_states (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  state_key TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, application_id, state_key),
  CHECK (state_key ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  CHECK (octet_length(data::text) <= 20000)
);

-- Leaving the building is a record, not a sync. Enterprise rows start
-- pending until an admin decides. Public rows are approved for the creator.
-- Neither status copies objects into another deployment.
CREATE TABLE asset_export_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  application_id UUID NOT NULL REFERENCES applications(id),
  release_id UUID NOT NULL REFERENCES releases(id),
  requested_by UUID NOT NULL REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  CHECK (char_length(note) <= 500)
);

CREATE INDEX asset_export_requests_org_idx
  ON asset_export_requests (organization_id, status, created_at DESC);

-- Same rows as asset_export_requests. Download checks this name for status = approved.
CREATE OR REPLACE VIEW export_approvals AS
SELECT
  id,
  organization_id,
  application_id,
  release_id,
  requested_by,
  reviewed_by,
  status,
  note,
  created_at,
  reviewed_at
FROM asset_export_requests;
