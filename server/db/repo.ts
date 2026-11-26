import type { CapitationPayment, Claim, Complaint, Db, Enrollee, PARequest, Payment, PaymentFrequency } from '../../src/domain/types';
import type { Sql } from './sql';

/**
 * Data access. Rows are converted to the same domain objects the frontend uses,
 * so `src/domain` functions run unchanged on the server.
 */

type Row = Record<string, unknown>;

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const camelKey = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** snake_case row → camelCase object; timestamps → ISO strings; NULL → absent. */
export function fromRow<T>(row: Row): T {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue;
    out[camelKey(k)] = v instanceof Date ? v.toISOString() : v;
  }
  return out as T;
}

const toParam = (v: unknown) => (v === undefined ? null : v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);

async function insert(sql: Sql, table: string, obj: Row) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  const cols = keys.map(snake).join(', ');
  const ph = keys.map((_, i) => `$${i + 1}`).join(', ');
  await sql.query(`INSERT INTO ${table} (${cols}) VALUES (${ph})`, keys.map((k) => toParam(obj[k])));
}

async function update(sql: Sql, table: string, keyCol: string, key: string, patch: Row) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const set = keys.map((k, i) => `${snake(k)} = $${i + 2}`).join(', ');
  await sql.query(`UPDATE ${table} SET ${set} WHERE ${keyCol} = $1`, [key, ...keys.map((k) => toParam(patch[k]))]);
}

// ---------------- Enrollees ----------------

export interface EnrolleeRecord extends Omit<Enrollee, 'nin'> {
  ninHash: string;
  ninLast4: string;
}

/** Domain view: the NIN is masked — the server never holds it in clear. */
const toEnrollee = (row: Row): Enrollee => {
  const { ninHash: _h, ninLast4, createdAt: _c, ...rest } = fromRow<EnrolleeRecord & { createdAt: string }>(row);
  return { ...rest, nin: '*******' + ninLast4 };
};

export const enrollees = {
  async nextId(sql: Sql) {
    const [r] = await sql.query<{ n: number }>(`SELECT nextval('enrollee_seq') AS n`);
    return Number(r.n);
  },
  insert: (sql: Sql, e: EnrolleeRecord) => insert(sql, 'enrollees', { ...e }),
  async get(sql: Sql, id: string) {
    const [r] = await sql.query(`SELECT * FROM enrollees WHERE id = $1`, [id]);
    return r ? toEnrollee(r) : undefined;
  },
  /** Locks the row for the rest of the transaction — use before read-modify-write. */
  async getForUpdate(sql: Sql, id: string) {
    const [r] = await sql.query(`SELECT * FROM enrollees WHERE id = $1 FOR UPDATE`, [id]);
    return r ? toEnrollee(r) : undefined;
  },
  async findByPhone(sql: Sql, phone: string) {
    const [r] = await sql.query(`SELECT * FROM enrollees WHERE phone = $1`, [phone]);
    return r ? toEnrollee(r) : undefined;
  },
  async findByNinHash(sql: Sql, hash: string) {
    const [r] = await sql.query(`SELECT * FROM enrollees WHERE nin_hash = $1`, [hash]);
    return r ? toEnrollee(r) : undefined;
  },
  async list(sql: Sql, where = 'TRUE', params: unknown[] = []) {
    return (await sql.query(`SELECT * FROM enrollees WHERE ${where} ORDER BY id`, params)).map(toEnrollee);
  },
  setCover: (sql: Sql, id: string, paidThrough: string, frequency: PaymentFrequency) => update(sql, 'enrollees', 'id', id, { paidThrough, frequency }),
  setPrimaryProvider: (sql: Sql, id: string, providerId: string) => update(sql, 'enrollees', 'id', id, { primaryProviderId: providerId }),
};

/** Adds `patientName` to records that carry an enrolleeId (for staff work queues). */
export async function withPatientNames<T extends { enrolleeId: string }>(sql: Sql, rows: T[]): Promise<(T & { patientName: string })[]> {
  const ids = [...new Set(rows.map((r) => r.enrolleeId))];
  const names = new Map<string, string>();
  if (ids.length) {
    const found = await sql.query<{ id: string; first_name: string; last_name: string }>(`SELECT id, first_name, last_name FROM enrollees WHERE id = ANY($1)`, [ids]);
    for (const r of found) names.set(r.id, `${r.first_name} ${r.last_name}`);
  }
  return rows.map((r) => ({ ...r, patientName: names.get(r.enrolleeId) ?? r.enrolleeId }));
}

