# TMS — Architecture & Design

## 1. System architecture

```
 Browser (Operations / Transport / Finance / Admin)
   │  HTTPS, httpOnly session cookie. The browser NEVER talks to the database.
   ▼
 Next.js app on Netlify
   ├─ Pages (React)        — render only what the API returned
   ├─ API routes /api/*    — every request: authenticate → load permissions → service call
   └─ Services (src/server)— all business rules, validation, audit, permission-shaped SQL
   │  Postgres connection (server-side secret only)
   ▼
 Supabase Postgres  — RLS enabled on every table with NO policies, and anon/authenticated
                      roles revoked, so Supabase's public API exposes nothing even if a key leaks.
 Supabase Storage   — (Phase 4) private bucket for POD/documents, served via signed URLs.
```

Why this shape: the brief requires that Transport cannot see the selling price *even in the
network tab*. That rules out a browser-to-Supabase design (the one used for the ENTOEN
dashboard), because any row the browser can read, the user can read. Here every byte a user
receives is assembled by server code that knows their permissions.

## 2. Confidentiality design (selling price)

Enforced in independent layers, so a mistake in one doesn't leak:

| Layer | Mechanism |
|---|---|
| Storage | Selling data lives in separate tables (`job_commercials`, `job_revenue_lines`). Job queries don't touch them unless the caller has `finance.selling.view`. |
| Query | SQL is built per caller; commercial joins/columns are simply absent for Transport. |
| Response | DTOs are built from an explicit field whitelist — nothing is spread from a DB row. |
| Inputs | Revenue/profit filters and sorts return 403 for users who can't see them (otherwise a user could binary-search the price with "revenue > X" filters). |
| Derived values | **VAT amount and customer total are hidden too** (5% VAT reveals the price). **Profit is only shown to users who can see both selling and cost** (profit + cost = selling). |
| Activity/audit | Each audit row has a sensitivity (`general`/`cost`/`commercial`/`admin`) and is filtered per viewer. |
| Notifications | Fixed templates with job number only — never amounts. |
| Documents | Document types flagged `is_commercial` (customer invoice, customer quotation) are hidden without `documents.view_commercial` + selling view. |
| Notes | Notes can be marked "commercial" — hidden from Transport. |
| Reports/exports | (Phase 6) will reuse the same service functions, so they inherit the rules. |

Verified by `tests/security.test.ts` (14 tests on real Postgres) using a distinctive price and
asserting it never appears anywhere in a Transport user's responses.

## 3. Database schema

`db/migrations/001_schema.sql` — every table for all phases is created now so later phases
don't need disruptive migrations.

- **Access**: `users`, `roles`, `permissions`, `role_permissions`, `user_permission_overrides`, `departments`
- **Organisation (future)**: `companies`, `branches` (nullable `branch_id` on users/jobs)
- **Masters**: `customers`, `locations`, `drivers`, `vehicles`, `vehicle_types`, `subcontractors`
- **Configurable lists**: `job_statuses`, `status_transitions`, `pod_statuses`, `expense_types`, `revenue_types`, `document_types`, `settings`
- **The job**: `transport_requests` (one central record) → `transport_assignments` (history; one `is_current`), `job_cost_lines`, `job_commercials`, `job_revenue_lines`, `job_documents`, `job_pod`, `job_notes`
- **Audit & comms**: `audit_log` (append-only, enforced by trigger), `notifications`, `saved_views`

Key decisions:
- Pickup/delivery are **snapshotted** onto the job even when picked from saved locations — editing a location later mustn't rewrite history.
- Money is `numeric(14,2)`; the app computes in integer fils (no float errors).
- `search_text` is a denormalised, trigram-indexed column (job no., BOE, customer, driver, mobile, vehicle, locations, email subject) → fast partial-match search at 100k+ rows.
- `busy_window` + GiST indexes on assignments make double-booking checks fast (Phase 3).
- Soft delete (`deleted_at`) on masters and jobs; cancelled jobs remain with `cancel_reason`.
- Indexes on job_number (unique), boe_number, customer, status, request/required dates, driver/vehicle windows.

