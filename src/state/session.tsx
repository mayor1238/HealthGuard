import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, api, auth } from '../api/client';
import type { Meta, Principal, Role } from '../api/types';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Don't retry auth or validation errors; do retry flaky networks once.
      retry: (n, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && n < 1,
    },
  },
});

interface Session {
  principal: Principal | null;
  /** True until the stored token has been checked. */
  checking: boolean;
  expired: boolean;
  login: (username: string, password: string) => Promise<Principal>;
  logout: () => void;
}

const Ctx = createContext<Session | null>(null);

function SessionProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [checking, setChecking] = useState(!!auth.token);
  const [expired, setExpired] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    if (!auth.token) return;
    api<{ principal: Principal }>('/auth/me')
      .then((r) => setPrincipal(r.principal))
      .catch(() => auth.set(null))
      .finally(() => setChecking(false));
  }, []);

  useEffect(
    () =>
      auth.onExpired(() => {
        setPrincipal(null);
        setExpired(true);
        qc.clear();
      }),
    [qc],
  );

  const login = useCallback(
    async (username: string, password: string) => {
      const r = await api<{ token: string; user: Principal }>('/auth/login', { body: { username, password } });
      auth.set(r.token);
      qc.clear();
      setExpired(false);
      setPrincipal(r.user);
      return r.user;
    },
    [qc],
  );

  const logout = useCallback(() => {
    auth.set(null);
    qc.clear();
    setPrincipal(null);
  }, [qc]);

  return <Ctx.Provider value={{ principal, checking, expired, login, logout }}>{children}</Ctx.Provider>;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>{children}</SessionProvider>
    </QueryClientProvider>
  );
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession must be used inside <AppProviders>');
  return s;
}

/** GET an API path, cached under `key`. Disabled when `path` is null. */
export function useApiQuery<T>(key: QueryKey, path: string | null, opts: { refetchInterval?: number } = {}) {
  return useQuery<T, ApiError>({ queryKey: key, queryFn: () => api<T>(path!), enabled: path !== null, ...opts });
}

/**
 * A mutation that refreshes every cached query under `invalidate` (e.g. ['member']) when it succeeds.
 */
export function useApiMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>, invalidate: QueryKey[] = []) {
  const qc = useQueryClient();
  return useMutation<TResult, ApiError, TVars>({
    mutationFn: fn,
    onSuccess: () => Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k }))),
  });
}

export const useMeta = () => useApiQuery<Meta>(['meta'], '/meta');

export const roleLabel: Record<Role, string> = { member: 'Member', provider: 'Hospital', hmo: 'HMO', regulator: 'Regulator' };
