# GymBot QC API

Real multi-tenant backend for GymBot QC: Node.js + Express + PostgreSQL
(via Prisma) + bcrypt + httpOnly-cookie JWT sessions. This is the
server-side source of truth for auth, leads, conversations, subscriptions,
GCash billing, gym settings, platform config, and the public widget — the
frontend no longer uses localStorage as an authority for any of this
(it keeps a local-only fallback *only* for the Developer's sales-demo
"showcase gym", which has no row in this database at all).

## Architecture at a glance

- **Auth**: bcrypt-hashed passwords, httpOnly JWT session cookie (never
  readable by frontend JS). `SameSite=None; Secure` in production (the
  frontend and this API are deployed to two different origins), `Lax`
  over plain HTTP in local dev.
- **Tenant isolation**: a Gym Owner's `gymId` is read only from their
  verified session (`req.user.gymId`), never from a URL param or request
  body, on every owner-facing route. Developer-only routes additionally
  require `role === "DEVELOPER"` on the verified session.
- **Public widget** (`/public/*`): the only routes reachable without a
  session. No gym-enumeration route exists — a caller must already know
  the gym's `id` (an unguessable cuid). Every route checks the gym isn't
  soft-deleted and that the subscription's `aiEnabled` flag is true.
- **Subscriptions**: a real state machine
  (`trialing → pending_payment → grace_period → suspended → disabled`,
  or `canceled → expired`), re-derived from stored dates on every read.
  `getAmountDue()` is the only place an amount owed is computed, and it's
  always derived from the gym's own stored plan — GCash payment
  submission never trusts a client-supplied amount or plan.
- **GCash billing**: manual proof-of-payment workflow. This is explicitly
  **not** a real payment gateway — an owner uploads a screenshot/reference,
  and a Developer manually approves or rejects it. Approval is the only
  thing that reactivates a gym's subscription.
- **CSRF**: since auth is a cookie (attached automatically by the browser),
  every mutating request must also carry a custom `x-gymbot-client` header,
  which a cross-site form/image/simple-request attack cannot set. Exempt:
  `/public/*` (no session to protect) and `/health`.
- **Rate limiting**: login, register, change-password, and the public
  widget each have their own limiter (see `src/middleware/rateLimit.js`
  for the honest caveat about in-memory, single-process limits).
- **Maintenance mode**: a Developer-only platform-wide kill switch. While
  enabled, every non-Developer request gets `503`; `/health` stays exempt.

## Local setup

1. Install PostgreSQL locally (or point `DATABASE_URL` at a hosted
   Postgres, e.g. Neon, and use that for local dev too).
2. `cp .env.example .env` and fill in `DATABASE_URL` and `JWT_SECRET`
   (see the comments in `.env.example`).
3. `npm install`
4. Apply the migrations. In an environment where the Prisma CLI can
   reach `binaries.prisma.sh` to download its engine, this is just:
   ```
   npx prisma migrate deploy
   ```
   **Known limitation**: in the sandbox this project was built in, the
   Prisma CLI's engine/checksum downloads are blocked by the network
   policy (403 from `binaries.prisma.sh`), so `npx prisma validate`,
   `generate`, and `migrate` could not be run there. As a substitute, both
   migrations under `prisma/migrations/` were verified by hand: applied
   in order via `psql` against a freshly created local database, then
   the resulting schema was diffed column-for-column against
   `prisma/schema.prisma` with `psql \d <table>`. If your environment
   can reach the internet normally, `npx prisma migrate deploy` (or
   `prisma generate` to build the client) should just work — this
   limitation is specific to that sandbox, not to the schema or SQL
   itself.
5. `npm run dev` — starts the API on `http://localhost:3000`.
6. `curl http://localhost:3000/health` → `{"ok":true}`.

## Deploying (Render)

1. New Web Service → connect this repo.
2. Build command: `npm install && npx prisma generate`. Start command:
   `npm start`.
