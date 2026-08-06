import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { env } from '../env.js';

/**
 * Payload do access token. `sub` e o id do usuario no Mongo para conta
 * registrada, ou um uuid efemero para convidado — o campo `guest` distingue
 * os dois em qualquer lugar que consumir o token.
 */
export interface AccessTokenPayload {
  sub: string;
  nick: string;
  guest: boolean;
}

const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Convidado nao tem refresh: a sessao dura essa janela e depois precisa logar de novo. */
export const GUEST_TTL_SECONDS = 6 * 60 * 60;

export function signAccessToken(payload: AccessTokenPayload, ttlSeconds = ACCESS_TTL_SECONDS): string {
  if (!env.jwtSecret) throw new Error('JWT_SECRET nao configurado.');
  return jwt.sign(payload, env.jwtSecret, { expiresIn: ttlSeconds });
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  if (!env.jwtSecret) return null;
  try {
    const decoded = jwt.verify(token, env.jwtSecret);
    if (typeof decoded !== 'object' || decoded === null) return null;
    const { sub, nick, guest } = decoded as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof nick !== 'string' || typeof guest !== 'boolean') return null;
    return { sub, nick, guest };
  } catch {
    return null;
  }
}

export function signGuestToken(nick: string): string {
  return signAccessToken({ sub: randomUUID(), nick, guest: true }, GUEST_TTL_SECONDS);
}

export const ACCESS_TTL_MS = ACCESS_TTL_SECONDS * 1000;
export const GUEST_TTL_MS = GUEST_TTL_SECONDS * 1000;
