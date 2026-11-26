import { randomBytes } from 'node:crypto';

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  host: string;
  /** Postgres connection string. When empty, an embedded PGlite database is used (dev/test only). */
  databaseUrl: string;
  /** Directory for the embedded PGlite database. Empty = in-memory. */
  pgliteDir: string;
  jwtSecret: string;
  /** Key for the HMAC used to store NINs (never stored in clear). Changing it breaks NIN lookups. */
  ninHashKey: string;
  /** Access-token lifetime in seconds. */
  jwtTtlSeconds: number;
  /** Shared secret the payment gateway uses to sign webhooks (HMAC-SHA256). */
  paymentWebhookSecret: string;
  /** Optional shared secret the USSD aggregator must send as ?key=… */
  ussdSecret: string;
  corsOrigins: string[];
  /** Per-IP rate limits on login, enrolment and USSD. Off in tests. */
  rateLimits: boolean;
  /** Load the demo population and demo logins on an empty database. */
  seedDemo: boolean;
  /** Injectable clock so tests can control "now". */
  now: () => Date;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development') as Config['env'];
  const prod = mode === 'production';
  const required = (name: string, devDefault: string) => {
    const v = env[name];
    if (v) return v;
    if (prod) throw new Error(`${name} must be set in production`);
    return devDefault;
  };
  const cfg: Config = {
    env: mode,
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: prod ? required('DATABASE_URL', '') : (env.DATABASE_URL ?? ''),
    pgliteDir: env.PGLITE_DIR ?? '',
    jwtSecret: required('JWT_SECRET', randomBytes(32).toString('hex')),
    jwtTtlSeconds: Number(env.JWT_TTL_SECONDS ?? 8 * 3600),
    ninHashKey: required('NIN_HASH_KEY', 'dev-nin-hash-key'),
    paymentWebhookSecret: required('PAYMENT_WEBHOOK_SECRET', 'dev-webhook-secret'),
    ussdSecret: env.USSD_SECRET ?? '',
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(',').map((s) => s.trim()).filter(Boolean),
    rateLimits: mode !== 'test',
    seedDemo: env.SEED_DEMO ? env.SEED_DEMO === 'true' : !prod,
    now: () => new Date(),
  };
  if (prod && cfg.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  return cfg;
}