3. Add a Postgres database (Render's own, or an external one like Neon)
   and set `DATABASE_URL` to its connection string (`?sslmode=require`
   for Neon).
4. Set `JWT_SECRET` (long random value — see `.env.example` for how to
   generate one), `FRONTEND_ORIGIN` (your deployed frontend's exact
   origin, comma-separated if more than one), and `NODE_ENV=production`.
5. Once deployed, run the migrations against the real database once:
   `npx prisma migrate deploy` (from a shell with `DATABASE_URL` set to
   the production database — Render's shell tab, or locally with the
   same env var).
6. Confirm `GET https://<your-service>.onrender.com/health` returns
   `{"ok":true}`.

## API surface

| Area | Routes |
|---|---|
| Auth | `POST /auth/register`, `/login`, `/logout`, `/change-password`, `GET /auth/me` |
| Leads (owner) | `GET/POST /leads`, `GET/PATCH/DELETE /leads/:id`, `PATCH /leads/:id/status`, `PATCH /leads/:id/notes`, `DELETE /leads`, `POST /leads/bulk`, `GET /leads/admin/:gymId` (Developer) |
| Conversations (owner) | `GET/POST /conversations`, `GET/PATCH /conversations/:id`, `POST /conversations/:id/messages` |
| Public widget | `GET /public/status`, `GET /public/:gymId`, `GET /public/:gymId/settings`, `POST /public/:gymId/leads`, `POST /public/:gymId/conversations`, `POST /public/:gymId/conversations/:id/messages` |
| Subscriptions (owner) | `GET /subscriptions/plans`, `GET /subscriptions/me`, `POST /subscriptions/me/request-upgrade` |
| Subscriptions (Developer) | `GET /admin/gyms/:id/subscription`, `POST /admin/gyms/:id/subscription/{activate,suspend,disable,reactivate,extend-trial,change-plan,apply-upgrade,change-billing-date,set-status}` |
| GCash billing (owner) | `GET /billing/gcash-settings`, `GET /billing/gcash`, `GET /billing/gcash/pending`, `POST /billing/gcash` |
| GCash billing (Developer) | `PUT /billing/gcash-settings`, `GET /billing/gcash/admin/{queue,all}`, `PATCH /billing/gcash/admin/:id/{approve,reject,note}` |
| Gym settings (owner) | `GET/PUT /gym-settings/me` |
| Gym platform config (owner) | `GET /gym-platform-config/catalog`, `GET/PUT /gym-platform-config/me` |
| Admin | `GET /admin/users`, `GET /admin/users/:id`, `GET /admin/gyms`, `POST /admin/gyms/:id/{delete,restore}`, `POST /admin/users/:id/reset-password`, `GET/PUT /admin/maintenance`, `GET /admin/audit-log` |

## Verification actually performed in this environment

- **JS syntax**: `npm run check` (`node --check` on every file under `src/`) — pass.
- **Automated tests**: `npm test` — 7 tests pass (Node's built-in runner, Prisma stubbed).
  They cover the subscription state machine, access matrix, server-derived
  amount due (financial integrity), the public-widget settings allow-list,
  server-side Gym Platform Config validation, the CSRF header gate, and
  `requireAuth`/`requireRole`.
- **Fresh-database migration chain**: both migrations under `prisma/migrations/`
  applied in sequence via `psql` against a brand-new local Postgres database,
  with no errors; resulting columns matched `prisma/schema.prisma`.
- **Secret scan**: regex scan for API-key/private-key/credentialed-URL shapes
  — nothing found; only `.env.example` (placeholders) ships.
- **Manual route/security review**: tenant id always comes from the session
  (`req.user.gymId`), never from URL/body on owner routes; Developer routes sit
  behind `requireRole("DEVELOPER")`; `leads`, `conversations`, `billing` use
  `gymGate` (soft-deleted gyms blocked, suspended/disabled gyms read-only).

**NOT run (environment limitation):** `prisma validate`, `prisma generate`,
`prisma migrate` (Prisma's engine download was blocked in the build sandbox),
and no end-to-end HTTP tests against a running server with a real Prisma
client. Run `npx prisma validate && npx prisma generate && npx prisma migrate deploy`
yourself before deploying.

## Known gaps / not completed

- No integration tests against a live database (only the stubbed unit tests above).
- No server-side Invoice/Commission ledger: `GcashPayment` is a flat table.
- GCash settings `qrImageFileName` is not persisted server-side.
- Rate limiting uses the in-memory store (single instance only).
- Password reset is an audit-logged placeholder, not an email flow.
- Bot replies from the anonymous widget are not persisted server-side for real gyms
  (only customer messages are) by design, since the widget is unauthenticated.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `JWT_SECRET` | yes | Long random value; rotating it invalidates all sessions |
| `FRONTEND_ORIGIN` | no (defaults to `http://localhost:5500`) | Comma-separated exact origins allowed via CORS |
| `PORT` | no (defaults to `3000`) | |
| `NODE_ENV` | no | Set to `production` when deployed behind HTTPS |
