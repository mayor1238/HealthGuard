/** Thin fetch wrapper for the HealthGuard API. */

const BASE = `${(import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''}/api/v1`;
const TOKEN_KEY = 'healthguard-token';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
  /** Field → message map for form validation errors. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries(this.issues.map((i) => [i.path, i.message]));
  }
}

// Kept in sessionStorage: survives a reload but not closing the tab, and is not shared across tabs.
let token: string | null = (() => {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
})();
const expiredListeners = new Set<() => void>();

export const auth = {
  get token() {
    return token;
  },
  set(t: string | null) {
    token = t;
    try {
      if (t) sessionStorage.setItem(TOKEN_KEY, t);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable: token lives in memory only */
    }
  },
  onExpired(fn: () => void) {
    expiredListeners.add(fn);
    return () => {
      expiredListeners.delete(fn);
    };
  },
};

export async function api<T>(path: string, init: { method?: string; body?: unknown; form?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  } else if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const sentToken = token;
  if (sentToken) headers.authorization = `Bearer ${sentToken}`;

  let res: Response;
  try {
    res = await fetch(BASE + path, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the HealthGuard server. Check your connection and that the API is running.');
  }
  const text = await res.text();
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson && text ? JSON.parse(text) : text;
  if (!res.ok) {
    if (res.status === 401 && sentToken) {
      auth.set(null);
      expiredListeners.forEach((fn) => fn());
    }
    const d = (typeof data === 'object' && data) || {};
    throw new ApiError(res.status, d.error ?? 'error', d.message ?? `Request failed (${res.status})`, d.issues);
  }
  return data as T;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
