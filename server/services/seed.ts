import { randomUUID } from 'node:crypto';
import { HMOS, PROVIDERS } from '../../src/domain/catalog';
import { DEMO_PERSONAS, generateSeed } from '../../src/domain/seed';
import { hashPassword } from '../auth';
import type { Ctx } from '../context';
import { audit, capitation, claims, complaints, enrollees, paRequests, payments, users } from '../db/repo';
import { hashNin } from './members';

/** Demo logins. Only created when SEED_DEMO is on, never in production by default. */
export const DEMO_LOGINS = {
  memberPin: '123456',
  providerPassword: 'demo-provider',
  hmoPassword: 'demo-hmo',
  regulator: { username: 'regulator', password: 'demo-regulator' },
};

/** Loads the deterministic demo population into an empty database. Returns false if data already exists. */
export async function seedDemo(ctx: Ctx): Promise<boolean> {
  const [{ n }] = await ctx.sql.query<{ n: number }>('SELECT count(*)::int AS n FROM enrollees');
  if (n > 0) return false;
  const db = generateSeed(ctx.today());

  const [memberHash, providerHash, hmoHash, regulatorHash] = await Promise.all([
    hashPassword(DEMO_LOGINS.memberPin),
    hashPassword(DEMO_LOGINS.providerPassword),
    hashPassword(DEMO_LOGINS.hmoPassword),
    hashPassword(DEMO_LOGINS.regulator.password),
  ]);

  await ctx.sql.transaction(async (tx) => {
    for (const e of db.enrollees) {
      const { nin, ...rest } = e;
      await enrollees.insert(tx, { ...rest, ninHash: hashNin(ctx.config.ninHashKey, nin), ninLast4: nin.slice(-4) });
    }
    const freq = new Map(db.enrollees.map((e) => [e.id, e.frequency]));
    for (const p of db.payments) {
      await payments.insert(tx, { ...p, frequency: freq.get(p.enrolleeId)!, status: 'confirmed' });
    }
    for (const pa of db.paRequests) await paRequests.insert(tx, pa);
    for (const c of db.claims) await claims.insert(tx, c);
    for (const c of db.complaints) await complaints.insert(tx, c);
    for (const c of db.capitation) await capitation.upsert(tx, c);

    // Continue numbering after the seeded IDs.
    await tx.query(`SELECT setval('enrollee_seq', $1)`, [db.enrollees.length]);
    await tx.query(`SELECT setval('claim_seq', $1)`, [db.claims.length]);
    await tx.query(`SELECT setval('complaint_seq', $1)`, [db.complaints.length]);

    for (const id of Object.values(DEMO_PERSONAS)) {
      const e = db.enrollees.find((x) => x.id === id)!;
      await users.insert(tx, { id: randomUUID(), username: e.phone, passwordHash: memberHash, role: 'member', enrolleeId: e.id });
    }
    for (const p of PROVIDERS) await users.insert(tx, { id: randomUUID(), username: p.id, passwordHash: providerHash, role: 'provider', providerId: p.id });
    for (const h of HMOS) await users.insert(tx, { id: randomUUID(), username: h.id, passwordHash: hmoHash, role: 'hmo', hmoId: h.id });
    await users.insert(tx, { id: randomUUID(), username: DEMO_LOGINS.regulator.username, passwordHash: regulatorHash, role: 'regulator' });

    await audit.log(tx, { role: 'system' }, 'demo.seeded', 'database', 'demo', { enrollees: db.enrollees.length, claims: db.claims.length });
  });
  return true;
}
