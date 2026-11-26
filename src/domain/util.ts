const DAY_MS = 86_400_000;

export const naira = (n: number) =>
  '₦' + Math.round(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });

export const compactNaira = (n: number) => {
  if (Math.abs(n) >= 1_000_000_000) return `₦${(n / 1_000_000_000).toFixed(1)}bn`;
  if (Math.abs(n) >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1)}m`;
  if (Math.abs(n) >= 1_000) return `₦${(n / 1_000).toFixed(0)}k`;
  return naira(n);
};

/** YYYY-MM-DD for a Date (UTC). */
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export const addDays = (iso: string, days: number) =>
  isoDate(new Date(new Date(iso.slice(0, 10) + 'T00:00:00Z').getTime() + days * DAY_MS));

/** Whole days from a to b (b - a), using calendar dates. */
export const daysBetween = (a: string, b: string) =>
  Math.round(
    (new Date(b.slice(0, 10) + 'T00:00:00Z').getTime() - new Date(a.slice(0, 10) + 'T00:00:00Z').getTime()) / DAY_MS,
  );

export const prettyDate = (iso: string) =>
  new Date(iso.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

export const ageOn = (dob: string, on: string) => {
  const d = new Date(dob + 'T00:00:00Z');
  const o = new Date(on.slice(0, 10) + 'T00:00:00Z');
  let age = o.getUTCFullYear() - d.getUTCFullYear();
  const m = o.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && o.getUTCDate() < d.getUTCDate())) age--;
  return age;
};

/** Luhn check digit, used so a mistyped HealthGuard ID is caught immediately at the front desk. */
export const luhnDigit = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return String((10 - (sum % 10)) % 10);
};

export const makeHealthGuardId = (seq: number) => {
  const body = String(seq).padStart(7, '0');
  return `HG-${body}${luhnDigit(body)}`;
};

export const isValidHealthGuardId = (id: string) => {
  const m = /^HG-(\d{7})(\d)$/.exec(id.trim().toUpperCase());
  return !!m && luhnDigit(m[1]) === m[2];
};

export const isValidNin = (nin: string) => /^\d{11}$/.test(nin.trim());
export const isValidPhone = (phone: string) => /^0[789][01]\d{8}$/.test(phone.replace(/\s/g, ''));

/** Small deterministic PRNG so seeded demo data is stable between reloads. */
export const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const randomCode = (prefix: string, rand: () => number = Math.random, len = 6) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(rand() * chars.length)];
  return `${prefix}-${s}`;
};
