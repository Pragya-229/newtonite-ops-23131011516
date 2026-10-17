const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { app, pool } = require('../src/app');
const { seed } = require('../src/seed');

let base, server;
const tokens = {};
before(async () => {
  await seed(50);
  server = app.listen(0);
  base = 'http://localhost:' + server.address().port;
  for (const e of ['member1', 'member1b', 'lead1', 'viewer1', 'member2']) {
    const r = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: e + '@ops.test', password: 'password123' }) });
    tokens[e] = (await r.json()).token;
  }
});
after(async () => { server.close(); await pool.end(); });

const api = (who, method, path, body, headers = {}) =>
  fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens[who], ...headers },
    body: body ? JSON.stringify(body) : undefined });
const newItem = async (title = 'T') =>
  (await api('member1', 'POST', '/items', { title, type: 'task', priority: 'urgent', team_id: 1 })).json();

test('concurrent claim: exactly one wins', async () => {
  const it = await newItem();
  const rs = await Promise.all([api('member1', 'POST', `/items/${it.id}/claim`), api('member1b', 'POST', `/items/${it.id}/claim`)]);
  assert.deepStrictEqual(rs.map((r) => r.status).sort(), [200, 409]);
});

test('stale update rejected and data unchanged', async () => {
  const it = await newItem('orig');
  assert.strictEqual((await api('member1', 'PATCH', `/items/${it.id}`, { version: 1, title: 'first' })).status, 200);
  const stale = await api('member1b', 'PATCH', `/items/${it.id}`, { version: 1, title: 'second' });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual((await stale.json()).latest.title, 'first');
});

test('same idempotency key creates one item', async () => {
  const body = { title: 'idem-unique-xyz', type: 'task', priority: 'low', team_id: 1 };
  const hd = { 'Idempotency-Key': 'k-' + Date.now() };
  const rs = await Promise.all([api('member1', 'POST', '/items', body, hd), api('member1', 'POST', '/items', body, hd)]);
  const [a, b] = await Promise.all(rs.map((r) => r.json()));
  assert.strictEqual(a.id, b.id);
  const n = await pool.query("SELECT count(*) FROM work_items WHERE title='idem-unique-xyz'");
  assert.strictEqual(n.rows[0].count, '1');
});

test('workflow: invalid jump rejected, only a lead can approve, history recorded', async () => {
  const it = await newItem();
  assert.strictEqual((await api('member1', 'POST', `/items/${it.id}/transition`, { to: 'closed', version: 1 })).status, 422);
  await api('member1', 'POST', `/items/${it.id}/transition`, { to: 'in_progress', version: 1 });
  await api('member1', 'POST', `/items/${it.id}/transition`, { to: 'awaiting_approval', version: 2 });
  assert.strictEqual((await api('member1', 'POST', `/items/${it.id}/transition`, { to: 'resolved', version: 3 })).status, 403);
  assert.strictEqual((await api('lead1', 'POST', `/items/${it.id}/transition`, { to: 'resolved', version: 3 })).status, 200);
  const events = await (await api('lead1', 'GET', `/items/${it.id}/activity`)).json();
  assert.strictEqual(events.filter((e) => e.kind === 'status_changed').length, 3);
});

test('authorization: other team gets 404, viewer cannot write', async () => {
  const it = await newItem();
  assert.strictEqual((await api('member2', 'GET', `/items/${it.id}`)).status, 404);
  assert.strictEqual((await api('member2', 'PATCH', `/items/${it.id}`, { version: 1, title: 'x' })).status, 404);
  assert.strictEqual((await api('viewer1', 'GET', `/items/${it.id}`)).status, 200);
  assert.strictEqual((await api('viewer1', 'POST', `/items/${it.id}/claim`)).status, 403);
});
