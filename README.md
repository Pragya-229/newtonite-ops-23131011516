# Operations Under Pressure (Newtonite challenge)

Internal web app to create, assign, track and resolve operational work items across teams.
Node.js + Express + PostgreSQL, vanilla JS frontend (served by the API, no build step).

## Run
Prerequisites: Docker, Docker Compose.
```
docker compose up --build        # app on http://localhost:3000 (auto-seeds 3000 items)
```
Without Docker (Node 20+, Postgres running): copy `.env.example` to `.env`, export `DATABASE_URL`, then `npm install && npm run seed && npm start`.

## Demo logins (password for all: `password123`)
| User | Teams / role |
|---|---|
| admin@ops.test | admin in all teams |
| lead1@ops.test / member1@ops.test / member1b@ops.test / viewer1@ops.test | Payments: lead / member / member / viewer |
| lead2@ops.test / member2@ops.test / viewer2@ops.test | Support: lead / member (+viewer in Compliance) / viewer |
| lead3@ops.test / member3@ops.test | Compliance: lead / member |

## Tests
```
docker compose up -d db && npm install && npm test
```
Covers: concurrent claim, stale update, idempotency, workflow + approval rules, team authorization.

## Known limitations
See ENGINEERING_DECISIONS.md.
