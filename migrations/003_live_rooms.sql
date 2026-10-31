ALTER TABLE applications ADD COLUMN IF NOT EXISTS multiplayer BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS play_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  host_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS play_rooms_application_idx ON play_rooms (application_id, created_at DESC);

CREATE TABLE IF NOT EXISTS play_room_members (
  room_id UUID NOT NULL REFERENCES play_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  display_name TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS play_room_events (
  id BIGSERIAL PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES play_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS play_room_events_room_idx ON play_room_events (room_id, id);
