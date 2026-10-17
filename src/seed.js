const fs = require('fs');
const { pool, hash } = require('./app');

// Seeds 3 teams, 10 users (password: password123) and n sample items. Pass --if-empty to skip when data exists.
async function seed(n = 3000, ifEmpty = false) {
  await pool.query(fs.readFileSync(__dirname + '/schema.sql', 'utf8'));
  if (ifEmpty && (await pool.query('SELECT 1 FROM users LIMIT 1')).rowCount) return;
  await pool.query('TRUNCATE activity_events, idempotency_keys, work_items, memberships, users, teams RESTART IDENTITY CASCADE');
  for (const t of ['Payments', 'Support', 'Compliance']) await pool.query('INSERT INTO teams(name) VALUES($1)', [t]);
  const pw = hash('password123');
  const users = [ // [email, name, [[team_id, role], ...]]
    ['admin@ops.test', 'Alice Admin', [[1, 'admin'], [2, 'admin'], [3, 'admin']]],
    ['lead1@ops.test', 'Lena Lead (Payments)', [[1, 'lead']]],
    ['member1@ops.test', 'Mo Member (Payments)', [[1, 'member']]],
    ['member1b@ops.test', 'Mia Member (Payments)', [[1, 'member']]],
    ['viewer1@ops.test', 'Vik Viewer (Payments)', [[1, 'viewer']]],
    ['lead2@ops.test', 'Leo Lead (Support)', [[2, 'lead']]],
    ['member2@ops.test', 'Max Member (Support)', [[2, 'member'], [3, 'viewer']]],
    ['viewer2@ops.test', 'Val Viewer (Support)', [[2, 'viewer']]],
    ['lead3@ops.test', 'Lou Lead (Compliance)', [[3, 'lead']]],
    ['member3@ops.test', 'Meg Member (Compliance)', [[3, 'member']]],
  ];
  for (const [email, name, ms] of users) {
    const r = await pool.query('INSERT INTO users(email,name,pw_hash) VALUES($1,$2,$3) RETURNING id', [email, name, pw]);
    for (const [t, role] of ms) await pool.query('INSERT INTO memberships VALUES($1,$2,$3)', [r.rows[0].id, t, role]);
  }
  await pool.query(`
    INSERT INTO work_items(title,description,type,priority,status,team_id,assignee_id,created_by,due_date)
    SELECT 'Item ' || g, 'Sample description ' || g,
      (ARRAY['incident','customer_issue','payment','compliance','task'])[1 + floor(random()*5)::int],
      (ARRAY['low','medium','high','urgent'])[1 + floor(random()*4)::int],
      (ARRAY['open','in_progress','awaiting_approval','resolved','closed'])[1 + floor(random()*5)::int],
      1 + (g % 3),
      CASE WHEN random() < 0.3 THEN NULL
           ELSE (SELECT user_id FROM memberships m WHERE m.team_id = 1 + (g % 3) AND m.role <> 'viewer' ORDER BY random() LIMIT 1) END,
      1, now() + (random()*30 || ' days')::interval
    FROM generate_series(1, $1::int) g`, [n]);
}

module.exports = { seed };
if (require.main === module) {
  seed(3000, process.argv.includes('--if-empty'))
    .then(() => { console.log('Seeded'); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