## 4. Permission matrix (defaults — editable in Roles & permissions)

| Permission | Super Admin | Operations | Transport | Finance |
|---|:-:|:-:|:-:|:-:|
| View / search jobs | ✓ | ✓ | ✓ | ✓ |
| Create requests, edit before assignment, cancel | ✓ | ✓ | – | – |
| Assign driver / vehicle, update status | ✓ | – | ✓ | – |
| Override double-booking | ✓ | – | – | – |
| Upload POD / documents | ✓ | docs | ✓ | – |
| Verify POD | ✓ | – | – | – |
| View buying cost | ✓ | ✓* | ✓ | ✓ |
| Edit buying cost | ✓ | – | ✓ | – |
| **View selling / revenue / VAT / discount** | ✓ | ✓ | **✗** | ✓ |
| Edit selling price | ✓ | ✓ | ✗ | – |
| View profit & margin | ✓ | ✓ | ✗ | ✓ |
| Commercial documents | ✓ | ✓ | ✗ | ✓ |
| Reports / export | ✓ | ✓ | ✓ (ops + cost only) | ✓ |
| Manage drivers / vehicles | ✓ | – | ✓ | – |
| Manage customers | ✓ | ✓ | – | – |
| Users, roles, settings, audit | ✓ | – | – | – |

\* Your matrix lists Operations' buying-cost access as "Optional", but Operations also sees
profit — and profit + revenue reveals the cost. So it's on by default. If you turn it off for
someone, the system automatically hides profit from them too.

Per-user exceptions ("Always allow" / "Never allow") sit on top of the role. Changing a
user's role or permissions signs them out everywhere immediately.

## 5. Screens

Dashboard · Transport requests (open queue) · Jobs (all) · New request · Job detail (status
lane, overview, route, cargo, assignment, financial panel, activity; POD/documents/notes in
Phase 4) · Drivers · Vehicles · Customers · Locations · Financials · Reports · Documents ·
Notifications (bell) · Users · Roles & permissions · Settings.

## 6. Workflow

```
Operations                    System                          Transport
──────────                    ──────                          ─────────
Create request ─────────────► Draft or Pending Assignment ──► notified "New request JOB-1001"
(+ selling price, optional)   audit: created / price set
                                                              Assign driver + vehicle
                              conflict check (driver/vehicle)
Notified "assigned" ◄──────── Assigned ◄───────────────────── enter cost lines
                              Confirmed → Dispatched → Picked up → In transit
Notified "delivered" ◄─────── Delivered ◄──────────────────── mark delivered
                              if POD required → POD Pending (dashboard: action required)
Notified "POD uploaded" ◄──── POD Received ◄───────────────── upload POD
                              Completed (locked for normal users)
Management: revenue, cost, profit per job / customer / driver / vehicle / month
```
Transitions are table-driven (`status_transitions`) so admins can add statuses.

## 7. Financial logic

```
Total transport cost   = Σ cost lines (base, fuel, toll, parking, loading, waiting, other)   [ex-VAT]
Gross revenue          = Σ selling lines (base, additional, waiting, other)                  [ex-VAT]
Net revenue before VAT = gross revenue − discount       (discount can't exceed gross)
VAT                    = net × VAT rate  (rate snapshotted per job; half-up to the fils)
Customer total         = net + VAT
Gross profit           = net revenue − total cost       (never VAT-inclusive)
Margin %               = gross profit ÷ net revenue × 100   (blank when revenue is 0)
```
Spec example verified in tests: 285 cost, 400 selling → VAT 20, total 420, profit 115, margin 28.75%.

## 8. Assumptions made

