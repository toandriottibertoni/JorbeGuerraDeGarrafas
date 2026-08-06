/**
 * Fala com /api/auth/*. As respostas viram cookies httpOnly — este modulo
 * nunca ve nem guarda senha ou token, so repassa o corpo JSON de volta.
 */

export interface AuthUser {
  nick: string;
  guest: boolean;
}

async function call(path: string, body: unknown): Promise<{ ok: boolean; data: AuthUser | null; error: string | null }> {
  const res = await fetch(`/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<AuthUser> & { error?: string };
  if (!res.ok) return { ok: false, data: null, error: json.error ?? `Erro ${res.status}` };
  return { ok: true, data: json as AuthUser, error: null };
}

export const register = (email: string, password: string, nick: string) =>
  call('/register', { email, password, nick });

export const login = (email: string, password: string) => call('/login', { email, password });

export const playGuest = (nick: string) => call('/guest', { nick });

export const logout = () => call('/logout', {});

/** Tenta recuperar sessao existente: cookie de acesso valido, ou refresh se ele tiver expirado. */
export async function resumeSession(): Promise<AuthUser | null> {
  const me = await fetch('/api/auth/me');
  if (me.ok) return (await me.json()) as AuthUser;

  const refreshed = await fetch('/api/auth/refresh', { method: 'POST' });
  if (!refreshed.ok) return null;
  return (await refreshed.json()) as AuthUser;
}
