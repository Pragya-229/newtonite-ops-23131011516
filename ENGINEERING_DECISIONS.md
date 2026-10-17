# Engineering Decisions

## 1. Workflow and roles
**Context:** Brief leaves states/roles open. **Options:** free-form status vs. state machine. **Choice:** Open → In Progress → Awaiting Approval → Resolved → Closed (plus rework edges) in one `TRANSITIONS` map with a minimum role per edge; only Lead/Admin of the item's team can approve. Roles per team: viewer < member < lead < admin. **Trade-off:** hard-coded in code, not configurable per team.

## 2. Optimistic locking (version column)
**Options:** pessimistic row locks, last-write-wins, version check. **Choice:** every edit/transition sends `version`; `UPDATE ... WHERE id=? AND version=?` and 0 rows → 409 with the latest item. **Trade-off:** user must reload and retry on conflict, but no locks are held while a human thinks.

## 3. Atomic claim
Single conditional `UPDATE ... WHERE assignee_id IS NULL`; Postgres serializes concurrent writers on the row, so exactly one wins. No app-level locking needed.

## 4. Idempotency
`Idempotency-Key` header on item creation. The key row is inserted in the same transaction as the item; a concurrent duplicate blocks on the primary key until the first commits, then returns the stored response. **Trade-off:** keys never expire (would add a cleanup job).

## 5. Authorization in one place + history in the same transaction
`authorize(req, teamId, minRole)` is called by every endpoint; non-members get 404 (no existence leak), low roles 403. Every change writes an `activity_events` row inside the same transaction, so history cannot disagree with the item. Lists are always filtered by the caller's teams on the server.

## Search / pagination
Cursor (`id < cursor`) pagination on indexed columns; full-text GIN index on title. **Trade-off:** word-based search, no prefix/fuzzy matching.

## Known limitations
- No transactional outbox / background worker (notifications not implemented).
- No optimistic UI rollback; the UI refetches after each action and shows a "changed, reload" message on 409.
- Minimal styling, no frontend tests, no refresh tokens, no rate limiting.
- Idempotency keys are not expired; activity table is not partitioned.

## Next week I would
Add the outbox worker with retries, partition `activity_events`, add Postgres-backed notification preferences, frontend tests, and a dedicated search engine at 10x scale.
