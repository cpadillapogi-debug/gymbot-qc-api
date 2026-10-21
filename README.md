# GymBot QC API

Real backend for GymBot QC: Node + Express + PostgreSQL (via Prisma) +
bcrypt + JWT sessions. Replaces the localStorage-based auth in the
frontend repo.

## Local setup

1. Install Postgres locally, or skip straight to Railway/Render (see
   below) and use their hosted Postgres for local dev too.
2. `cp .env.example .env` and fill in `DATABASE_URL` and `JWT_SECRET`
   (see the comments in `.env.example` for how to generate each).
3. `npm install`
4. `npx prisma migrate dev --name init` — creates the `users`, `gyms`,
   and `audit_log_entries` tables from `prisma/schema.prisma`.
5. `npm run dev` — starts the API on `http://localhost:3000`.
6. `curl http://localhost:3000/health` should return `{"ok":true}`.

## Deploying (Railway, easiest path)

1. Push this folder to its own GitHub repo (or a subfolder of your
   existing one — either works).
2. On Railway: New Project → Deploy from GitHub → pick the repo.
3. Add a Postgres plugin in the same project — Railway sets
   `DATABASE_URL` for you automatically.
4. Add `JWT_SECRET` and `FRONTEND_ORIGIN` as environment variables in
   Railway's dashboard.
5. Railway auto-detects the start command from `package.json`
   (`npm start`). It'll build and give you a public URL.
6. Run migrations against the deployed DB once:
   `railway run npx prisma migrate deploy`.

## Routes so far

- `POST /auth/register` — `{ gymName, email, password, confirmPassword }`
- `POST /auth/login` — `{ email, password }`
- `POST /auth/logout`
- `GET /auth/me` — requires the session cookie

All auth state lives in an httpOnly cookie now, not localStorage — the
browser can't read or forge it, which is the main security upgrade
over the old client-only version.

## What's next (not built yet)

- Gym registry routes (`GET/PATCH /gyms/:id`, developer-only listing)
- Audit log write/read routes
- Wiring `js/services/auth-service.js` in the frontend to call this API
  with `fetch(..., { credentials: "include" })` instead of touching
  localStorage
- Rate limiting on `/auth/login` (replaces the old client-side lockout,
  which a user could bypass by clearing localStorage)
