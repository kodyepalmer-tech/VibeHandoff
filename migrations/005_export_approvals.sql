-- Readable name for an export decision. Writes stay on asset_export_requests.
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
