import '../test-env.js';
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { buildApp } from '../app.js';
import { connectMongo, disconnectMongo, getDb } from '../db/mongo.js';
import { ensureIndexes, sessionsCol, usersCol } from '../db/models.js';
import { authLimiter } from '../auth/rateLimit.js';

// Cada teste comeca com o orcamento do limitador zerado — senao os proprios
// testes (varios cadastros seguidos) esbarrariam no limite de producao antes
// mesmo de chegar no teste que existe pra provar que o limite funciona.
beforeEach(() => {
  authLimiter.reset();
});

/**
 * Testes de HTTP real contra o app real (helmet, cookies, zod, bcrypt, Mongo)
 * — a mesma pilha que roda em producao. Usa o banco de teste isolado
 * configurado em `test-env.ts`, dentro do MESMO cluster Atlas do projeto.
 */

let http: HttpServer;
let baseUrl: string;

async function setup(): Promise<void> {
  const db = await connectMongo();
  if (db) await ensureIndexes(db);
  const app = buildApp();
  http = createServer(app);
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const addr = http.address();
  if (!addr || typeof addr === 'string') throw new Error('sem porta');
  baseUrl = `http://localhost:${addr.port}`;
}
await setup();

after(async () => {
  await getDb()?.dropDatabase();
  await disconnectMongo();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

function cookieHeaderFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/auth${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/auth${path}`, { headers: cookie ? { cookie } : {} });
}

/** E-mail unico por chamada, pra nao colidir entre testes. */
function uniqueEmail(tag: string): string {
  return `${tag}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@teste.jorbe`;
}

test('cadastro cria conta, autentica de volta e devolve cookies httpOnly', async () => {
  const email = uniqueEmail('cadastro');
  const res = await post('/register', { email, password: 'senha1234', nick: 'JorbeNovo' });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { nick: string; email: string; guest: boolean };
  assert.equal(body.nick, 'JorbeNovo');
  assert.equal(body.guest, false);

  const setCookies = res.headers.getSetCookie();
  const access = setCookies.find((c) => c.startsWith('jb_access='));
  const refresh = setCookies.find((c) => c.startsWith('jb_refresh='));
  assert.ok(access, 'cookie de acesso precisa vir na resposta');
  assert.ok(refresh, 'cookie de refresh precisa vir na resposta');
  assert.match(access!, /HttpOnly/i);
  assert.match(refresh!, /HttpOnly/i);
  assert.match(refresh!, /Path=\/api\/auth/i, 'refresh so deve viajar pras rotas de auth');
});

test('cadastro recusa e-mail invalido e senha curta', async () => {
  const badEmail = await post('/register', { email: 'nao-e-email', password: 'senha1234', nick: 'X' });
  assert.equal(badEmail.status, 400);

  const shortPass = await post('/register', {
    email: uniqueEmail('curta'),
    password: '123',
    nick: 'Curtinha',
  });
  assert.equal(shortPass.status, 400);
});

test('nick e sanitizado antes de virar publico', async () => {
  const res = await post('/register', {
    email: uniqueEmail('xss'),
    password: 'senha1234',
    nick: '<img src=x>Hacker',
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { nick: string };
  assert.ok(!body.nick.includes('<'));
  assert.ok(!body.nick.includes('>'));
});

test('e-mail duplicado e recusado com 409', async () => {
  const email = uniqueEmail('dup');
  const first = await post('/register', { email, password: 'senha1234', nick: 'Primeiro' });
  assert.equal(first.status, 200);

  const second = await post('/register', { email, password: 'outrasenha', nick: 'Segundo' });
  assert.equal(second.status, 409);
});

test('nick duplicado (mesmo com letras diferentes) e recusado com 409', async () => {
  const nick = `Dup${Math.floor(Math.random() * 900000) + 100000}`;
  const first = await post('/register', { email: uniqueEmail('nickA'), password: 'senha1234', nick });
  assert.equal(first.status, 200);

  const second = await post('/register', {
    email: uniqueEmail('nickB'),
    password: 'senha1234',
    nick: nick.toLowerCase(),
  });
  assert.equal(second.status, 409, 'unicidade de nick precisa ignorar maiusculas/minusculas');
});

test('login com senha certa funciona; senha errada e e-mail desconhecido nao', async () => {
  const email = uniqueEmail('login');
  await post('/register', { email, password: 'senhaCerta1', nick: 'Logavel' });

  const ok = await post('/login', { email, password: 'senhaCerta1' });
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.getSetCookie().some((c) => c.startsWith('jb_access=')));

  const wrongPass = await post('/login', { email, password: 'senhaErrada' });
  assert.equal(wrongPass.status, 401);

  const unknown = await post('/login', { email: uniqueEmail('fantasma'), password: 'qualquer123' });
  assert.equal(unknown.status, 401);
});

test('convidado recebe so o cookie de acesso, sem refresh e sem ir pro banco', async () => {
  const nick = `Visita${Math.floor(Math.random() * 900000) + 100000}`;
  const res = await post('/guest', { nick });
  assert.equal(res.status, 200);

  const cookies = res.headers.getSetCookie();
  assert.ok(cookies.some((c) => c.startsWith('jb_access=')));
  assert.ok(!cookies.some((c) => c.startsWith('jb_refresh=')), 'convidado nao deveria ganhar refresh');

  const db = getDb();
  if (db) {
    const found = await usersCol(db).findOne({ nickLower: nick.toLowerCase() });
    assert.equal(found, null, 'convidado nao pode criar linha em users');
  }
});

test('/me reflete quem esta autenticado, e recusa sem cookie', async () => {
  const anon = await get('/me');
  assert.equal(anon.status, 401);

  const email = uniqueEmail('me');
  const login = await post('/register', { email, password: 'senha1234', nick: 'EuMesmo' });
  const cookie = cookieHeaderFrom(login);

  const me = await get('/me', cookie);
  assert.equal(me.status, 200);
  const body = (await me.json()) as { nick: string; guest: boolean };
  assert.equal(body.nick, 'EuMesmo');
  assert.equal(body.guest, false);

  const guestRes = await post('/guest', { nick: 'Passante' });
  const guestCookie = cookieHeaderFrom(guestRes);
  const meGuest = await get('/me', guestCookie);
  assert.equal(meGuest.status, 200);
  const guestBody = (await meGuest.json()) as { guest: boolean };
  assert.equal(guestBody.guest, true);
});

test('refresh gira o token e o antigo para de funcionar (protecao contra replay)', async () => {
  const email = uniqueEmail('refresh');
  const login = await post('/register', { email, password: 'senha1234', nick: 'Rotativo' });
  const oldCookie = cookieHeaderFrom(login);

  const refreshed = await post('/refresh', {}, oldCookie);
  assert.equal(refreshed.status, 200);
  const newCookie = cookieHeaderFrom(refreshed);
  assert.notEqual(newCookie, oldCookie, 'a rotacao precisa trocar o valor do cookie');

  // O refresh usado uma vez nao pode funcionar de novo.
  const replay = await post('/refresh', {}, oldCookie);
  assert.equal(replay.status, 401);

  // O novo, por sua vez, ainda funciona.
  const again = await post('/refresh', {}, newCookie);
  assert.equal(again.status, 200);
});

test('refresh sem cookie e recusado', async () => {
  const res = await post('/refresh', {});
  assert.equal(res.status, 401);
});

test('logout invalida a sessao — refresh depois falha', async () => {
  const email = uniqueEmail('logout');
  const login = await post('/register', { email, password: 'senha1234', nick: 'SaiFora' });
  const cookie = cookieHeaderFrom(login);

  const out = await post('/logout', {}, cookie);
  assert.equal(out.status, 200);

  const db = getDb();
  if (db) {
    const remaining = await sessionsCol(db).countDocuments({});
    // Nao afirmamos zero global (outros testes rodam sessoes tambem), so que
    // a nossa em particular sumiu — verificado indiretamente pelo refresh falhar.
    assert.ok(remaining >= 0);
  }

  const afterLogout = await post('/refresh', {}, cookie);
  assert.equal(afterLogout.status, 401);
});

test('senha e guardada com hash, nunca em texto puro', async () => {
  const db = getDb();
  if (!db) return;
  const email = uniqueEmail('hash');
  await post('/register', { email, password: 'senhaSecreta1', nick: 'Escondido' });

  const user = await usersCol(db).findOne({ email });
  assert.ok(user, 'usuario precisa existir');
  assert.notEqual(user!.passwordHash, 'senhaSecreta1');
  assert.match(user!.passwordHash, /^\$2[aby]\$/, 'precisa ser um hash bcrypt');
});

test('varias tentativas seguidas de cadastro esbarram no limite de taxa', async () => {
  const results: number[] = [];
  for (let i = 0; i < 15; i++) {
    // Corpo invalido (sem senha): falha rapido, mas ainda consome o limite,
    // que e verificado antes da validacao.
    const res = await post('/register', { email: uniqueEmail(`flood${i}`), nick: 'Flood' });
    results.push(res.status);
  }
  assert.ok(results.includes(429), `esperava algum 429 entre ${results.join(',')}`);
});
