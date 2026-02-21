-- ============================================================
-- PrivSNS Database Schema
-- PostgreSQL (Render内で実行)
-- ============================================================

-- Users table (Discord OAuth2ログインで自動作成)
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  discord_id  VARCHAR(32) UNIQUE NOT NULL,  -- Discord user ID（内部キー）
  username    VARCHAR(64) NOT NULL,          -- Discord username
  display_name VARCHAR(100),                 -- global_name or username
  avatar      VARCHAR(128),                  -- Discord avatar hash
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  last_login  TIMESTAMPTZ DEFAULT NOW()
);

-- Posts table
CREATE TABLE IF NOT EXISTS posts (
  id          SERIAL PRIMARY KEY,
  discord_id  VARCHAR(32) NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  content     VARCHAR(280) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Likes table
CREATE TABLE IF NOT EXISTS likes (
  id          SERIAL PRIMARY KEY,
  post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  discord_id  VARCHAR(32) NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(post_id, discord_id)  -- 1ユーザー1いいねまで
);

-- Follows table (任意・フォロー機能用)
CREATE TABLE IF NOT EXISTS follows (
  id            SERIAL PRIMARY KEY,
  follower_id   VARCHAR(32) NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  following_id  VARCHAR(32) NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(follower_id, following_id),
  CHECK(follower_id != following_id)
);

-- Notifications table (任意・通知機能用)
CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     VARCHAR(32) NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
  type        VARCHAR(20) NOT NULL, -- 'like', 'follow', 'mention'
  from_id     VARCHAR(32) REFERENCES users(discord_id) ON DELETE CASCADE,
  post_id     INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  is_read     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_posts_discord_id   ON posts(discord_id);
CREATE INDEX IF NOT EXISTS idx_posts_created_at   ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_likes_post_id      ON likes(post_id);
CREATE INDEX IF NOT EXISTS idx_likes_discord_id   ON likes(discord_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower   ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following  ON follows(following_id);
CREATE INDEX IF NOT EXISTS idx_notif_user         ON notifications(user_id, is_read);
