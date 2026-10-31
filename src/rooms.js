'use strict';

const crypto = require('crypto');
const db = require('./db');
const security = require('./security');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 6;
const MAX_PAYLOAD_BYTES = 4000;
const MAX_EVENTS_PER_SECOND = 20;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const PRESENCE_SECONDS = 20;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function makeCode() {
  const bytes = crypto.randomBytes(4);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

async function publishedApp(organizationId, slug) {
  const result = await db.query(
    `SELECT applications.*
     FROM applications
     JOIN releases ON releases.application_id = applications.id AND releases.status = 'published'
     WHERE applications.organization_id = $1 AND applications.slug = $2`,
    [organizationId, slug]
  );
  return result.rows[0] || null;
}

async function listPlayers(roomId) {
  const result = await db.query(
    `SELECT user_id, display_name
     FROM play_room_members
     WHERE room_id = $1 AND last_seen_at > now() - ($2 || ' seconds')::interval
     ORDER BY joined_at ASC`,
    [roomId, String(PRESENCE_SECONDS)]
  );
  return result.rows.map((row) => ({ id: row.user_id, displayName: row.display_name }));
}

function presentRoom(room, players) {
  return {
    code: room.code,
    hostUserId: room.host_user_id,
    expiresAt: room.expires_at,
    players,
  };
}

async function loadRoom(organizationId, applicationId, code) {
  const result = await db.query(
    `SELECT * FROM play_rooms
     WHERE organization_id = $1 AND application_id = $2 AND code = $3 AND expires_at > now()`,
    [organizationId, applicationId, code]
  );
  return result.rows[0] || null;
}

async function touch(roomId, user) {
  await db.query(
    `INSERT INTO play_room_members (room_id, user_id, display_name, last_seen_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (room_id, user_id)
     DO UPDATE SET display_name = EXCLUDED.display_name, last_seen_at = now()`,
    [roomId, user.id, user.display_name]
  );
}

async function createRoom({ user, slug }) {
  const application = await publishedApp(user.organization_id, slug);
  if (!application) throw fail(404, 'No published release is available');
  if (!application.multiplayer) throw fail(409, 'This game is solo only');

  await db.query(`DELETE FROM play_room_events WHERE created_at < now() - interval '15 minutes'`);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = makeCode();
    try {
      const created = await db.query(
        `INSERT INTO play_rooms (organization_id, application_id, code, host_user_id, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [user.organization_id, application.id, code, user.id, new Date(Date.now() + ROOM_TTL_MS)]
      );
      const room = created.rows[0];
      await touch(room.id, user);
      return presentRoom(room, await listPlayers(room.id));
    } catch (err) {
      if (err.code !== '23505') throw err;
    }
  }
  throw fail(503, 'Could not open a room');
}

async function listRooms({ user, slug }) {
  const application = await publishedApp(user.organization_id, slug);
  if (!application) throw fail(404, 'No published release is available');
  if (!application.multiplayer) return [];
  const result = await db.query(
    `SELECT play_rooms.code, users.display_name AS host_name, COUNT(play_room_members.user_id)::int AS player_count
     FROM play_rooms
     JOIN users ON users.id = play_rooms.host_user_id
     JOIN play_room_members
       ON play_room_members.room_id = play_rooms.id
      AND play_room_members.last_seen_at > now() - ($3 || ' seconds')::interval
     WHERE play_rooms.application_id = $1
       AND play_rooms.organization_id = $2
       AND play_rooms.expires_at > now()
     GROUP BY play_rooms.id, users.display_name
     ORDER BY play_rooms.created_at DESC
     LIMIT 12`,
    [application.id, user.organization_id, String(PRESENCE_SECONDS)]
  );
  return result.rows.map((row) => ({
    code: row.code,
    hostName: row.host_name,
    playerCount: row.player_count,
  }));
}

async function joinRoom({ user, slug, code }) {
  const application = await publishedApp(user.organization_id, slug);
  if (!application) throw fail(404, 'No published release is available');
  if (!application.multiplayer) throw fail(409, 'This game is solo only');
  const normalized = String(code || '').trim().toUpperCase();
  const room = await loadRoom(user.organization_id, application.id, normalized);
  if (!room) throw fail(404, 'That live room is not open');
  const players = await listPlayers(room.id);
  const already = players.some((player) => player.id === user.id);
  if (!already && players.length >= MAX_PLAYERS) throw fail(409, 'That live room is full');
  await touch(room.id, user);
  return presentRoom(room, await listPlayers(room.id));
}

async function postEvent({ user, slug, code, payload }) {
  const application = await publishedApp(user.organization_id, slug);
  if (!application) throw fail(404, 'No published release is available');
  const room = await loadRoom(user.organization_id, application.id, String(code || '').trim().toUpperCase());
  if (!room) throw fail(404, 'That live room is not open');
  const member = await db.query(
    `SELECT 1 FROM play_room_members WHERE room_id = $1 AND user_id = $2`,
    [room.id, user.id]
  );
  if (!member.rowCount) throw fail(403, 'Join the room before sending a move');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw fail(400, 'Room events must be a JSON object');
  }
  const encoded = JSON.stringify(payload);
  if (encoded.length > MAX_PAYLOAD_BYTES) throw fail(413, 'Room event is too large');
  const recent = await db.query(
    `SELECT COUNT(*)::int AS n FROM play_room_events
     WHERE room_id = $1 AND user_id = $2 AND created_at > now() - interval '1 second'`,
    [room.id, user.id]
  );
  if (recent.rows[0].n >= MAX_EVENTS_PER_SECOND) throw fail(429, 'Too many live updates');
  await touch(room.id, user);
  const inserted = await db.query(
    `INSERT INTO play_room_events (room_id, user_id, payload) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [room.id, user.id, encoded]
  );
  return { id: Number(inserted.rows[0].id) };
}

async function readEvents({ user, slug, code, after }) {
  const application = await publishedApp(user.organization_id, slug);
  if (!application) throw fail(404, 'No published release is available');
  const room = await loadRoom(user.organization_id, application.id, String(code || '').trim().toUpperCase());
  if (!room) throw fail(404, 'That live room is not open');
  const member = await db.query(
    `SELECT 1 FROM play_room_members WHERE room_id = $1 AND user_id = $2`,
    [room.id, user.id]
  );
  if (!member.rowCount) throw fail(403, 'Join the room before reading it');
  await touch(room.id, user);
  const cursor = Number.isFinite(after) && after > 0 ? after : 0;
  const result = await db.query(
    `SELECT id, user_id, payload
     FROM play_room_events
     WHERE room_id = $1 AND id > $2
     ORDER BY id ASC
     LIMIT 100`,
    [room.id, cursor]
  );
  const events = result.rows
    .filter((row) => row.user_id !== user.id)
    .map((row) => ({ id: Number(row.id), from: row.user_id, payload: row.payload }));
  const last = result.rows.length ? Number(result.rows[result.rows.length - 1].id) : cursor;
  return {
    events,
    cursor: last,
    hostUserId: room.host_user_id,
    players: await listPlayers(room.id),
  };
}

function attachRoomRoutes(app, { requireAuth }) {
  app.use('/api/apps/:slug/rooms/:code/events', security.roomEventsLimiter);

  app.post('/api/apps/:slug/rooms', requireAuth, async (req, res, next) => {
    try {
      res.status(201).json({ room: await createRoom({ user: req.user, slug: req.params.slug }) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/apps/:slug/rooms', requireAuth, async (req, res, next) => {
    try {
      res.json({ rooms: await listRooms({ user: req.user, slug: req.params.slug }) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/apps/:slug/rooms/:code/join', requireAuth, async (req, res, next) => {
    try {
      res.json({ room: await joinRoom({ user: req.user, slug: req.params.slug, code: req.params.code }) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/apps/:slug/rooms/:code/events', requireAuth, async (req, res, next) => {
    try {
      res.status(201).json(await postEvent({
        user: req.user,
        slug: req.params.slug,
        code: req.params.code,
        payload: req.body?.payload,
      }));
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/apps/:slug/rooms/:code/events', requireAuth, async (req, res, next) => {
    try {
      const after = Number.parseInt(req.query.after, 10);
      res.json(await readEvents({
        user: req.user,
        slug: req.params.slug,
        code: req.params.code,
        after: Number.isNaN(after) ? 0 : after,
      }));
    } catch (err) {
      next(err);
    }
  });
}

module.exports = {
  attachRoomRoutes,
  createRoom,
  joinRoom,
  listRooms,
  postEvent,
  readEvents,
};
