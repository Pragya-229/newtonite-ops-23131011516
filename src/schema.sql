CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pw_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS teams(id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS memberships(
  user_id INT REFERENCES users(id), team_id INT REFERENCES teams(id),
  role TEXT NOT NULL CHECK (role IN ('viewer','member','lead','admin')), PRIMARY KEY(user_id, team_id));
CREATE TABLE IF NOT EXISTS work_items(
  id SERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('incident','customer_issue','payment','compliance','task')),
  priority TEXT NOT NULL CHECK (priority IN ('low','medium','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','awaiting_approval','resolved','closed')),
  team_id INT NOT NULL REFERENCES teams(id), assignee_id INT REFERENCES users(id),
  created_by INT NOT NULL REFERENCES users(id), due_date TIMESTAMPTZ,
  version INT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS activity_events(
  id BIGSERIAL PRIMARY KEY, item_id INT NOT NULL REFERENCES work_items(id), actor_id INT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS idempotency_keys(
  key TEXT NOT NULL, user_id INT NOT NULL, response JSONB, PRIMARY KEY(key, user_id));
CREATE INDEX IF NOT EXISTS idx_items_team_id ON work_items(team_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_assignee ON work_items(assignee_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_status ON work_items(status, team_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_urgent_unassigned ON work_items(team_id, id DESC) WHERE assignee_id IS NULL AND priority='urgent';
CREATE INDEX IF NOT EXISTS idx_items_search ON work_items USING GIN (to_tsvector('simple', title));
CREATE INDEX IF NOT EXISTS idx_activity_item ON activity_events(item_id, id);
