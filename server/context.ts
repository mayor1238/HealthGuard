import type { Config } from './config';
import type { Sql } from './db/sql';
import type { Actor } from './db/repo';

/** Checks a NIN with the national identity system (NIMC). The default implementation is a stand-in. */
export interface NinVerifier {
  verify(nin: string, person: { firstName: string; lastName: string; dateOfBirth: string }): Promise<boolean>;
}

/** Placeholder until the NIMC integration exists: accepts any well-formed NIN except all-zeros. */
export const stubNinVerifier: NinVerifier = {
  verify: async (nin) => /^\d{11}$/.test(nin) && nin !== '00000000000',
};

export interface Ctx {
  sql: Sql;
  config: Config;
  nin: NinVerifier;
  /** Today's date (YYYY-MM-DD, UTC) from the injectable clock. */
  today(): string;
  nowIso(): string;
}

export function makeCtx(sql: Sql, config: Config, nin: NinVerifier = stubNinVerifier): Ctx {
  return {
    sql,
    config,
    nin,
    today: () => config.now().toISOString().slice(0, 10),
    nowIso: () => config.now().toISOString(),
  };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);
export const badRequest = (msg: string) => new HttpError(400, 'bad_request', msg);
export const forbidden = (msg = 'You do not have access to this resource') => new HttpError(403, 'forbidden', msg);

export const SYSTEM: Actor = { role: 'system' };
