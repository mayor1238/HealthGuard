# HealthGuard API

A Node.js + TypeScript (Fastify) API on PostgreSQL. It runs the **same domain code** as the frontend (`src/domain`), so pricing, eligibility, claims adjudication, fraud rules, PA decisions and USSD menus behave identically on both sides.

## Quick start

No database server needed: the API falls back to embedded PGlite (Postgres compiled to WebAssembly) and loads the demo data.

```bash
npm install
```

```bash
npm run server:dev
```

The API is then on `http://localhost:8080`. Try `curl localhost:8080/healthz`.

To run against a real PostgreSQL database:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/healthguard npm run server:dev
```

To run the full stack (PostgreSQL + API) in Docker:

```bash
docker compose up --build
```

### Demo logins (only created when `SEED_DEMO=true`)

| Role | Username | Password |
|---|---|---|
| Member | `08031234567` (Adaeze, trader), `08061234567` (Musa, rider), `08091234567`, `07031234567` | `123456` (PIN) |
| Hospital | `prv-001` … `prv-012` | `demo-provider` |
| HMO | `hmo-unity`, `hmo-crest`, `hmo-arewa` | `demo-hmo` |
| Regulator | `regulator` | `demo-regulator` |

## Tests

```bash
npm test
```

This runs the domain and API tests on in-memory PGlite. To run the same API suite against a real PostgreSQL database (its `public` schema is wiped first):

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/healthguard_test npx vitest run server
```

## Design

- **Layers:** `routes/` validates input with zod and checks the caller's role. `services/` holds the workflows and transactions. `db/repo.ts` does data access. `src/domain` holds the pure business rules.
- **Auth:** each user logs in and gets a JWT (HS256, 8 hours). Each route group is locked to one role (`member`, `provider`, `hmo`, `regulator`). The account is re-checked on every request, so disabling a user takes effect immediately. Passwords are hashed with scrypt, and logins for unknown usernames take the same time as wrong passwords.
- **Data scoping:** a member only sees their own records, a hospital only its own claims and PA codes, and an HMO only its own members' claims. A request for someone else's record returns 404, so it doesn't reveal that the record exists.
- **NIN privacy:** NINs are stored only as an HMAC (`NIN_HASH_KEY`) plus the last 4 digits. Hospitals can still find a member by NIN, but a database leak does not expose NINs. The front-desk lookup returns age, not date of birth, and never returns phone or NIN.
- **Payments:** the client never extends cover. A member starts a payment, and cover is extended only when the gateway calls `POST /api/v1/webhooks/payments` signed with HMAC-SHA256 (`x-healthguard-signature: sha256=<hex>`). The webhook is idempotent (gateways retry) and rejects wrong amounts. New members have **no cover** until their first payment is confirmed, except sponsored members.
- **Claims integrity:** claims for the same member are serialised with a Postgres advisory lock, so two copies of a bill submitted at once can't both pass the duplicate check. A test proves this; it fails if the lock is removed. Paying a batch only pays claims that are still payable, so double payment is impossible.
- **Audit log:** every state change, and every patient lookup by a hospital, is written to `audit_log` with who did it and when. Regulators can read it.
- **Background job:** every 15 minutes, complaints left open past 48 hours are escalated to the regulator.
- **Hardening:** rate limits on login, enrolment and USSD; a 256 KB body limit; `nosniff`, `no-store` and frame-deny headers; an allow-list for CORS; authorization headers redacted from logs; required secrets enforced in production; dev-only routes disabled in production.

## API (prefix `/api/v1`)

**Public**
| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/login` | `{username, password}` returns `{token, user}` |
| GET | `/auth/me` | The current principal |
| GET | `/catalog` | Plans, HMOs, providers, tariffs, diagnoses, labels |
| POST | `/quotes` | Premium quote |
| GET | `/hmos/performance` | Published HMO performance (payment speed, complaints) |
| POST | `/enrolments` | Enrol and create a member login (phone + 6-digit PIN). Returns a pending first payment. |

**Member** (`/member`): `GET /profile`, `GET|POST /payments`, `GET /claims`, `POST /claims/:id/response` (`confirmed` or `disputed`), `PUT /primary-provider`, `GET|POST /complaints`

**Hospital** (`/provider`): `GET /eligibility?q=<HG ID | phone | NIN>`, `GET|POST /pa-requests`, `POST /claims/preview`, `POST /claims`, `GET /claims?status=`, `GET /claims/:id`, `GET /capitation`

**HMO** (`/hmo`): `GET /overview`, `GET /claims?queue=review|payable|all`, `POST /claims/:id/review`, `POST /claim-payments`, `GET /pa-requests?status=`, `POST /pa-requests/:code/decision`, `GET /complaints?status=`, `POST /complaints/:id/resolve`, `GET /capitation`, `POST /capitation/runs` (`{month}`), `POST /capitation/:id/pay`

**Regulator** (`/regulator`): `GET /summary`, `GET /complaints?status=`, `GET /audit?entityType=&entityId=`

**Integrations**: `POST /webhooks/payments` (signed), `POST /ussd` (Africa's Talking-style form post; responds `CON …` or `END …`), and `POST /dev/payments/:reference/confirm` (simulates the gateway; not available in production)

Errors always look like `{ "error": "<code>", "message": "…" }`. Validation errors also include `issues: [{ path, message }]`.

## Configuration

See `.env.example`. In production, `DATABASE_URL`, `JWT_SECRET` (at least 32 characters), `NIN_HASH_KEY` and `PAYMENT_WEBHOOK_SECRET` are required; the server refuses to start without them.

## Known limitations and next steps

- **External services are stand-ins.** NIN verification (`NinVerifier`) accepts any well-formed NIN, payouts to hospitals are only recorded (no bank transfer), and SMS is not sent. Each sits behind a small interface ready for a real provider (NIMC, Paystack/Flutterwave, a bank payout API, Africa's Talking).
- Reference data (plans, providers, tariffs) is still in code (`src/domain/catalog.ts`). It should move into database tables with admin screens.
- Regulator and HMO analytics load the full dataset into memory. That's fine for a pilot, but they should move to SQL aggregates or materialised views before national scale.
- The frontend still uses its in-browser store. The next step is an API client so the portals use this server.
- Missing for production: refresh tokens or session revocation, MFA for HMO and regulator staff, field-level encryption for clinical data, and backups and monitoring.
