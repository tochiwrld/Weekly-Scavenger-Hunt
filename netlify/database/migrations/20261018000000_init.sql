CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  nickname TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'participant',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_nickname_uq ON users (lower(nickname));
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE challenges (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '',
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  start_notified BOOLEAN NOT NULL DEFAULT false,
  end_notified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE challenge_items (
  id SERIAL PRIMARY KEY,
  challenge_id INT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL DEFAULT 'easy',
  points INT NOT NULL,
  hint TEXT,
  display_order INT NOT NULL DEFAULT 0
);
CREATE INDEX items_challenge_idx ON challenge_items (challenge_id);

CREATE TABLE submissions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INT NOT NULL REFERENCES challenge_items(id) ON DELETE CASCADE,
  photo_1_key TEXT NOT NULL,
  photo_2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  reviewed_by INT REFERENCES users(id) ON DELETE SET NULL
);
-- one pending-or-approved submission per user per item: blocks duplicates and double approvals
CREATE UNIQUE INDEX submissions_one_active_uq ON submissions (user_id, item_id) WHERE status IN ('pending','approved');
CREATE INDEX submissions_status_idx ON submissions (status, submitted_at);

CREATE TABLE point_transactions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_id INT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  item_id INT REFERENCES challenge_items(id) ON DELETE SET NULL,
  submission_id INT,
  points INT NOT NULL,
  transaction_type TEXT NOT NULL,
  earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- a participant can only ever be paid once for an item
CREATE UNIQUE INDEX points_once_per_item_uq ON point_transactions (user_id, item_id) WHERE transaction_type = 'approval';
CREATE INDEX points_challenge_idx ON point_transactions (challenge_id, user_id);

CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  admin_id INT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  count INT NOT NULL DEFAULT 0
);