// ---------------- Payments ----------------

export interface PaymentRecord extends Omit<Payment, 'paidAt'> {
  frequency: PaymentFrequency;
  status: 'pending' | 'confirmed' | 'failed';
  paidAt?: string;
  createdAt?: string;
}

export const payments = {
  insert: (sql: Sql, p: PaymentRecord) => insert(sql, 'payments', { ...p }),
  async byReference(sql: Sql, reference: string, lock = false) {
    const [r] = await sql.query(`SELECT * FROM payments WHERE reference = $1 ${lock ? 'FOR UPDATE' : ''}`, [reference]);
    return r ? fromRow<PaymentRecord>(r) : undefined;
  },
  setStatus: (sql: Sql, id: string, status: PaymentRecord['status'], paidAt?: string) => update(sql, 'payments', 'id', id, { status, paidAt: paidAt ?? null }),
  async list(sql: Sql, where = 'TRUE', params: unknown[] = []) {
    // Pending first, then newest payment first.
    return (await sql.query(`SELECT * FROM payments WHERE ${where} ORDER BY paid_at DESC NULLS FIRST, created_at DESC, id`, params)).map((r) => fromRow<PaymentRecord>(r));
  },
};

// ---------------- Claims ----------------

export const claims = {
  async nextId(sql: Sql) {
    const [r] = await sql.query<{ n: number }>(`SELECT nextval('claim_seq') AS n`);
    return `CLM-${String(r.n).padStart(5, '0')}`;
  },
  insert: (sql: Sql, c: Claim) => insert(sql, 'claims', { ...c }),
  async get(sql: Sql, id: string, lock = false) {
    const [r] = await sql.query(`SELECT * FROM claims WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    return r ? fromRow<Claim>(r) : undefined;
  },
  async list(sql: Sql, where = 'TRUE', params: unknown[] = [], limit = 10_000) {
    return (await sql.query(`SELECT * FROM claims WHERE ${where} ORDER BY submitted_at DESC, id DESC LIMIT ${Math.floor(limit)}`, params)).map((r) => fromRow<Claim>(r));
  },
  update: (sql: Sql, id: string, patch: Partial<Claim> & { reviewedBy?: string; paymentBatch?: string }) => update(sql, 'claims', 'id', id, patch as Row),
};

// ---------------- Pre-authorisation ----------------

export const paRequests = {
  insert: (sql: Sql, p: PARequest) => insert(sql, 'pa_requests', { ...p }),
  async get(sql: Sql, code: string, lock = false) {
    const [r] = await sql.query(`SELECT * FROM pa_requests WHERE code = $1 ${lock ? 'FOR UPDATE' : ''}`, [code]);
    return r ? fromRow<PARequest>(r) : undefined;
  },
  async list(sql: Sql, where = 'TRUE', params: unknown[] = []) {
    return (await sql.query(`SELECT * FROM pa_requests WHERE ${where} ORDER BY requested_at DESC`, params)).map((r) => fromRow<PARequest>(r));
  },
  update: (sql: Sql, code: string, patch: Partial<PARequest> & { decidedBy?: string }) => update(sql, 'pa_requests', 'code', code, patch as Row),
};

// ---------------- Complaints ----------------

export const complaints = {
  async nextId(sql: Sql) {
    const [r] = await sql.query<{ n: number }>(`SELECT nextval('complaint_seq') AS n`);
    return `CMP-${String(r.n).padStart(4, '0')}`;
  },
  insert: (sql: Sql, c: Complaint) => insert(sql, 'complaints', { ...c }),
  async get(sql: Sql, id: string) {
    const [r] = await sql.query(`SELECT * FROM complaints WHERE id = $1`, [id]);
    return r ? fromRow<Complaint>(r) : undefined;
  },
  async list(sql: Sql, where = 'TRUE', params: unknown[] = []) {
    return (await sql.query(`SELECT * FROM complaints WHERE ${where} ORDER BY created_at DESC`, params)).map((r) => fromRow<Complaint>(r));
  },
  update: (sql: Sql, id: string, patch: Partial<Complaint>) => update(sql, 'complaints', 'id', id, patch as Row),
};

// ---------------- Capitation ----------------

export const capitation = {
  async upsert(sql: Sql, c: CapitationPayment) {
    // Lives/amount can be recalculated until the month is paid; a paid row is never changed.
    await sql.query(
      `INSERT INTO capitation (id, provider_id, hmo_id, month, lives, amount, paid_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (provider_id, hmo_id, month) DO UPDATE SET lives = EXCLUDED.lives, amount = EXCLUDED.amount
       WHERE capitation.paid_at IS NULL`,
      [c.id, c.providerId, c.hmoId, c.month, c.lives, c.amount, c.paidAt ?? null],
    );
  },
  async list(sql: Sql, where = 'TRUE', params: unknown[] = []) {
    return (await sql.query(`SELECT * FROM capitation WHERE ${where} ORDER BY month DESC, provider_id`, params)).map((r) => fromRow<CapitationPayment>(r));
  },
  async get(sql: Sql, id: string) {
    const [r] = await sql.query(`SELECT * FROM capitation WHERE id = $1`, [id]);
    return r ? fromRow<CapitationPayment>(r) : undefined;
  },
  /** Returns true only if this call changed the row (guards against double payment). */
  async markPaid(sql: Sql, id: string, paidAt: string) {
    const r = await sql.query(`UPDATE capitation SET paid_at = $2 WHERE id = $1 AND paid_at IS NULL RETURNING id`, [id, paidAt]);
    return r.length === 1;
  },
};

// ---------------- Users ----------------

export type Role = 'member' | 'provider' | 'hmo' | 'regulator';
export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  enrolleeId?: string;
  providerId?: string;
  hmoId?: string;
  disabled: boolean;
}

export const users = {
  insert: (sql: Sql, u: Omit<User, 'disabled'>) => insert(sql, 'users', { ...u }),
  async byUsername(sql: Sql, username: string) {
    const [r] = await sql.query(`SELECT * FROM users WHERE username = $1`, [username]);
    return r ? fromRow<User>(r) : undefined;
  },
  async byId(sql: Sql, id: string) {
    const [r] = await sql.query(`SELECT * FROM users WHERE id = $1`, [id]);
    return r ? fromRow<User>(r) : undefined;
  },
  async count(sql: Sql) {
    const [r] = await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
    return r.n;
  },
};

// ---------------- Audit ----------------

export interface Actor {
  id?: string;
  role: Role | 'system' | 'public' | 'gateway';
}

export const audit = {
  async log(sql: Sql, actor: Actor, action: string, entityType: string, entityId: string, details?: unknown) {
    await sql.query(`INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5,$6)`, [
      actor.id ?? null,
      actor.role,
      action,
      entityType,
      entityId,
      details === undefined ? null : JSON.stringify(details),
    ]);
  },
  async list(sql: Sql, limit = 100, entityType?: string, entityId?: string) {
    const rows = await sql.query(
      `SELECT * FROM audit_log WHERE ($1::text IS NULL OR entity_type = $1) AND ($2::text IS NULL OR entity_id = $2) ORDER BY id DESC LIMIT $3`,
      [entityType ?? null, entityId ?? null, limit],
    );
    return rows.map((r) => fromRow<{ id: number; at: string; actorId?: string; actorRole: string; action: string; entityType: string; entityId: string; details?: unknown }>(r));
  },
};

/** Whole dataset as the domain `Db` shape — used by the analytics functions. */
export async function loadDb(sql: Sql): Promise<Db> {
  const [e, p, c, pa, cm, cap] = await Promise.all([
    enrollees.list(sql),
    payments.list(sql, `status = 'confirmed'`),
    claims.list(sql, 'TRUE', [], 1_000_000),
    paRequests.list(sql),
    complaints.list(sql),
    capitation.list(sql),
  ]);
  return {
    enrollees: e,
    payments: p.map(({ id, enrolleeId, amount, method, paidAt, daysCovered, reference }) => ({ id, enrolleeId, amount, method, paidAt: paidAt!, daysCovered, reference })),
    claims: c,
    paRequests: pa,
    complaints: cm,
    capitation: cap,
  };
}
