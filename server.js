// ============================================================
// PrivSNS - Render Backend Server
// Node.js + Express + PostgreSQL + Discord OAuth2
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────
// PostgreSQL
// ──────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ──────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.GAS_ORIGIN,   // e.g. https://script.google.com
    'https://script.google.com',
    'http://localhost:3000'
  ],
  credentials: true
}));
app.use(express.json());

// ──────────────────────────────────────────────
// Auth Middleware
// ──────────────────────────────────────────────
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    req.user = payload; // { discord_id, username, ... }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ──────────────────────────────────────────────
// ROUTES: Auth
// ──────────────────────────────────────────────

// Step 1: Discord callback (from OAuth redirect)
app.get('/auth/callback', async (req, res) => {
  const { code, redirect } = req.query;
  if (!code) return res.status(400).send('Missing code');

  const redirectUri = process.env.DISCORD_REDIRECT_URI; // must match Discord app settings

  try {
    // Exchange code for access_token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
      })
    });

    if (!tokenRes.ok) throw new Error('Token exchange failed');
    const tokenData = await tokenRes.json();

    // Get Discord user info
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!userRes.ok) throw new Error('User fetch failed');
    const discordUser = await userRes.json();

    // Upsert user in DB
    const { rows } = await pool.query(
      `INSERT INTO users (discord_id, username, display_name, avatar)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (discord_id)
       DO UPDATE SET username = $2, display_name = $3, avatar = $4, last_login = NOW()
       RETURNING *`,
      [
        discordUser.id,
        discordUser.username,
        discordUser.global_name || discordUser.username,
        discordUser.avatar
      ]
    );
    const user = rows[0];

    // Issue JWT
    const jwtToken = jwt.sign(
      {
        discord_id:   user.discord_id,
        username:     user.username,
        display_name: user.display_name
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Redirect back to GAS with token
    const callbackUrl = redirect || process.env.GAS_ORIGIN;
    res.redirect(`${callbackUrl}?token=${jwtToken}`);

  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

// ──────────────────────────────────────────────
// ROUTES: Users
// ──────────────────────────────────────────────

// Get current user
app.get('/users/me', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE discord_id = $1',
      [req.user.discord_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all users (for sidebar recommendations)
app.get('/users', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT discord_id, username, display_name, avatar FROM users ORDER BY last_login DESC LIMIT 20'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user by discord_id
app.get('/users/:discord_id', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT discord_id, username, display_name, avatar, created_at FROM users WHERE discord_id = $1',
      [req.params.discord_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user's posts
app.get('/users/:discord_id/posts', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, u.username, u.display_name, u.avatar, u.discord_id,
              COUNT(l.id) AS like_count,
              EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.discord_id = $2) AS liked_by_me
       FROM posts p
       JOIN users u ON u.discord_id = p.discord_id
       LEFT JOIN likes l ON l.post_id = p.id
       WHERE p.discord_id = $1
       GROUP BY p.id, u.username, u.display_name, u.avatar, u.discord_id
       ORDER BY p.created_at DESC`,
      [req.params.discord_id, req.user.discord_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// ROUTES: Posts
// ──────────────────────────────────────────────

// Get timeline (all posts, newest first)
app.get('/posts', authRequired, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    const { rows } = await pool.query(
      `SELECT p.*, u.username, u.display_name, u.avatar, u.discord_id,
              COUNT(l.id) AS like_count,
              EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.discord_id = $3) AS liked_by_me
       FROM posts p
       JOIN users u ON u.discord_id = p.discord_id
       LEFT JOIN likes l ON l.post_id = p.id
       GROUP BY p.id, u.username, u.display_name, u.avatar, u.discord_id
       ORDER BY p.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset, req.user.discord_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create post
app.post('/posts', authRequired, async (req, res) => {
  const { content } = req.body;
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'Content is required' });
  }
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 280) {
    return res.status(400).json({ error: 'Content must be 1–280 characters' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO posts (discord_id, content)
       VALUES ($1, $2)
       RETURNING *`,
      [req.user.discord_id, trimmed]
    );
    const post = rows[0];

    // Return with user info
    const { rows: full } = await pool.query(
      `SELECT p.*, u.username, u.display_name, u.avatar, u.discord_id,
              0 AS like_count, false AS liked_by_me
       FROM posts p
       JOIN users u ON u.discord_id = p.discord_id
       WHERE p.id = $1`,
      [post.id]
    );
    res.status(201).json(full[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete post (own only)
app.delete('/posts/:id', authRequired, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM posts WHERE id = $1 AND discord_id = $2',
      [req.params.id, req.user.discord_id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Post not found or not yours' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// ROUTES: Likes
// ──────────────────────────────────────────────

// Like a post
app.post('/posts/:id/like', authRequired, async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO likes (post_id, discord_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, req.user.discord_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unlike a post
app.delete('/posts/:id/like', authRequired, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM likes WHERE post_id = $1 AND discord_id = $2',
      [req.params.id, req.user.discord_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// Health check
// ──────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ──────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PrivSNS API running on port ${PORT}`);
});
