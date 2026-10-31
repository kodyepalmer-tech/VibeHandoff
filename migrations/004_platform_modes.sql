-- Shared tables for the public store and the on-prem hub.
-- One deployment uses one database. These tables do not sync across modes.

ALTER TABLE users ADD COLUMN IF NOT EXISTS handle TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_bio TEXT NOT NULL DEFAULT '';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_handle_check;
ALTER TABLE users ADD CONSTRAINT users_handle_check
  CHECK (handle IS NULL OR handle ~ '^[a-z0-9_]{3,24}$');

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_profile_bio_check;
ALTER TABLE users ADD CONSTRAINT users_profile_bio_check
  CHECK (char_length(profile_bio) <= 280);

CREATE UNIQUE INDEX IF NOT EXISTS users_handle_idx ON users (handle) WHERE handle IS NOT NULL;

CREATE TABLE IF NOT EXISTS organization_quotas (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id),
  max_upload_bytes BIGINT NOT NULL CHECK (max_upload_bytes > 0),
  max_member_storage_bytes BIGINT NOT NULL CHECK (max_member_storage_bytes > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (max_upload_bytes <= max_member_storage_bytes)
);

CREATE TABLE IF NOT EXISTS reviews (
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

CREATE INDEX IF NOT EXISTS reviews_application_idx ON reviews (application_id, created_at DESC);

CREATE TABLE IF NOT EXISTS leaderboard_entries (
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  score BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, user_id)
);

CREATE INDEX IF NOT EXISTS leaderboard_entries_score_idx
  ON leaderboard_entries (application_id, score DESC, updated_at);

CREATE TABLE IF NOT EXISTS user_save_states (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  state_key TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, application_id, state_key),
  CHECK (state_key ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  CHECK (octet_length(data::text) <= 20000)
);

CREATE TABLE IF NOT EXISTS asset_export_requests (
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

CREATE INDEX IF NOT EXISTS asset_export_requests_org_idx
  ON asset_export_requests (organization_id, status, created_at DESC);
