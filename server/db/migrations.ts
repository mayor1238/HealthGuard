import type { Sql } from './sql';

/** Append-only list of schema migrations. Never edit one that has shipped — add a new one. */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE SEQUENCE enrollee_seq;
CREATE SEQUENCE claim_seq;
CREATE SEQUENCE complaint_seq;

CREATE TABLE enrollees (
  id                  TEXT PRIMARY KEY,
  -- NIN is never stored in clear: a keyed HMAC for lookups plus the last 4 digits for display.
  nin_hash            TEXT NOT NULL UNIQUE,
  nin_last4           TEXT NOT NULL,
  nin_verified        BOOLEAN NOT NULL DEFAULT FALSE,
  first_name          TEXT NOT NULL,
  last_name           TEXT NOT NULL,
  gender              TEXT NOT NULL CHECK (gender IN ('female', 'male')),
  date_of_birth       DATE NOT NULL,
  phone               TEXT NOT NULL UNIQUE,
  state               TEXT NOT NULL,
  lga                 TEXT NOT NULL,
  sector              TEXT NOT NULL CHECK (sector IN ('formal', 'informal', 'vulnerable')),
  plan_id             TEXT NOT NULL,
  hmo_id              TEXT NOT NULL,
  primary_provider_id TEXT NOT NULL,
  dependants          INTEGER NOT NULL CHECK (dependants BETWEEN 0 AND 5),
  enrolled_on         DATE NOT NULL,
  paid_through        DATE NOT NULL,
  frequency           TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'quarterly', 'annual')),
  group_code          TEXT,
  sponsor             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX enrollees_hmo_idx ON enrollees (hmo_id);
CREATE INDEX enrollees_provider_idx ON enrollees (primary_provider_id);

CREATE TABLE payments (
  id            TEXT PRIMARY KEY,
  enrollee_id   TEXT NOT NULL REFERENCES enrollees (id),
  amount        BIGINT NOT NULL CHECK (amount >= 0),
  method        TEXT NOT NULL CHECK (method IN ('card', 'ussd', 'bank_transfer', 'mobile_money', 'agent', 'sponsor')),
  frequency     TEXT NOT NULL,
  days_covered  INTEGER NOT NULL CHECK (days_covered > 0),
  status        TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
  reference     TEXT NOT NULL UNIQUE,
  paid_at       DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_enrollee_idx ON payments (enrollee_id);

CREATE TABLE pa_requests (
  code            TEXT PRIMARY KEY,
  enrollee_id     TEXT NOT NULL REFERENCES enrollees (id),
  provider_id     TEXT NOT NULL,
  hmo_id          TEXT NOT NULL,
  category        TEXT NOT NULL,
  description     TEXT NOT NULL,
  estimated_cost  BIGINT NOT NULL CHECK (estimated_cost >= 0),
  status          TEXT NOT NULL CHECK (status IN ('approved', 'pending', 'denied', 'used')),
  requested_at    TIMESTAMPTZ NOT NULL,
  decided_at      TIMESTAMPTZ,
  expires_at      DATE,
  auto_decided    BOOLEAN NOT NULL,
  note            TEXT,
  decided_by      TEXT
);
CREATE INDEX pa_enrollee_idx ON pa_requests (enrollee_id);
CREATE INDEX pa_hmo_status_idx ON pa_requests (hmo_id, status);

CREATE TABLE claims (
  id                     TEXT PRIMARY KEY,
  enrollee_id            TEXT NOT NULL REFERENCES enrollees (id),
  provider_id            TEXT NOT NULL,
  hmo_id                 TEXT NOT NULL,
  encounter_date         DATE NOT NULL,
  submitted_at           DATE NOT NULL,
  diagnosis              TEXT NOT NULL,
  pa_code                TEXT,
  lines                  JSONB NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('pending_review', 'approved', 'partially_approved', 'rejected', 'paid')),
  decisions              JSONB NOT NULL,
  fraud_flags            JSONB NOT NULL,
  risk_score             INTEGER NOT NULL,
  billed_total           BIGINT NOT NULL,
  approved_total         BIGINT NOT NULL,
  copay_total            BIGINT NOT NULL,
  decided_at             DATE,
  paid_at                DATE,
  enrollee_confirmation  TEXT CHECK (enrollee_confirmation IN ('confirmed', 'disputed')),
  reviewer_note          TEXT,
  reviewed_by            TEXT,
  payment_batch          TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX claims_enrollee_idx ON claims (enrollee_id);
CREATE INDEX claims_provider_idx ON claims (provider_id, submitted_at);
CREATE INDEX claims_hmo_status_idx ON claims (hmo_id, status);

CREATE TABLE complaints (
  id           TEXT PRIMARY KEY,
  enrollee_id  TEXT NOT NULL REFERENCES enrollees (id),
  provider_id  TEXT,
  hmo_id       TEXT NOT NULL,
  category     TEXT NOT NULL,
  description  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('open', 'escalated', 'resolved')),
  channel      TEXT NOT NULL CHECK (channel IN ('app', 'ussd')),
  created_at   TIMESTAMPTZ NOT NULL,
  resolved_at  TIMESTAMPTZ,
  resolution   TEXT
);
CREATE INDEX complaints_hmo_idx ON complaints (hmo_id, status);
CREATE INDEX complaints_enrollee_idx ON complaints (enrollee_id);

CREATE TABLE capitation (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL,
  hmo_id       TEXT NOT NULL,
  month        TEXT NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  lives        INTEGER NOT NULL,
  amount       BIGINT NOT NULL,
  paid_at      DATE,
  UNIQUE (provider_id, hmo_id, month)
);

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('member', 'provider', 'hmo', 'regulator')),
  enrollee_id    TEXT REFERENCES enrollees (id),
  provider_id    TEXT,
  hmo_id         TEXT,
  disabled       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (role = 'member' AND enrollee_id IS NOT NULL) OR
    (role = 'provider' AND provider_id IS NOT NULL) OR
    (role = 'hmo' AND hmo_id IS NOT NULL) OR
    role = 'regulator'
  )
);

CREATE TABLE enrolment_callbacks (
  id          BIGSERIAL PRIMARY KEY,
  phone       TEXT NOT NULL,
  channel     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled     BOOLEAN NOT NULL DEFAULT FALSE
);

-- Every state change is recorded: who, what, when. Required for fraud investigation and NDPA accountability.
CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id     TEXT,
  actor_role   TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  details      JSONB
);
CREATE INDEX audit_entity_idx ON audit_log (entity_type, entity_id);
`,
  },
];

export async function migrate(sql: Sql): Promise<number[]> {
  await sql.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  return sql.transaction(async (tx) => {
    // Serialise concurrent migrators (e.g. several app instances starting together).
    await tx.query('SELECT pg_advisory_xact_lock(727274)');
    const done = new Set((await tx.query<{ version: number }>('SELECT version FROM schema_migrations')).map((r) => r.version));
    const applied: number[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
      applied.push(m.version);
    }
    return applied;
  });
}
