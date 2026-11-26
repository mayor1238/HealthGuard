import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { HttpError, type Ctx } from './context';
import { users, type Actor, type Role } from './db/repo';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1 };

/** Format: scrypt$N$r$p$salt$hash (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}

// A real hash of a random password, so unknown usernames take as long as wrong passwords.
let dummyHash: Promise<string> | undefined;

export interface Principal extends Actor {
  id: string;
  role: Role;
  enrolleeId?: string;
  providerId?: string;
  hmoId?: string;
}

const key = (ctx: Ctx) => new TextEncoder().encode(ctx.config.jwtSecret);

export async function login(ctx: Ctx, username: string, password: string) {
  const user = await users.byUsername(ctx.sql, username.trim());
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
  if (!user || !ok || user.disabled) throw new HttpError(401, 'invalid_credentials', 'Wrong username or password');
  const claims = { role: user.role, enrolleeId: user.enrolleeId, providerId: user.providerId, hmoId: user.hmoId };
  const iat = Math.floor(ctx.config.now().getTime() / 1000);
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt(iat)
    .setIssuer('healthguard')
    .setExpirationTime(iat + ctx.config.jwtTtlSeconds)
    .sign(key(ctx));
  return { token, user: { id: user.id, username: user.username, ...claims } };
}

export async function authenticate(ctx: Ctx, req: FastifyRequest): Promise<Principal> {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) throw new HttpError(401, 'unauthenticated', 'Missing bearer token');
  let payload;
  try {
    ({ payload } = await jwtVerify(m[1], key(ctx), { issuer: 'healthguard', algorithms: ['HS256'], currentDate: ctx.config.now() }));
  } catch {
    throw new HttpError(401, 'unauthenticated', 'Invalid or expired token');
  }
  // Re-check the account on every request so disabling a user takes effect immediately.
  const user = await users.byId(ctx.sql, String(payload.sub));
  if (!user || user.disabled) throw new HttpError(401, 'unauthenticated', 'Account disabled');
  return { id: user.id, role: user.role, enrolleeId: user.enrolleeId, providerId: user.providerId, hmoId: user.hmoId };
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/** Fastify preHandler that authenticates and restricts a route group to one role. */
export const requireRole = (ctx: Ctx, role: Role) => async (req: FastifyRequest, _reply: FastifyReply) => {
  const p = await authenticate(ctx, req);
  if (p.role !== role) throw new HttpError(403, 'forbidden', `This endpoint is for ${role} accounts`);
  req.principal = p;
};
