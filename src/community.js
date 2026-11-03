'use strict';

const db = require('./db');
const config = require('./config');
const { median, heatingUp, shareText } = require('./discovery');

const publishedJoin = `
  JOIN applications ON applications.id = launch_events.application_id
  JOIN releases ON releases.application_id = applications.id AND releases.status = 'published'
`;

async function library(userId) {
  const result = await db.query(
    `SELECT applications.slug, applications.name, MAX(launch_events.created_at) AS played_at
     FROM launch_events
     ${publishedJoin}
     WHERE launch_events.user_id = $1
     GROUP BY applications.slug, applications.name
     ORDER BY played_at DESC
     LIMIT 8`,
    [userId]
  );
  return result.rows;
}

async function friendsPlaying(userId) {
  const result = await db.query(
    `SELECT users.display_name, applications.slug, applications.name, MAX(launch_events.created_at) AS played_at
     FROM follows
     JOIN launch_events ON launch_events.user_id = follows.followed_id
     JOIN users ON users.id = follows.followed_id
     ${publishedJoin}
     WHERE follows.follower_id = $1
       AND launch_events.created_at > now() - interval '7 days'
     GROUP BY users.display_name, applications.slug, applications.name
     ORDER BY played_at DESC
     LIMIT 12`,
    [userId]
  );
  return result.rows;
}

async function fresh() {
  const result = await db.query(
    `SELECT applications.slug, applications.name, users.display_name AS creator_name, releases.published_at
     FROM applications
     JOIN users ON users.id = applications.created_by
     JOIN releases ON releases.application_id = applications.id AND releases.status = 'published'
     ORDER BY releases.published_at DESC NULLS LAST
     LIMIT 8`
  );
  return result.rows;
}

async function weeklyPlays() {
  const result = await db.query(
    `SELECT applications.slug, applications.name, users.display_name AS creator_name, COUNT(*)::int AS plays
     FROM launch_events
     ${publishedJoin}
     JOIN users ON users.id = applications.created_by
     WHERE launch_events.created_at > now() - interval '7 days'
     GROUP BY applications.id, applications.slug, applications.name, users.display_name
     ORDER BY plays DESC
     LIMIT 12`
  );
  const typical = median(result.rows.map((row) => row.plays));
  return result.rows.map((row) => ({
    ...row,
    heating: heatingUp(row.plays, typical),
  }));
}

async function wishlist(userId) {
  const result = await db.query(
    `SELECT applications.slug, applications.name, users.display_name AS creator_name
     FROM wishlists
     JOIN applications ON applications.id = wishlists.application_id
     JOIN users ON users.id = applications.created_by
     JOIN releases ON releases.application_id = applications.id AND releases.status = 'published'
     WHERE wishlists.user_id = $1
     ORDER BY wishlists.created_at DESC
     LIMIT 8`,
    [userId]
  );
  return result.rows;
}

async function activity() {
  const shared = await db.query(
    `SELECT share_events.kind, users.display_name, applications.slug, applications.name AS app_name,
            share_events.note, share_events.created_at
     FROM share_events
     JOIN users ON users.id = share_events.user_id
     LEFT JOIN applications ON applications.id = share_events.application_id
     ORDER BY share_events.created_at DESC
     LIMIT 8`
  );
  const reviews = await db.query(
    `SELECT 'review' AS kind, users.display_name, applications.slug, applications.name AS app_name,
            reviews.body AS note, reviews.updated_at AS created_at
     FROM reviews
     JOIN users ON users.id = reviews.user_id
     JOIN applications ON applications.id = reviews.application_id
     WHERE reviews.body <> ''
     ORDER BY reviews.updated_at DESC
     LIMIT 8`
  );
  return [...shared.rows, ...reviews.rows]
    .sort((left, right) => new Date(right.created_at) - new Date(left.created_at))
    .slice(0, 8);
}

async function home(userId) {
  const [libraryRows, friendRows, freshRows, heating, saved, floor] = await Promise.all([
    library(userId),
    friendsPlaying(userId),
    fresh(),
    weeklyPlays(),
    wishlist(userId),
    activity(),
  ]);
  return {
    library: libraryRows,
    friendsPlaying: friendRows,
    fresh: freshRows,
    heating: heating.filter((row) => row.heating),
    wishlist: saved,
    activity: floor,
  };
}

