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

## 11. Phase 4 — POD, documents, notes

**Storage:** private Supabase Storage bucket `tms-documents` (10 MB/file; PDF, JPG, PNG, XLSX, DOCX).
The browser uploads directly to storage using a one-time signed upload link, so large files never pass
through Netlify's function size limits. The server then confirms the upload using a signed, expiring,
per-user "ticket" and checks the file really arrived before recording it. Downloads go through
`/api/documents/:id/download`, which checks permissions on every click and redirects to a 2-minute link.
Photos over 1.5 MB are shrunk in the browser to max 2000px (a 5 MB phone photo becomes ~0.5 MB).

**Confidentiality:** customer invoices and quotations are "commercial" document types — Transport can't
upload, list, download or delete them (the API answers "not found"), and their upload/removal entries in
the activity log are hidden. Notes can be marked commercial; those are hidden and never notified to Transport.

**POD flow:** upload (pod.upload, Transport) → job goes to POD Received, POD status Uploaded, Operations and
verifiers notified → verify or reject with a reason (pod.verify, Operations + Super Admin) → rejected sends
the job back to POD Pending and notifies Transport → Completed needs POD Uploaded/Verified/Not required.
A verified POD can only be removed by a Super Admin. Removing the last POD reverts the POD status.
Documents are soft-deleted: the record and the file stay for the audit trail.

**Reminders:** delivered jobs with no POD after `pod_reminder_hours` (default 24) notify Transport, then
repeat once per period. The check runs during normal app use (at most every 10 minutes) — no scheduler.

## 12. Phase 5 — Financial dashboard

`/financials` — period presets (today … last year, custom) and combinable filters (customer, driver,
vehicle, vehicle type, status, requested by, assigned by, job number, BOE, completed only).
Jobs counted by required date; drafts and cancelled jobs excluded. Totals and every breakdown
(month, status, customer, driver, vehicle, vehicle type) are summed in integer fils.
VAT is shown separately and never enters profit. CSV export of the breakdown table.

