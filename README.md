# Transport Management System

Internal TMS for Operations, Transport and Finance. Next.js on Netlify, Postgres on Supabase.
Design, schema, permission matrix, workflow and financial logic: see `docs/ARCHITECTURE.md`.

## Set up (no command line needed)

1. **Database** — create a new Supabase project. Open *SQL Editor* and run each file in
   `db/migrations/` once, in number order: `001_schema.sql`, `002_seed.sql`, `003_masters_assignment.sql`, `004_pod_documents.sql`, `005_departments_managers.sql`.
2. **Code** — create a private GitHub repo and upload this folder through the GitHub website
   (don't upload `node_modules` or `.next`).
3. **Hosting** — in Netlify, *Add new site → Import from GitHub*, pick the repo. Before deploying,
   add two environment variables:
   - `DATABASE_URL` — Supabase → *Connect* → *Transaction pooler* connection string (port 6543), with your DB password filled in.
   - `SESSION_SECRET` — any random text of 32+ characters.
   - `SUPABASE_URL` — Supabase → Project Settings → Data API → Project URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase → Project Settings → API Keys → the secret / service_role key.
     Server-only; never put it anywhere else. Then use Settings → "Test file storage" in the app.
4. **First sign-in** — `admin@company.local` / `ChangeMe!2026`. You'll be asked to set a new
   password. Then go to *Users* and create accounts for your team.

## For developers

```
npm install
cp .env.example .env.local     # fill in
npm run dev
npm test                       # needs DATABASE_URL pointing at a THROWAWAY database — tests rebuild the schema
# local file uploads without Supabase: STORAGE_DRIVER=local (files go to ./.uploads)
```

Rules for adding features:
- Pages call `/api/*` only. Never query the database from a page or the browser.
- New job fields go through the whitelist in `src/server/jobs.ts` (`BASE_SELECT`). Anything
  commercial goes in `job_commercials`/`job_revenue_lines`, never in `transport_requests`.
- New migrations: add `003_….sql`, `004_….sql` — never edit a migration that's been run.
