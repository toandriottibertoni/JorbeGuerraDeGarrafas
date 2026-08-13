import '../test-env.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import {
  ACCESS_COOKIE,
  ENGINE_VERSION,
  type MatchStart,
  type ResolutionPlan,
  type RoomState,
  type RoundPrep,
  type Snapshot,
} from '@jorbe/shared';
import { createGateway } from './gateway.js';
import type { RoomManager } from '../match/RoomManager.js';
import { buildApp } from '../app.js';
import { connectMongo, disconnectMongo, getDb } from '../db/mongo.js';
import { ensureIndexes } from '../db/models.js';

/**
 * Testes de fiacao: sobem o app real (HTTP de auth + Socket.IO) e falam com
 * ele por rede de verdade. Os testes do MatchEngine ja provam as REGRAS da
 * rodada; aqui a pergunta e outra — as mensagens chegam nos canais certos,
 * e a identidade de fato vem do cookie, nao do que o cliente alega ser?
 */

interface Harness {
  http: HttpServer;
  io: Server;
  rooms: RoomManager;
  port: number;
  baseUrl: string;
  clients: ClientSocket[];
}

let dbReady: Promise<void> | null = null;

async function ensureDb(): Promise<void> {
  if (!dbReady) {
    dbReady = (async () => {
      const db = await connectMongo();
      if (db) await ensureIndexes(db);
    })();
  }
  await dbReady;
}

after(async () => {
  await getDb()?.dropDatabase();
  await disconnectMongo();
});

async function startServer(reconnectGraceMs?: number): Promise<Harness> {
  await ensureDb();
  const app = buildApp();
  const http = createServer(app);
  const io = new Server(http);
  const rooms = createGateway(io, reconnectGraceMs);
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const addr = http.address();
  if (!addr || typeof addr === 'string') throw new Error('sem porta');
  return { http, io, rooms, port: addr.port, baseUrl: `http://localhost:${addr.port}`, clients: [] };
}

async function stopServer(h: Harness): Promise<void> {
  for (const c of h.clients) c.disconnect();
  h.rooms.stop();
  await h.io.close();
  await new Promise<void>((resolve) => h.http.close(() => resolve()));
}