1. Hosting on Netlify + Supabase Postgres (same as FleetRoute), built-in user accounts (admin creates users and resets passwords; no self sign-up, no email needed).
2. Operations owns selling price (per the confidentiality addendum), superseding section 7's "Operations / Commercial / Admin".
3. Amounts entered excluding VAT; input VAT on costs is stored separately and never enters profit.
4. Timezone Asia/Dubai for "today" and past-date checks (configurable in settings).
5. Operations users see all jobs by default; remove `jobs.view_all` to restrict someone to their own requests.
6. The job number is JOB-1001 onward (prefix configurable).
7. An assignment with no ETA occupies the driver/vehicle for 4 hours from pickup for conflict checks.

## 9. Edge cases identified

- Price inference via VAT, customer total, profit, filters, sorting, audit entries, notifications, invoice attachments, notes — all closed (section 2).
- Admin mis-grants "view profit" to Transport → still hidden (derived rule, tested).
- Last Super Admin can't be disabled or demoted; users can't disable themselves.
- Duplicate BOE: warn and require explicit confirmation (same BOE can legitimately need 2 trucks).
- Brute-force logins: 5 failures lock the account for 15 minutes.
- Disabled users / changed permissions: existing sessions stop working immediately.
- Closed/cancelled jobs: financial edits need `jobs.edit_completed`.
- Editing a saved location doesn't alter old jobs (snapshots).
- Re-assignment keeps history (old assignment rows kept, `is_current` flips).

## 10. Phase 2–3 rules (masters, assignment, workflow)

**Assignment checks** — run on the server inside a transaction, with a per-driver/per-vehicle lock so two
people assigning at the same moment can't double-book.

| Check | Level |
|---|---|
| Driver/vehicle already on another job whose time window overlaps (cancelled jobs ignored; back-to-back is fine) | Blocking |
| Driver on leave / off duty / inactive; vehicle in maintenance / inactive | Blocking |
| Driver licence or visa, vehicle registration or insurance expired on the pickup date | Blocking |
| Vehicle type differs from the type Operations asked for | Warning |
| Cargo weight or volume above the vehicle's capacity | Warning |
| Pickup on a different day from the required date | Warning |

Blocking issues need the "Override double-booking" permission (Super Admin by default) and the override is
written to the job's activity. Warnings just need a second click ("Assign anyway").
A job with no ETA occupies the driver/vehicle for 4 hours from pickup.

**Status moves** follow the `status_transitions` table. Who can make which move:
cancel → `jobs.cancel` (reason required); submit a draft → `jobs.create`; unassign → assign permission;
put a dispatched job back to Assigned → override permission; everything else → `jobs.update_status`.
Super Admin can force any move (logged as forced). Confirmed/Dispatched/Picked up/In transit/Delivered
need a driver and vehicle. Picked up / Delivered record actual times. Completed and POD Received need the
POD uploaded or marked "not required".

**Editing a request:** before assignment → `jobs.edit` (Operations); once assigned → `jobs.edit_assigned`
(not given by default, Transport is notified of the change); after delivery → `jobs.edit_completed`.

**Masters:** removals are soft (history keeps names). A driver, vehicle or customer on an open job can't be
removed; a vehicle type in use can only be made inactive. Driver/vehicle/customer name changes refresh the
job search index.

**Custom statuses:** added between two existing steps; the direct route stays open and cancel is allowed.

## 11. Phase status

| Phase | Status |
|---|---|
| 1 Foundation — auth, users, roles, permissions, full DB | Done |
| 2 Masters — drivers, vehicles, customers, locations, vehicle types, settings, statuses | Done |
| 3 Workflow — availability, assignment with conflict checks, status updates, edit/cancel, notifications | Done |
| 5 core — cost & selling entry, VAT/profit, dashboard KPIs | Done early |
| 4 POD upload/verify, documents, notes | Next |
| 5 Financial dashboard & charts · 6 Reports & export · 7 Email/WhatsApp · 8 Saved views, column prefs | Planned |