async function publishedApp(slug) {
  const result = await db.query(
    `SELECT applications.*, users.id AS creator_id, users.display_name AS creator_name
     FROM applications
     JOIN users ON users.id = applications.created_by
     JOIN releases ON releases.application_id = applications.id AND releases.status = 'published'
     WHERE applications.slug = $1`,
    [slug]
  );
  if (result.rowCount > 1) {
    const error = new Error('More than one application uses that slug');
    error.status = 409;
    throw error;
  }
  return result.rows[0] || null;
}

async function gameSocial(userId, slug) {
  const application = await publishedApp(slug);
  if (!application) return null;
  const [saved, followed, friends, weekly] = await Promise.all([
    db.query(`SELECT 1 FROM wishlists WHERE user_id = $1 AND application_id = $2`, [userId, application.id]),
    db.query(`SELECT 1 FROM follows WHERE follower_id = $1 AND followed_id = $2`, [userId, application.creator_id]),
    db.query(
      `SELECT users.display_name
       FROM follows
       JOIN users ON users.id = follows.followed_id
       JOIN launch_events ON launch_events.user_id = follows.followed_id
         AND launch_events.application_id = $2
       WHERE follows.follower_id = $1
       GROUP BY users.display_name
       ORDER BY users.display_name`,
      [userId, application.id]
    ),
    weeklyPlays(),
  ]);
  const row = weekly.find((item) => item.slug === slug);
  const url = `${config.portalOrigin}/apps/${application.slug}`;
  return {
    creatorId: application.creator_id,
    creatorName: application.creator_name,
    wishlisted: saved.rowCount > 0,
    followingCreator: followed.rowCount > 0,
    friends: friends.rows.map((item) => item.display_name),
    weeklyPlays: row ? row.plays : 0,
    heating: row ? row.heating : false,
    shareText: shareText({
      kind: 'game',
      appName: application.name,
      creatorName: application.creator_name,
      url,
    }),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function follow(followerId, followedId) {
  if (!UUID.test(String(followedId || ''))) {
    const error = new Error('Player not found');
    error.status = 404;
    throw error;
  }
  if (followerId === followedId) {
    const error = new Error('You cannot follow yourself');
    error.status = 400;
    throw error;
  }
  const person = await db.query(`SELECT id, display_name FROM users WHERE id = $1`, [followedId]);
  if (!person.rowCount) {
    const error = new Error('Player not found');
    error.status = 404;
    throw error;
  }
  await db.query(
    `INSERT INTO follows (follower_id, followed_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [followerId, followedId]
  );
  return person.rows[0];
}

async function unfollow(followerId, followedId) {
  await db.query(`DELETE FROM follows WHERE follower_id = $1 AND followed_id = $2`, [followerId, followedId]);
}

async function saveWish(userId, slug) {
  const application = await publishedApp(slug);
  if (!application) {
    const error = new Error('Application not found');
    error.status = 404;
    throw error;
  }
  await db.query(
    `INSERT INTO wishlists (user_id, application_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, application.id]
  );
  return { slug: application.slug, name: application.name };
}

async function dropWish(userId, slug) {
  const application = await publishedApp(slug);
  if (!application) return;
  await db.query(`DELETE FROM wishlists WHERE user_id = $1 AND application_id = $2`, [userId, application.id]);
}

async function share(userId, { slug, kind, note }) {
  const allowed = new Set(['game', 'review', 'moment', 'playing']);
  if (!allowed.has(kind)) {
    const error = new Error('Share kind must be game, review, moment, or playing');
    error.status = 400;
    throw error;
  }
  const text = String(note || '').trim();
  if ((kind === 'moment' || kind === 'review') && !text) {
    const error = new Error('A shared moment needs a note');
    error.status = 400;
    throw error;
  }
  if (text.length > 280) {
    const error = new Error('Note is too long');
    error.status = 400;
    throw error;
  }
  const application = await publishedApp(slug);
  if (!application) {
    const error = new Error('Application not found');
    error.status = 404;
    throw error;
  }
  await db.query(
    `INSERT INTO share_events (user_id, application_id, kind, note) VALUES ($1, $2, $3, $4)`,
    [userId, application.id, kind, text]
  );
  const url = `${config.portalOrigin}/apps/${application.slug}`;
  return {
    text: shareText({
      kind,
      appName: application.name,
      creatorName: application.creator_name,
      note: text,
      url,
    }),
    url,
  };
}

module.exports = {
  home,
  gameSocial,
  follow,
  unfollow,
  saveWish,
  dropWish,
  share,
};
