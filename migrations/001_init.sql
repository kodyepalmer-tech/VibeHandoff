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
  role TEXT NOT NULL CHECK (role IN ('publisher', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  UNIQUE (oidc_issuer, oidc_subject)
);

CREATE UNIQUE INDEX users_organization_email_idx ON users (organization_id, lower(email));

CREATE INDEX users_organization_id_idx ON users (organization_id);

CREATE TABLE applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by UUID NOT NULL REFERENCES users(id),
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