Access: revenue/VAT columns only with `finance.selling.view`; cost only with `finance.buying.view`;
profit only with both + `finance.profit.view`. Transport gets a cost-only page, ranked by cost (so
ordering can't hint at revenue). Charts are dependency-free SVG with text alternatives.

## 13. Phase 6 — Reports

`/reports`: Operational, Financial, Driver, Vehicle, Customer and POD-pending reports. Each has period
(except POD pending, which shows everything outstanding), search, filters, sortable columns, paging and
a totals row covering all matching rows (not just the page).

One server function (`src/server/reports.ts`) produces the screen, print, CSV and Excel output, so the
confidentiality rules are identical everywhere: revenue/VAT/profit columns are removed server-side for
users who can't see them, sorting is only allowed on visible columns, and Transport sees cost-only
versions of the financial and group reports. Exports need `reports.export` and are written to the audit
log (who, which report, period, row count). Excel files have a title block, real numeric cells with
number formats, frozen header and filters; CSV is UTF-8 with BOM for Excel and neutralises text that
would run as a formula. Print / PDF uses a print layout (A4 landscape, Reliance header) and the browser's
"Save as PDF". Export limit: 50,000 rows.

## 14. Company structure — departments and managers (migration 005)

Departments belong to a **side**: Administration, Operations, Transport, Messengers, Finance.
Operations departments: E-Com, Sea-Import, Sea-Export, Air-Import, Air-Export, Documentations,
Commercial (+ "Operations (general)" kept for jobs created before the change). The Super Admin can add,
rename and switch off departments in Settings.

Roles: Super Admin · Operations Manager · Transport Manager · Messenger Manager (department admins,
created only by the Super Admin) · shared sub-user roles (Operations Sub-user, Transport Sub-user,
Messenger, Finance User) · roles a manager creates for their own department.

**Who sees which jobs** (`src/server/scope.ts`, used by every job query): `jobs.view_all` → every
department (Super Admin, Transport, Finance); `jobs.view_department` → own department (+ own requests);
otherwise own requests only. Notifications follow the same rule.

**Managers** (`src/server/team.ts`) manage users and roles of their own department only: never
managers, Super Admins or themselves; can't move people between departments; assign only non-manager
roles of their side or their own department; can hand out only permissions they hold, never admin ones.
A manager's edits never remove exceptions set by the Super Admin.

**Selling price**: off for sub-users by default; each operations manager turns it on per person
("Selling price, revenue and profit" choice on the user) or per department role.

**Hard rule in the database** (`user_has_perm`, migration 005): selling price, revenue, profit and
customer documents can never reach anyone in a Transport or Messenger department, whatever their role
or exceptions say — even if the Super Admin ticks it.

## 15. Messenger runs (migration 006)

Document runs (collect / deliver / submit papers — shipping lines, customs, customers), kept separate from
truck jobs in `messenger_runs` (+ `messenger_run_files`, `messenger_run_notes`). Numbers MR-1001 onward.

Flow: Operations requests (department set automatically) → Messenger Manager is notified and assigns a
messenger (list shows how many open runs each already has that day) → messenger marks **Collected** →
**Delivered** with "received by" and a photo of the receipt (stored in the same private file storage as
PODs, under `runs/`). "Could not complete" needs a reason, notifies the requester and managers, and the
manager reassigns. Cancel needs a reason. Requests can be edited only until assigned.

Visibility (`runScope` in `src/server/runs.ts`): `runs.view_all` → every run (Messenger Manager, Super
Admin); `runs.view_department` → own department (Operations); otherwise only runs they requested or are
assigned to (messengers). Transport has no access. Proof files use the same rule.

Permissions: runs.view_all, runs.view_department, runs.create, runs.cancel, runs.assign, runs.update_status.
Defaults — Messenger Manager: view_all, assign, update_status, cancel · Messenger: update_status ·
Operations Manager and Sub-user: view_department, create, cancel.

### File viewer (no forced downloads)

Clicking any file (POD, job document, Documents page, messenger proof) opens it **on the page** in a
viewer (`FileViewer` in `src/components/JobFiles.tsx`): photos as images, PDFs drawn page by page with
pdf.js (bundled, `isEvalSupported: false`) so Android phones also show them, Excel/Word show a message.
Buttons: Previous/Next, Open in new tab, **Download**, Close. The same permission-checked routes serve
both: `/api/documents/{id}/download?view=1` and `/api/run-files/{id}?view=1` redirect to a 2-minute
signed link that opens in the browser; without `view=1` the link saves the file. Customer invoices stay
hidden from Transport for viewing exactly as for downloading. `X-Frame-Options` is `SAMEORIGIN`.

### Phone app for drivers and messengers (migration 007)

- **Driver role** (`driver`, transport side, `app_only`): permission `jobs.view_assigned` — `jobScope` shows only jobs
  whose current assignment is to a driver record linked to this user. A driver can only take the road steps
  (`DRIVER_STEPS`: dispatched, picked_up, in_transit, delivered) and upload the POD. No masters, dashboard,
  documents page, or price data; the lookups call returns almost nothing for app users.
- **App links** (`src/server/applink.ts`, table `app_links`): "Send app link" on the Drivers page (Transport Manager,
  Super Admin) or the Users page (Messenger Manager, Super Admin — anyone who manages that user). One-time link,
  7 days, only a hash stored; a new link switches off older ones (also the "forgot password" fix). The driver's
  login is created on first send and linked via `drivers.user_id`. Message is sent by WhatsApp (wa.me) or copied.
- `/join/{token}`: choose password → signed in → instructions to add to home screen (Android install button,
  iPhone Share → Add to Home Screen). PWA manifest `src/app/manifest.ts`, icons in `public/app-icon-*.png`.
- Sign-in accepts a **mobile number** (last 9 digits match; a number shared by two accounts can't sign in).
  App users stay signed in 60 days; office users 12 hours.
- `Shell` shows app users a phone layout (no sidebar): drivers → `/my-jobs`, messengers → `/runs`; other pages redirect.
- Drivers are told when a job is given to them, changed, or taken away. Removing a driver switches off their login.

### New Transport Request: Job No., delivery contact, trip documents, 30-day deletion (migration 008)

- **Job No.** (`transport_requests.job_no`): typed by Operations, mandatory, kept exactly as typed (trimmed). The old
  automatic number stays as the **Request No.** (`job_number`, prefix now `TR-`). Existing jobs got their old number as Job No.
  Same department + same Job No. is blocked (app check + unique index `tr_job_no_dept_uq`; cancelled jobs free it);
  another department gets a warning (`JOB_NO_OTHER_DEPT`) and may confirm. Shown on lists, job page, dialogs,
  notifications, reports, trip sheet and the driver app. Search/filter by Job No. everywhere.
- **Delivery contact** name + number mandatory on create (`src/lib/requestRules.ts`, used by form and server); any
  phone number with 7–15 digits (UAE or international). Can be changed later, not emptied.
- **Trip documents**: types Invoice (`shipment_invoice`), Packing list, BOE, BL, Gate pass, Other supporting documents
  (`document_types.is_request_doc`, `retention_days = 30`). Several files per heading, PDF/JPG/PNG, 10 MB. Uploaded from
  the request form after the request is saved; can be added/removed until the trip starts (dispatch), then locked.
  Transport sees "🖨 n to print" on the list and job, opens files in the viewer (**Print**), **Print all**, and
  **Print trip sheet + documents** (one print: a no-price trip sheet with Job No., route, delivery contact, driver,
  vehicle, signatures — then every page of every trip document). PODs and other files are not affected.
- **30-day deletion** (`runDocumentCleanup` in `src/server/documents.ts`): `job_documents.expires_at` = upload time +
  30 days (a replacement gets its own 30 days). Each run deletes the real file from storage first, then marks the
  record `purged_at` and writes "… deleted (30-day rule)" to the job history. Failures: `purge_error`,
  `purge_attempts`, retried next run. Runs logged in `document_cleanup_runs`; one at a time (advisory lock).
  **Schedule**: Netlify scheduled function `netlify/functions/document-cleanup.mjs` (`@hourly`) calls
  `POST /api/cron/document-cleanup` with a key derived from SESSION_SECRET. **Backup**: if no run for 2 hours, the
  next normal page load (notifications check) runs it. **Check**: Settings → Document clean-up (runs, failures, Run now).
  Expired files show "expired, deleted after 30 days"; opening one returns 410 with that message. Jobs and reports stay.
- **Messenger Report** (`reports.ts`, key `messenger`): one list of truck jobs (transport_requests + current
  assignment; dispatch time from the job history "Vehicle Dispatched"; "Assigned by (Transport)" = who assigned it,
  or the subcontractor) and messenger runs (messenger_runs; collected time as dispatch; Job No. only when the run is
  linked to a job). Filters: period (request date), type, Job No., Request/Run No., requester, department, assigned by,
  vehicle, driver, messenger, delivery location, status; sorting, counts, Excel/CSV, print. jobScope + runScope apply.
  Not captured today: a separate "transporter company" (only subcontractor, not used in the UI yet).

## 16. Phase status

| Phase | Status |
|---|---|
| 1 Foundation — auth, users, roles, permissions, full DB | Done |
| 2 Masters — drivers, vehicles, customers, locations, vehicle types, settings, statuses | Done |
| 3 Workflow — availability, assignment with conflict checks, status updates, edit/cancel, notifications | Done |
| 4 POD upload/verify/reject, job documents, Documents page, notes, POD reminders | Done |
| 5 Financial dashboard — KPIs, monthly chart, rankings, breakdown tables, CSV | Done |
| 6 Reports — 7 reports incl. department, Excel/CSV export, print/PDF, export audit | Done |
| Structure stage 1 — departments, managers, department-only visibility | Done |
| Structure stage 2 — messenger runs (request, assign, collected, delivered with photo) | Done |
| File viewer — files open on the page, Download is optional | Done |
| Request update — Job No., delivery contact, trip documents + 30-day deletion, Messenger Report | Done |
| Structure stage 3 — phone app (from a link) for drivers and messengers | Done |
| 7 Email notifications · 8 Saved views, column prefs, live ops table, performance | Planned |