/** Mint um cookie de acesso de convidado batendo na rota HTTP de verdade. */
async function guestCookie(baseUrl: string, nick: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nick }),
  });
  if (!res.ok) throw new Error(`guest auth falhou: ${res.status}`);
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${ACCESS_COOKIE}=`));
  if (!raw) throw new Error('cookie de acesso nao veio na resposta');
  return raw.split(';')[0];
}

/** Conecta, autenticado como convidado, e faz o hello. Devolve o socket pronto. */
async function connect(h: Harness, nick: string): Promise<ClientSocket> {
  const cookie = await guestCookie(h.baseUrl, nick);
  const sock = ioc(h.baseUrl, { transports: ['websocket'], extraHeaders: { Cookie: cookie } });
  h.clients.push(sock);
  await new Promise<void>((resolve, reject) => {
    sock.on('connect_error', reject);
    sock.on('connect', () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    sock.once('hello', (res: { ok: boolean; reason?: string }) => {
      if (res.ok) resolve();
      else reject(new Error(res.reason ?? 'hello recusado'));
    });
    sock.emit('hello', { engineVersion: ENGINE_VERSION });
  });
  return sock;
}

/** Conecta como convidado e devolve o cookie (pra reconectar depois) junto com o id ESTAVEL (nao muda numa reconexao). */
async function connectAndGetId(
  h: Harness,
  nick: string,
): Promise<{ sock: ClientSocket; playerId: string; cookie: string }> {
  const cookie = await guestCookie(h.baseUrl, nick);
  const sock = ioc(h.baseUrl, { transports: ['websocket'], extraHeaders: { Cookie: cookie } });
  h.clients.push(sock);
  await new Promise<void>((resolve, reject) => {
    sock.on('connect_error', reject);
    sock.on('connect', () => resolve());
  });
  const playerId = await new Promise<string>((resolve, reject) => {
    sock.once('hello', (res: { ok: boolean; reason?: string; playerId: string }) => {
      if (res.ok) resolve(res.playerId);
      else reject(new Error(res.reason ?? 'hello recusado'));
    });
    sock.emit('hello', { engineVersion: ENGINE_VERSION });
  });
  return { sock, playerId, cookie };
}

/**
 * So abre o transporte com um cookie ja existente, SEM mandar o hello ainda
 * — quem chama precisa registrar os listeners de `roomState`/`matchStart`
 * antes de emitir, senao corre o risco de perder esses eventos: o servidor
 * manda hello + rooms + roomState + matchStart em rajada, tudo na mesma
 * volta sincrona do handler, entao um listener plugado DEPOIS do hello
 * responder pode chegar tarde demais pros que vieram logo em seguida.
 */
async function connectTransportWithCookie(h: Harness, cookie: string): Promise<ClientSocket> {
  const sock = ioc(h.baseUrl, { transports: ['websocket'], extraHeaders: { Cookie: cookie } });
  h.clients.push(sock);
  await new Promise<void>((resolve, reject) => {
    sock.on('connect_error', reject);
    sock.on('connect', () => resolve());
  });
  return sock;
}

/** Reconecta com um cookie ja existente — simula o MESMO jogador voltando depois de uma queda de rede. */
async function reconnectWithCookie(h: Harness, cookie: string): Promise<ClientSocket> {
  const sock = await connectTransportWithCookie(h, cookie);
  await new Promise<void>((resolve, reject) => {
    sock.once('hello', (res: { ok: boolean; reason?: string }) => {
      if (res.ok) resolve();
      else reject(new Error(res.reason ?? 'hello recusado'));
    });
    sock.emit('hello', { engineVersion: ENGINE_VERSION });
  });
  return sock;
}

/** Espera um evento chegar, com prazo. */
function waitFor<T>(sock: ClientSocket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.off(event, handler);
      reject(new Error(`timeout esperando "${event}"`));
    }, timeoutMs);
    const handler = (payload: T): void => {
      clearTimeout(timer);
      sock.off(event, handler);
      resolve(payload);
    };
    sock.on(event, handler);
  });
}

test('cliente com versao de motor errada e recusado e desconectado', async () => {
  const h = await startServer();
  try {
    const sock = ioc(h.baseUrl, { transports: ['websocket'] });
    h.clients.push(sock);
    await new Promise<void>((resolve) => sock.on('connect', () => resolve()));

    const res = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      sock.once('hello', resolve);
      sock.emit('hello', { engineVersion: ENGINE_VERSION + 99 });
    });

    assert.equal(res.ok, false);
    assert.match(res.reason ?? '', /desatualizada/i);
  } finally {
    await stopServer(h);
  }
});

test('sem cookie de sessao, o hello e recusado', async () => {
  const h = await startServer();
  try {
    const sock = ioc(h.baseUrl, { transports: ['websocket'] });
    h.clients.push(sock);
    await new Promise<void>((resolve) => sock.on('connect', () => resolve()));

    const res = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      sock.once('hello', resolve);
      sock.emit('hello', { engineVersion: ENGINE_VERSION });
    });

    assert.equal(res.ok, false);
    assert.match(res.reason ?? '', /login/i);
  } finally {
    await stopServer(h);
  }
});

test('cookie adulterado (assinatura invalida) tambem e recusado', async () => {
  const h = await startServer();
  try {
    const sock = ioc(h.baseUrl, {
      transports: ['websocket'],
      extraHeaders: { Cookie: `${ACCESS_COOKIE}=isso.nao.e.um.jwt.valido` },
    });
    h.clients.push(sock);
    await new Promise<void>((resolve) => sock.on('connect', () => resolve()));

    const res = await new Promise<{ ok: boolean }>((resolve) => {
      sock.once('hello', resolve);
      sock.emit('hello', { engineVersion: ENGINE_VERSION });
    });

    assert.equal(res.ok, false, 'um JWT forjado nao pode autenticar ninguem');
  } finally {
    await stopServer(h);
  }
});

test('a identidade vem do cookie, nunca do que o cliente alega no evento hello', async () => {
  const h = await startServer();
  try {
    const cookie = await guestCookie(h.baseUrl, 'NomeReal');
    const sock = ioc(h.baseUrl, { transports: ['websocket'], extraHeaders: { Cookie: cookie } });
    h.clients.push(sock);
    await new Promise<void>((resolve) => sock.on('connect', () => resolve()));

    const res = await new Promise<{ nick: string }>((resolve) => {
      sock.once('hello', resolve);
      // O tipo HelloRequest nem tem mais campo de nick — mas simulamos um
      // cliente adulterado mandando um payload extra mesmo assim.
      sock.emit('hello', { engineVersion: ENGINE_VERSION, nick: 'NomeFalsoInjetado' } as never);
    });

    assert.equal(res.nick, 'NomeReal', 'o nick tem que vir do cookie assinado pelo servidor');
  } finally {
    await stopServer(h);
  }
});

test('nick perigoso e higienizado antes de virar publico', async () => {
  const h = await startServer();
  try {
    const cookie = await guestCookie(h.baseUrl, '<img src=x>Hacker');
    const sock = ioc(h.baseUrl, { transports: ['websocket'], extraHeaders: { Cookie: cookie } });
    h.clients.push(sock);
    await new Promise<void>((resolve) => sock.on('connect', () => resolve()));

    const res = await new Promise<{ nick: string }>((resolve) => {
      sock.once('hello', resolve);
      sock.emit('hello', { engineVersion: ENGINE_VERSION });
    });

    assert.ok(!res.nick.includes('<'), `nick deveria estar limpo, veio "${res.nick}"`);
    assert.ok(!res.nick.includes('>'));
  } finally {
    await stopServer(h);
  }
});

test('criar sala, ser dono e aparecer no lobby dos outros', async () => {
  const h = await startServer();
  try {
    const dono = await connect(h, 'Dono');
    const outro = await connect(h, 'Outro');

    const statePromise = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomCreate', { name: 'Minha Sala', mapId: 'praia' });
    const state = await statePromise;

    assert.equal(state.name, 'Minha Sala');
    assert.equal(state.mapId, 'praia');
    assert.equal(state.players.length, 1);
    assert.ok(state.players[0].isHost);

    const lobby = await waitFor<{ id: string; name: string }[]>(outro, 'rooms');
    assert.ok(lobby.some((r) => r.name === 'Minha Sala'), 'a sala precisa aparecer pros outros');
  } finally {
    await stopServer(h);
  }
});

test('segundo jogador entra na sala e os dois veem a lista atualizada', async () => {
  const h = await startServer();
  try {
    const dono = await connect(h, 'Dono');
    const visita = await connect(h, 'Visita');

    const created = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomCreate', { name: 'Sala Cheia', mapId: 'fabrica' });
    const room = await created;

    const joined = waitFor<RoomState>(visita, 'roomState');
    visita.emit('roomJoin', { roomId: room.id });
    const afterJoin = await joined;

    assert.equal(afterJoin.players.length, 2);
    assert.deepEqual(
      afterJoin.players.map((p) => p.nick).sort(),
      ['Dono', 'Visita'],
    );
  } finally {
    await stopServer(h);
  }
});

test('so o dono pode comecar, e nao comeca sozinho', async () => {
  const h = await startServer();
  try {
    const dono = await connect(h, 'Dono');
    const visita = await connect(h, 'Visita');

    const created = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomCreate', { name: 'Sala', mapId: 'fabrica' });
    const room = await created;

    const joined = waitFor<RoomState>(visita, 'roomState');
    visita.emit('roomJoin', { roomId: room.id });
    await joined;

    const naoDono = waitFor<string>(visita, 'errorMsg');
    visita.emit('roomStart');
    assert.match(await naoDono, /dono/i);
  } finally {
    await stopServer(h);
  }
});

test('partida so comeca com o minimo de jogadores', async () => {
  const h = await startServer();
  try {
    const dono = await connect(h, 'Sozinho');
    const created = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomCreate', { name: 'Solo', mapId: 'fabrica' });
    await created;

    const err = waitFor<string>(dono, 'errorMsg');
    dono.emit('roomStart');
    assert.match(await err, /pelo menos/i);
  } finally {
    await stopServer(h);
  }
});

test('dono troca a fase (mapa) da sala antes de comecar', async () => {
  const h = await startServer();
  try {
    const dono = await connect(h, 'Dono');

    const created = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomCreate', { name: 'Sala', mapId: 'fabrica' });
    await created;

    const changed = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomSetMap', { mapId: 'praia' });
    const state = await changed;

    assert.equal(state.mapId, 'praia');
  } finally {
    await stopServer(h);
  }
});

test('so o dono pode trocar a fase da sala', async () => {
  const h = await startServer();
  try {
    const dono = await connect(h, 'Dono');
    const visita = await connect(h, 'Visita');

    const created = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomCreate', { name: 'Sala', mapId: 'fabrica' });
    const room = await created;

    const joined = waitFor<RoomState>(visita, 'roomState');
    visita.emit('roomJoin', { roomId: room.id });
    await joined;

    const err = waitFor<string>(visita, 'errorMsg');
    visita.emit('roomSetMap', { mapId: 'praia' });
    assert.match(await err, /dono/i);
  } finally {
    await stopServer(h);
  }
});

test('dono remove um Jorbot especifico da sala', async () => {
  const h = await startServer();
  try {
    const dono = await connect(h, 'Dono');

    const created = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomCreate', { name: 'Sala', mapId: 'fabrica' });
    await created;

    const withFirst = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomAddDummy');
    await withFirst;

    const withSecond = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomAddDummy');
    const roomWithBots = await withSecond;

    const bots = roomWithBots.players.filter((p) => p.isBot);
    assert.equal(bots.length, 2);

    const afterRemove = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomRemoveDummy', { dummyId: bots[0]!.id });
    const state = await afterRemove;

    const remaining = state.players.filter((p) => p.isBot);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.id, bots[1]!.id, 'o outro bot devia continuar na sala');
  } finally {
    await stopServer(h);
  }
});

test('fluxo completo: sala -> Jorbot -> comecar -> matchStart -> roundPrep -> snapshots', async () => {
  const h = await startServer();
  try {
    const dono = await connect(h, 'Dono');

    const created = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomCreate', { name: 'Guerra', mapId: 'fabrica' });
    await created;

    const withBot = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomAddDummy');
    const roomWithBot = await withBot;
    assert.equal(roomWithBot.players.length, 2);
    assert.ok(roomWithBot.players.some((p) => p.isBot));

    const startPromise = waitFor<MatchStart>(dono, 'matchStart');
    const prepPromise = waitFor<RoundPrep>(dono, 'roundPrep');
    dono.emit('roomStart');

    const start = await startPromise;
    assert.equal(start.mapId, 'fabrica');
    assert.equal(start.players.length, 2);
    assert.ok(Number.isFinite(start.seed), 'a seed do mapa precisa viajar');

    const prep = await prepPromise;
    assert.equal(prep.round, 1);
    assert.ok(prep.fuel > 0);
    assert.ok('tampinha' in prep.ammo, 'o inventario precisa chegar');

    const snap = await waitFor<Snapshot>(dono, 'snapshot');
    assert.equal(snap.players.length, 2);
    assert.ok(snap.remaining > 0);
  } finally {
    await stopServer(h);
  }
});

test('input mandado pelo socket move o Jorbe de verdade', async () => {
  const h = await startServer();
  try {
    const dono = await connect(h, 'Andarilho');
    const created = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomCreate', { name: 'Andar', mapId: 'praia' });
    await created;

    const withBot = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomAddDummy');
    await withBot;

    const startPromise = waitFor<MatchStart>(dono, 'matchStart');
    dono.emit('roomStart');
    const start = await startPromise;
    const myId = start.players.find((p) => !p.isBot)!.id;

    // Deixa assentar no chao antes de medir.
    await new Promise((r) => setTimeout(r, 1200));
    const before = await waitFor<Snapshot>(dono, 'snapshot');
    const x0 = before.players.find((p) => p.id === myId)!.x;

    for (let seq = 1; seq <= 40; seq++) {
      dono.emit('input', { seq, left: false, right: true, jump: false });
      await new Promise((r) => setTimeout(r, 25));
    }

    const after2 = await waitFor<Snapshot>(dono, 'snapshot');
    const x1 = after2.players.find((p) => p.id === myId)!.x;

    assert.ok(x1 > x0, `deveria ter andado pra direita: ${x0} -> ${x1}`);
    assert.ok(after2.fuel < before.fuel, 'andar precisa gastar combustivel');
  } finally {
    await stopServer(h);
  }
});

test('mira mandada pelo socket vira tiro na resolucao da rodada', async () => {
  const h = await startServer();
  try {
    const dono = await connect(h, 'Atirador');
    const created = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomCreate', { name: 'Tiro', mapId: 'fabrica' });
    await created;

    const withBot = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomAddDummy');
    await withBot;

    const startPromise = waitFor<MatchStart>(dono, 'matchStart');
    dono.emit('roomStart');
    const start = await startPromise;
    const myId = start.players.find((p) => !p.isBot)!.id;

    // Com 2 vivos o preparo dura 15s; damos folga pra resolucao chegar.
    const resolvePromise = waitFor<ResolutionPlan>(dono, 'roundResolve', 45000);
    // 90 graus = reto pra cima: sem componente horizontal, cai perto de onde
    // saiu nao importa o alcance nem onde o jogador nasceu no mapa. Um angulo
    // fixo mirando pro lado (como era antes) podia mandar o tiro pra fora do
    // mapa sem explodir, dependendo de onde o spawn caiu — so piorou depois
    // que o alcance maximo aumentou pra cobrir o mapa inteiro.
    const aim = { angle: 90, power: 50, weaponId: 'bazuca', fire: true };
    dono.emit('aim', aim);
    const resend = (): void => {
      dono.emit('aim', aim);
    };
    dono.on('snapshot', resend);

    const plan = await resolvePromise;
    dono.off('snapshot', resend);

    // O Jorbot da sala tambem atira sozinho antes da rodada resolver -- 2
    // tiros no total (o nosso + o dele), nao so o nosso.
    assert.equal(plan.shots.length, 2, 'a mira precisa ter virado um tiro, alem do tiro do Jorbot');
    const mine = plan.shots.find((s) => s.ownerId === myId);
    assert.ok(mine, 'o tiro do jogador humano precisa estar no plano');
    assert.equal(mine!.weaponId, 'bazuca');
    assert.ok(plan.events.length > 0, 'a resolucao precisa produzir eventos');
    assert.ok(
      plan.events.some((e) => e.kind === 'explosion'),
      'o tiro precisa terminar em explosao',
    );
    assert.equal(plan.finalStates.length, 2);
  } finally {
    await stopServer(h);
  }
});

test('chat chega para todos da sala e o flood e barrado', async () => {
  const h = await startServer();
  try {
    const a = await connect(h, 'Ana');
    const b = await connect(h, 'Bia');

    const created = waitFor<RoomState>(a, 'roomState');
    a.emit('roomCreate', { name: 'Papo', mapId: 'fabrica' });
    const room = await created;

    const joined = waitFor<RoomState>(b, 'roomState');
    b.emit('roomJoin', { roomId: room.id });
    await joined;

    const heard = waitFor<{ from: string; text: string }>(b, 'chat');
    a.emit('chat', { text: 'salve rapaziada' });
    const msg = await heard;
    assert.equal(msg.from, 'Ana');
    assert.equal(msg.text, 'salve rapaziada');

    const flood = waitFor<string>(a, 'errorMsg', 4000);
    for (let i = 0; i < 12; i++) a.emit('chat', { text: `spam ${i}` });
    assert.match(await flood, /calma/i);
  } finally {
    await stopServer(h);
  }
});

test('sair da sala remove o jogador e some do lobby quando esvazia', async () => {
  const h = await startServer();
  try {
    const dono = await connect(h, 'Dono');
    const created = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomCreate', { name: 'Efemera', mapId: 'fabrica' });
    await created;

    const left = waitFor<RoomState | null>(dono, 'roomState');
    const lobbyUpdate = waitFor<{ name: string }[]>(dono, 'rooms');
    dono.emit('roomLeave');

    assert.equal(await left, null);
    const lobby = await lobbyUpdate;
    assert.ok(!lobby.some((r) => r.name === 'Efemera'), 'sala vazia deve sumir do lobby');
  } finally {
    await stopServer(h);
  }
});

test('comandos antes do hello sao recusados', async () => {
  const h = await startServer();
  try {
    const sock = ioc(h.baseUrl, { transports: ['websocket'] });
    h.clients.push(sock);
    await new Promise<void>((resolve) => sock.on('connect', () => resolve()));

    const err = waitFor<string>(sock, 'errorMsg');
    sock.emit('roomCreate', { name: 'Invasao', mapId: 'fabrica' });
    assert.match(await err, /conecte-se/i);
  } finally {
    await stopServer(h);
  }
});

// ---------------------------------------------------------------------------
// Reconexao com tolerancia (queda de rede nao pode custar a vaga na partida)
// ---------------------------------------------------------------------------

test('cai a conexao e reconecta a tempo -- continua na sala e na partida, sem ser eliminado', async () => {
  const h = await startServer(3000); // janela curta so pra nao deixar o teste lento
  try {
    const dono = await connectAndGetId(h, 'Instavel');
    const bot = await connect(h, 'Fiel'); // segunda pessoa so pra sobrar alguem vivo apos a "queda"

    const created = waitFor<RoomState>(dono.sock, 'roomState');
    dono.sock.emit('roomCreate', { name: 'Instavel', mapId: 'fabrica' });
    const room = await created;

    const joined = waitFor<RoomState>(dono.sock, 'roomState');
    bot.emit('roomJoin', { roomId: room.id });
    await joined;

    const started = waitFor<MatchStart>(dono.sock, 'matchStart');
    dono.sock.emit('roomStart');
    await started;

    // Simula a rede caindo: desconecta o socket sem mandar `roomLeave`.
    dono.sock.disconnect();
    await new Promise((r) => setTimeout(r, 400)); // da tempo do servidor processar o 'disconnect'

    // Reconecta com o MESMO cookie (mesma identidade) antes da janela acabar.
    // Os listeners precisam estar plugados ANTES do hello: o servidor manda
    // hello + rooms + roomState + matchStart em rajada (tudo sincrono dentro
    // do handler), entao registrar depois de esperar o hello isolado correria
    // o risco de perder os eventos seguintes.
    const resumed = await connectTransportWithCookie(h, dono.cookie);
    const helloOk = waitFor<{ ok: boolean; reason?: string }>(resumed, 'hello');
    const roomAfter = waitFor<RoomState>(resumed, 'roomState');
    const matchAfter = waitFor<MatchStart>(resumed, 'matchStart');
    resumed.emit('hello', { engineVersion: ENGINE_VERSION });
    assert.equal((await helloOk).ok, true, 'hello de reconexao precisa ser aceito');

    assert.ok((await roomAfter).players.some((p) => p.id === dono.playerId), 'precisa continuar na sala');
    const catchUp = await matchAfter;
    const me = catchUp.players.find((p) => p.id === dono.playerId);
    assert.ok(me, 'a partida precisa mandar o catch-up de volta pro jogador que reconectou');
    assert.ok(me!.hp > 0, 'reconectar a tempo nao pode ter eliminado o jogador');
  } finally {
    await stopServer(h);
  }
});

test('cai a conexao e NAO reconecta a tempo -- e removido de vez, igual a uma desistencia', async () => {
  const h = await startServer(150); // janela bem curta de proposito
  try {
    const dono = await connectAndGetId(h, 'VaiSumir');
    const fiel = await connect(h, 'Fiel');

    const created = waitFor<RoomState>(dono.sock, 'roomState');
    dono.sock.emit('roomCreate', { name: 'VaiSumir', mapId: 'fabrica' });
    const room = await created;

    const joined = waitFor<RoomState>(dono.sock, 'roomState');
    fiel.emit('roomJoin', { roomId: room.id });
    await joined;

    const started = waitFor<MatchStart>(fiel, 'matchStart');
    dono.sock.emit('roomStart');
    await started;

    dono.sock.disconnect();
    // Bem mais que a janela de 150ms — da tempo do timer de remocao estourar.
    await new Promise((r) => setTimeout(r, 600));

    const state = h.rooms.getRoomState(room.id);
    assert.ok(state, 'a sala precisa continuar existindo (ainda tem o Fiel dentro)');
    assert.ok(
      !state!.players.some((p) => p.id === dono.playerId),
      'depois da janela estourar sem reconectar, o jogador precisa ter sido removido de vez -- igual a uma desistencia',
    );
  } finally {
    await stopServer(h);
  }
});

test('sair da sala explicitamente NAO espera a janela de reconexao -- remove na hora', async () => {
  const h = await startServer(60_000); // janela bem longa: se caisse nela, o teste travaria
  try {
    const dono = await connectAndGetId(h, 'SaiDeProposito');

    const created = waitFor<RoomState>(dono.sock, 'roomState');
    dono.sock.emit('roomCreate', { name: 'SaiDeProposito', mapId: 'fabrica' });
    await created;

    const left = waitFor<RoomState | null>(dono.sock, 'roomState');
    dono.sock.emit('roomLeave');
    assert.equal(await left, null);

    // Reconectar (mesmo cookie) sem ter passado por nenhuma janela de espera
    // precisa cair direto no lobby, sem sala nenhuma — a saida foi definitiva.
    const resumed = await reconnectWithCookie(h, dono.cookie);
    const rooms = await new Promise<{ name: string }[]>((resolve) => {
      resumed.once('rooms', resolve);
      resumed.emit('roomList');
    });
    assert.ok(!rooms.some((r) => r.name === 'SaiDeProposito'), 'sala ja devia ter sumido (dono saiu e ela ficou vazia)');
  } finally {
    await stopServer(h);
  }
});

// ---------------------------------------------------------------------------
// Validacao de payload (zod) -- entrada malformada nao pode derrubar o socket
// ---------------------------------------------------------------------------

test('aim malformado nao derruba a conexao nem trava o servidor', async () => {
  const h = await startServer();
  try {
    const dono = await connect(h, 'Bagunceiro');
    const created = waitFor<RoomState>(dono, 'roomState');
    dono.emit('roomCreate', { name: 'Caos', mapId: 'fabrica' });
    await created;
    dono.emit('roomAddDummy');

    const started = waitFor<MatchStart>(dono, 'matchStart');
    dono.emit('roomStart');
    await started;

    // Payloads claramente fora do formato esperado.
    dono.emit('aim', { angle: 'noventa', power: null, weaponId: 42, fire: 'sim' } as never);
    dono.emit('aim', null as never);
    dono.emit('input', { seq: 'um', left: 'talvez' } as never);

    // O socket precisa continuar vivo e respondendo depois do lixo.
    const stillWorks = waitFor<string[]>(dono, 'rooms');
    dono.emit('roomList');
    await stillWorks;
  } finally {
    await stopServer(h);
  }
});
