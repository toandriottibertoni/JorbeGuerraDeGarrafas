import { Router, type Request, type Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDb } from '../db/mongo.js';
import { newUserDefaults, sessionsCol, usersCol } from '../db/models.js';
import { hashPassword, hashOpaqueToken, newRefreshToken, verifyPassword } from '../auth/passwords.js';
import {
  ACCESS_TTL_MS,
  GUEST_TTL_MS,
  REFRESH_TTL_MS,
  signAccessToken,
  signGuestToken,
  verifyAccessToken,
} from '../auth/tokens.js';
import { authLimiter } from '../auth/rateLimit.js';
import { firstIssue, guestSchema, loginSchema, registerSchema } from '../auth/validation.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@jorbe/shared';
import { env } from '../env.js';

export const authRouter = Router();

function clientIp(req: Request): string {
  return req.ip ?? 'unknown';
}

function setAccessCookie(res: Response, token: string, maxAgeMs: number): void {
  res.cookie(ACCESS_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProd,
    maxAge: maxAgeMs,
    path: '/',
  });
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProd,
    maxAge: REFRESH_TTL_MS,
    // So os endpoints de auth precisam desse cookie — reduz onde ele viaja.
    path: '/api/auth',
  });
}

function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
}

/** Cria sessao de refresh no banco e devolve o token cru (vai so no cookie). */
async function issueSession(userId: ObjectId, userAgent: string): Promise<string> {
  const db = getDb();
  if (!db) throw new Error('sem banco');
  const { token, hash } = newRefreshToken();
  await sessionsCol(db).insertOne({
    _id: new ObjectId(),
    userId,
    refreshTokenHash: hash,
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    createdAt: new Date(),
    userAgent: userAgent.slice(0, 200),
  });
  return token;
}

authRouter.post('/register', async (req, res) => {
  const db = getDb();
  if (!db) {
    res.status(503).json({ error: 'Banco indisponivel no momento.' });
    return;
  }
  if (!authLimiter.allow(`register:${clientIp(req)}`)) {
    res.status(429).json({ error: 'Muitas tentativas. Espere um pouco.' });
    return;
  }

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  const { email, password, nick } = parsed.data;

  const passwordHash = await hashPassword(password);
  const doc = {
    _id: new ObjectId(),
    email,
    passwordHash,
    nick,
    nickLower: nick.toLowerCase(),
    ...newUserDefaults(),
  };

  try {
    await usersCol(db).insertOne(doc);
  } catch (err) {
    // Erro 11000 = chave duplicada (email ou nick ja usados).
    if (isDuplicateKeyError(err)) {
      res.status(409).json({ error: 'E-mail ou apelido ja estao em uso.' });
      return;
    }
    throw err;
  }

  const access = signAccessToken({ sub: doc._id.toString(), nick: doc.nick, guest: false });
  const refresh = await issueSession(doc._id, req.headers['user-agent'] ?? '');
  setAccessCookie(res, access, ACCESS_TTL_MS);
  setRefreshCookie(res, refresh);
  res.json({ nick: doc.nick, email: doc.email, guest: false });
});

authRouter.post('/login', async (req, res) => {
  const db = getDb();
  if (!db) {
    res.status(503).json({ error: 'Banco indisponivel no momento.' });
    return;
  }
  if (!authLimiter.allow(`login:${clientIp(req)}`)) {
    res.status(429).json({ error: 'Muitas tentativas. Espere um pouco.' });
    return;
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  const { email, password } = parsed.data;

  const user = await usersCol(db).findOne({ email });
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !ok) {
    res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    return;
  }
  if (user.banned) {
    res.status(403).json({ error: 'Esta conta foi banida.' });
    return;
  }

  await usersCol(db).updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

  const access = signAccessToken({ sub: user._id.toString(), nick: user.nick, guest: false });
  const refresh = await issueSession(user._id, req.headers['user-agent'] ?? '');
  setAccessCookie(res, access, ACCESS_TTL_MS);
  setRefreshCookie(res, refresh);
  res.json({ nick: user.nick, email: user.email, guest: false });
});

authRouter.post('/guest', (req, res) => {
  const parsed = guestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }

  const token = signGuestToken(parsed.data.nick);
  setAccessCookie(res, token, GUEST_TTL_MS);
  res.json({ nick: parsed.data.nick, guest: true });
});

authRouter.post('/refresh', async (req, res) => {
  const db = getDb();
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (!db || typeof raw !== 'string') {
    res.status(401).json({ error: 'Sessao expirada. Faca login de novo.' });
    return;
  }

  const hash = hashOpaqueToken(raw);
  const session = await sessionsCol(db).findOne({ refreshTokenHash: hash });
  if (!session || session.expiresAt < new Date()) {
    clearAuthCookies(res);
    res.status(401).json({ error: 'Sessao expirada. Faca login de novo.' });
    return;
  }

  const user = await usersCol(db).findOne({ _id: session.userId });
  if (!user || user.banned) {
    await sessionsCol(db).deleteOne({ _id: session._id });
    clearAuthCookies(res);
    res.status(401).json({ error: 'Conta indisponivel.' });
    return;
  }

  // Rotaciona: o refresh antigo morre, um novo assume o lugar. Limita o
  // estrago de um token de refresh vazado, que so serve uma vez.
  await sessionsCol(db).deleteOne({ _id: session._id });
  const newRefresh = await issueSession(user._id, req.headers['user-agent'] ?? '');
  const access = signAccessToken({ sub: user._id.toString(), nick: user.nick, guest: false });
  setAccessCookie(res, access, ACCESS_TTL_MS);
  setRefreshCookie(res, newRefresh);
  res.json({ nick: user.nick, email: user.email, guest: false });
});

authRouter.post('/logout', async (req, res) => {
  const db = getDb();
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (db && typeof raw === 'string') {
    await sessionsCol(db).deleteOne({ refreshTokenHash: hashOpaqueToken(raw) });
  }
  clearAuthCookies(res);
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  const raw = req.cookies?.[ACCESS_COOKIE];
  const payload = typeof raw === 'string' ? verifyAccessToken(raw) : null;
  if (!payload) {
    res.status(401).json({ error: 'Nao autenticado.' });
    return;
  }
  res.json({ nick: payload.nick, guest: payload.guest });
});

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
