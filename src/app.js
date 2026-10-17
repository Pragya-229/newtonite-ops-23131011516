const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://ops:ops@localhost:5432/ops' });
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const RANK = { viewer: 1, member: 2, lead: 3, admin: 4 };
const ROLE_BY_RANK = { 1: 'viewer', 2: 'member', 3: 'lead', 4: 'admin' };
const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
// status -> { allowed next status: minimum role rank needed }. Approval (awaiting_approval -> resolved/in_progress) needs a Lead.
const TRANSITIONS = {
  open: { in_progress: 2 },
  in_progress: { open: 2, awaiting_approval: 2 },
  awaiting_approval: { resolved: 3, in_progress: 3 },
  resolved: { closed: 2, in_progress: 2 },
  closed: {},
};

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// ---------- auth helpers ----------
function hash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPw(pw, stored) {
  const [salt, h] = stored.split(':');
  const a = crypto.scryptSync(pw, salt, 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sig = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function signToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 8 * 3600e3 })).toString('base64url');
  return body + '.' + sig(body);
}
function readToken(t) {
  const [body, s] = (t || '').split('.');
  if (!body || !s || sig(body) !== s) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() ? p : null;
}

// ---------- shared helpers ----------
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next); // forward async errors to error handler
async function tx(fn) { // run fn inside one DB transaction
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
const log = (c, itemId, actor, kind, detail = {}) =>
  c.query('INSERT INTO activity_events(item_id,actor_id,kind,detail) VALUES($1,$2,$3,$4)', [itemId, actor, kind, detail]);

// THE single permission check used by every endpoint. Non-members get 404 (don't leak existence); low role gets 403.
function authorize(req, teamId, minRole) {
  const r = req.roles.get(teamId);
  if (!r) throw new HttpError(404, 'Not found');
  if (r < RANK[minRole]) throw new HttpError(403, `Requires ${minRole} role`);
}
async function getItem(c, id) {
  const r = await c.query('SELECT * FROM work_items WHERE id=$1', [id]);
  if (!r.rows[0]) throw new HttpError(404, 'Not found');
  return r.rows[0];
}
const conflict = (item) => new HttpError(409, 'Item changed or already taken; reload', { latest: item });

const auth = h(async (req, res, next) => {
  const p = readToken((req.get('Authorization') || '').replace('Bearer ', ''));
  if (!p) throw new HttpError(401, 'Unauthenticated');
  req.user = { id: p.id };
  const m = await pool.query('SELECT team_id, role FROM memberships WHERE user_id=$1', [p.id]);
  req.roles = new Map(m.rows.map((x) => [x.team_id, RANK[x.role]]));
  next();
});

// ---------- app ----------
const app = express();
app.use(express.json());
app.use(express.static(__dirname + '/../public'));

app.post('/login', h(async (req, res) => {
  const { email, password } = req.body || {};
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [String(email || '')]);
  const u = r.rows[0];
  if (!u || !checkPw(String(password || ''), u.pw_hash)) throw new HttpError(401, 'Bad credentials');
  const m = await pool.query('SELECT team_id, role FROM memberships WHERE user_id=$1', [u.id]);
  res.json({ token: signToken({ id: u.id }), user: { id: u.id, name: u.name }, memberships: m.rows });
}));

