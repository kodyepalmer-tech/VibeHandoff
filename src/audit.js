'use strict';

const logger = require('./logger');
const db = require('./db');

async function record({ organizationId, userId, action, resourceType, resourceId, ip, metadata }) {
  const entry = {
    organizationId: organizationId || null,
    userId: userId || null,
    action,
    resourceType,
    resourceId: resourceId || null,
    ip: ip || null,
    metadata: metadata || {},
  };

  logger.info(
    {
      audit: true,
      action,
      resourceType,
      resourceId: entry.resourceId,
      organizationId: entry.organizationId,
      userId: entry.userId,
      ip: entry.ip,
      metadata: entry.metadata,
    },
    'audit'
  );

  try {
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id, ip, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        entry.organizationId,
        entry.userId,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        entry.ip,
        JSON.stringify(entry.metadata),
      ]
    );
  } catch (err) {
    logger.error({ err, action }, 'failed to persist audit log');
  }
}

module.exports = { record };