// Summary counts for the dashboard cards, computed in SQL and scoped to the caller's teams.
app.get('/stats', auth, h(async (req, res) => {
  const r = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status='open')::int AS open,
            count(*) FILTER (WHERE priority='urgent' AND status NOT IN ('resolved','closed'))::int AS urgent,
            count(*) FILTER (WHERE status='awaiting_approval')::int AS awaiting
     FROM work_items WHERE team_id = ANY($1)`, [[...req.roles.keys()]]);
  res.json(r.rows[0]);
}));

// List: server-side filters + search + cursor pagination, always scoped to the caller's teams.
app.get('/items', auth, h(async (req, res) => {
  const q = req.query, teams = [...req.roles.keys()];
  const leadTeams = [...req.roles].filter(([, r]) => r >= RANK.lead).map(([t]) => t);
  const where = ['team_id = ANY($1)'], p = [teams];
  const add = (sql, v) => { p.push(v); where.push(sql.replace('?', '$' + p.length)); };
  if (q.status) add('status = ?', q.status);
  if (q.priority) add('priority = ?', q.priority);
  if (q.type) add('type = ?', q.type);
  if (q.team_id) add('team_id = ?', Number(q.team_id));
  if (q.assignee === 'me') add('assignee_id = ?', req.user.id);
  if (q.unassigned === '1') where.push('assignee_id IS NULL');
  if (q.approvable === '1') { where.push("status = 'awaiting_approval'"); add('team_id = ANY(?)', leadTeams); }
  if (q.q) add("to_tsvector('simple', title) @@ plainto_tsquery('simple', ?)", String(q.q));
  if (q.cursor) add('id < ?', Number(q.cursor));
  const limit = Math.min(Number(q.limit) || 20, 100);
  const r = await pool.query(`SELECT * FROM work_items WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${limit + 1}`, p);
  const items = r.rows.slice(0, limit);
  res.json({ items, nextCursor: r.rows.length > limit ? items[items.length - 1].id : null });
}));

// Create: idempotent via Idempotency-Key header. The key row is inserted in the SAME transaction as the item,
// so a concurrent duplicate blocks on the unique key until we commit, then replays our stored response.
app.post('/items', auth, h(async (req, res) => {
  const b = req.body || {}, key = req.get('Idempotency-Key');
  if (!b.title || !TYPES.includes(b.type) || !PRIORITIES.includes(b.priority) || !Number.isInteger(b.team_id))
    throw new HttpError(400, 'title, type, priority, team_id are required/valid');
  authorize(req, b.team_id, 'member');
  const out = await tx(async (c) => {
    if (key) {
      const k = await c.query('INSERT INTO idempotency_keys(key,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [key, req.user.id]);
      if (!k.rowCount) {
        const s = await c.query('SELECT response FROM idempotency_keys WHERE key=$1 AND user_id=$2', [key, req.user.id]);
        return s.rows[0].response;
      }
    }
    const r = await c.query(
      'INSERT INTO work_items(title,description,type,priority,team_id,created_by,due_date) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [b.title, b.description || '', b.type, b.priority, b.team_id, req.user.id, b.due_date || null]);
    await log(c, r.rows[0].id, req.user.id, 'created', { priority: b.priority });
    if (key) await c.query('UPDATE idempotency_keys SET response=$3 WHERE key=$1 AND user_id=$2', [key, req.user.id, r.rows[0]]);
    return r.rows[0];
  });
  res.status(201).json(out);
}));

app.get('/items/:id', auth, h(async (req, res) => {
  const item = await getItem(pool, Number(req.params.id));
  authorize(req, item.team_id, 'viewer');
  res.json(item);
}));

// Edit with optimistic locking: UPDATE only matches if the client's version is still current.
app.patch('/items/:id', auth, h(async (req, res) => {
  const b = req.body || {}, id = Number(req.params.id);
  if (!Number.isInteger(b.version)) throw new HttpError(400, 'version is required');
  if (b.priority && !PRIORITIES.includes(b.priority)) throw new HttpError(400, 'bad priority');
  const out = await tx(async (c) => {
    const cur = await getItem(c, id);
    authorize(req, cur.team_id, 'member');
    const r = await c.query(
      `UPDATE work_items SET title=COALESCE($3,title), description=COALESCE($4,description), priority=COALESCE($5,priority),
         due_date=COALESCE($6,due_date), version=version+1, updated_at=now()
       WHERE id=$1 AND version=$2 RETURNING *`,
      [id, b.version, b.title ?? null, b.description ?? null, b.priority ?? null, b.due_date ?? null]);
    if (!r.rowCount) throw conflict(await getItem(c, id));
    if (b.priority && b.priority !== cur.priority) await log(c, id, req.user.id, 'priority_changed', { from: cur.priority, to: b.priority });
    await log(c, id, req.user.id, 'edited', { fields: ['title', 'description', 'due_date'].filter((f) => b[f] !== undefined) });
    return r.rows[0];
  });
  res.json(out);
}));

// Atomic claim: conditional UPDATE, 0 rows = someone else won.
app.post('/items/:id/claim', auth, h(async (req, res) => {
  const id = Number(req.params.id);
  const out = await tx(async (c) => {
    const cur = await getItem(c, id);
    authorize(req, cur.team_id, 'member');
    const r = await c.query(
      'UPDATE work_items SET assignee_id=$2, version=version+1, updated_at=now() WHERE id=$1 AND assignee_id IS NULL RETURNING *', [id, req.user.id]);
    if (!r.rowCount) throw conflict(await getItem(c, id));
    await log(c, id, req.user.id, 'assigned', { from: null, to: req.user.id });
    return r.rows[0];
  });
  res.json(out);
}));

// Workflow: allowed-transitions map + role check + version check, all server side.
app.post('/items/:id/transition', auth, h(async (req, res) => {
  const { to, version } = req.body || {}, id = Number(req.params.id);
  if (!Number.isInteger(version)) throw new HttpError(400, 'version is required');
  const out = await tx(async (c) => {
    const cur = await getItem(c, id);
    authorize(req, cur.team_id, 'viewer');
    const need = (TRANSITIONS[cur.status] || {})[to];
    if (!need) throw new HttpError(422, `Cannot move from ${cur.status} to ${to}`);
    authorize(req, cur.team_id, ROLE_BY_RANK[need]);
    const r = await c.query(
      'UPDATE work_items SET status=$3, version=version+1, updated_at=now() WHERE id=$1 AND version=$2 RETURNING *', [id, version, to]);
    if (!r.rowCount) throw conflict(await getItem(c, id));
    await log(c, id, req.user.id, 'status_changed', { from: cur.status, to });
    return r.rows[0];
  });
  res.json(out);
}));

app.post('/items/:id/comments', auth, h(async (req, res) => {
  const id = Number(req.params.id), text = String((req.body || {}).text || '').trim();
  if (!text) throw new HttpError(400, 'text is required');
  await tx(async (c) => {
    authorize(req, (await getItem(c, id)).team_id, 'member');
    await log(c, id, req.user.id, 'comment', { text });
  });
  res.status(201).json({ ok: true });
}));

app.get('/items/:id/activity', auth, h(async (req, res) => {
  const id = Number(req.params.id);
  authorize(req, (await getItem(pool, id)).team_id, 'viewer');
  const r = await pool.query(
    'SELECT e.id, e.kind, e.detail, e.created_at, u.name AS actor FROM activity_events e JOIN users u ON u.id=e.actor_id WHERE item_id=$1 ORDER BY e.id', [id]);
  res.json(r.rows);
}));

app.use((err, req, res, next) => { // central error handler
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

module.exports = { app, pool, hash };
