import type { Server, Socket } from 'socket.io';
import {
  ACCESS_COOKIE,
  ENGINE_VERSION,
  type ClientToServerEvents,
  type HelloRequest,
  type InputMessage,
  type AimMessage,
  type ServerToClientEvents,
} from '@jorbe/shared';
import { verifyAccessToken, type AccessTokenPayload } from '../auth/tokens.js';
import { RoomManager, type Emitter } from '../match/RoomManager.js';
import {
  aimSchema,
  chatSchema,
  helloSchema,
  inputSchema,
  roomCreateSchema,
  roomJoinSchema,
  roomRemoveDummySchema,
  roomSetMapSchema,
} from './validation.js';

type Sock = Socket<ClientToServerEvents, ServerToClientEvents>;

function sanitizeText(raw: unknown, max: number): string {
  const text = typeof raw === 'string' ? raw : '';
  return text.replace(/[<>&"'`]/g, '').trim().slice(0, max);
}

/** So extrai o valor de um cookie especifico — nao ha necessidade de um parser completo. */
function readCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * A identidade nunca vem do payload que o cliente manda por socket — so do
 * cookie httpOnly assinado pelo servidor no login/cadastro/convidado. Isso
 * fecha a porta que existia ate a F1: antes, qualquer um podia abrir o
 * DevTools e se conectar com o nick que quisesse.
 */
function identityFromSocket(socket: Sock): AccessTokenPayload | null {
  const raw = socket.handshake.headers.cookie;
  if (!raw) return null;
  const token = readCookie(raw, ACCESS_COOKIE);
  if (!token) return null;
  return verifyAccessToken(token);
}

export function createGateway(io: Server, reconnectGraceMs?: number): RoomManager {
  const emitter: Emitter = {
    toRoom: (roomId, event, payload) => {
      io.to(`room:${roomId}`).emit(event as string, payload);
    },
    toClient: (clientId, event, payload) => {
      io.to(clientId).emit(event as string, payload);
    },
    roomStateChanged: (roomId) => {
      const state = rooms.getRoomState(roomId);
      io.to(`room:${roomId}`).emit('roomState', state);
    },
    lobbyChanged: () => {
      io.emit('rooms', rooms.listRooms());
    },
  };

  const rooms = new RoomManager(emitter, reconnectGraceMs);
  rooms.start();

  io.on('connection', (socket: Sock) => {
    let authed = false;
    // Id ESTAVEL do jogador (o `sub` do token, nao o `socket.id` da conexao
    // de transporte) -- sobrevive a queda e reconexao da rede, o que socket.id
    // nunca faria. `RoomManager`/`MatchEngine` inteiros sao indexados por
    // isso, entao uma reconexao dentro da janela de tolerancia (ver
    // `RoomManager.scheduleDisconnect`) simplesmente "continua de onde parou"
    // sem precisar renomear nada.
    let playerId = '';

    /** Blindagem contra payload malformado ou bug no handler: nunca deixa a excecao subir e derrubar a conexao (ou o processo) de todo mundo na sala. */
    const safely = (fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        console.error('[gateway] erro tratando evento de socket:', err);
        socket.emit('errorMsg', 'Erro interno — tente de novo.');
      }
    };

    socket.on('hello', (req: HelloRequest) =>
      safely(() => {
        const parsed = helloSchema.safeParse(req);
        if (!parsed.success || parsed.data.engineVersion !== ENGINE_VERSION) {
          socket.emit('hello', {
            ok: false,
            playerId: '',
            nick: '',
            engineVersion: ENGINE_VERSION,
            reason: 'Versao do jogo desatualizada — recarregue a pagina.',
          });
          socket.disconnect(true);
          return;
        }

        const identity = identityFromSocket(socket);
        if (!identity) {
          socket.emit('hello', {
            ok: false,
            playerId: '',
            nick: '',
            engineVersion: ENGINE_VERSION,
            reason: 'Faca login antes de entrar.',
          });
          socket.disconnect(true);
          return;
        }

        playerId = identity.sub;
        authed = true;
        // Sala pessoal nomeada com o id estavel -- e o que faz `toClient`
        // (io.to(playerId)) alcancar este socket mesmo depois de uma
        // reconexao trocar o `socket.id` por baixo dos panos.
        void socket.join(playerId);

        const reconnected = rooms.cancelPendingDisconnect(playerId);
        if (!reconnected) {
          rooms.addClient(playerId, identity.nick, {
            isGuest: identity.guest,
            userId: identity.guest ? null : identity.sub,
          });
        }

        socket.emit('hello', {
          ok: true,
          playerId,
          nick: identity.nick,
          engineVersion: ENGINE_VERSION,
        });
        socket.emit('rooms', rooms.listRooms());

        // Reencaixa o socket novo na sala/partida que ja estava rolando (se
        // a janela de reconexao ainda tiver essa vaga guardada) e manda o
        // estado atual pra tela voltar sozinha, sem o jogador precisar fazer
        // nada. SEMPRE manda `roomState` aqui (mesmo null) — se a janela
        // estourou antes de reconectar, o cliente pode estar com uma sala
        // "fantasma" guardada de antes da queda, e so um roomState explicito
        // (nem que seja null) corrige a tela.
        const room = rooms.roomOf(playerId);
        if (room) void socket.join(`room:${room.id}`);
        socket.emit('roomState', room ? rooms.getRoomState(room.id) : null);
        if (room) {
          const engine = rooms.engineOf(playerId);
          if (engine) socket.emit('matchStart', engine.catchUp());
        }
      }),
    );

    const guard = (fn: () => void): void => {
      if (!authed) {
        socket.emit('errorMsg', 'Conecte-se antes.');
        return;
      }
      safely(fn);
    };

    socket.on('roomList', () => guard(() => socket.emit('rooms', rooms.listRooms())));

    socket.on('roomCreate', (req) =>
      guard(() => {
        const parsed = roomCreateSchema.safeParse(req);
        const name = sanitizeText(parsed.success ? parsed.data.name : '', 28);
        const mapId = parsed.success ? parsed.data.mapId : 'fabrica';
        const id = rooms.createRoom(playerId, name, mapId);
        if (!id) return;
        void socket.join(`room:${id}`);
        socket.emit('roomState', rooms.getRoomState(id));
      }),
    );

    socket.on('roomJoin', (req) =>
      guard(() => {
        const parsed = roomJoinSchema.safeParse(req);
        if (!parsed.success) {
          socket.emit('errorMsg', 'Sala invalida.');
          return;
        }
        const err = rooms.joinRoom(playerId, parsed.data.roomId);
        if (err) {
          socket.emit('errorMsg', err);
          return;
        }
        void socket.join(`room:${parsed.data.roomId}`);
        socket.emit('roomState', rooms.getRoomState(parsed.data.roomId));

        // Entrou com a partida rolando: manda o mundo atual pra assistir.
        const engine = rooms.engineOf(playerId);
        if (engine) socket.emit('matchStart', engine.catchUp());
      }),
    );

    socket.on('roomLeave', () =>
      guard(() => {
        const room = rooms.roomOf(playerId);
        rooms.leaveRoom(playerId);
        if (room) void socket.leave(`room:${room.id}`);
        socket.emit('roomState', null);
        socket.emit('rooms', rooms.listRooms());
      }),
    );

    socket.on('roomAddDummy', () =>
      guard(() => {
        const err = rooms.addDummy(playerId);
        if (err) socket.emit('errorMsg', err);
      }),
    );

    socket.on('roomRemoveDummy', (req) =>
      guard(() => {
        const parsed = roomRemoveDummySchema.safeParse(req);
        if (!parsed.success) {
          socket.emit('errorMsg', 'Jorbot invalido.');
          return;
        }
        const err = rooms.removeDummy(playerId, parsed.data.dummyId);
        if (err) socket.emit('errorMsg', err);
      }),
    );

    socket.on('roomSetMap', (req) =>
      guard(() => {
        const parsed = roomSetMapSchema.safeParse(req);
        if (!parsed.success) {
          socket.emit('errorMsg', 'Mapa invalido.');
          return;
        }
        const err = rooms.setMap(playerId, parsed.data.mapId);
        if (err) socket.emit('errorMsg', err);
      }),
    );

    socket.on('roomStart', () =>
      guard(() => {
        const err = rooms.startMatch(playerId);
        if (err) socket.emit('errorMsg', err);
      }),
    );

    socket.on('chat', (req) =>
      guard(() => {
        const parsed = chatSchema.safeParse(req);
        const room = rooms.roomOf(playerId);
        const text = sanitizeText(parsed.success ? parsed.data.text : '', 160);
        if (!room || !text) return;
        if (!rooms.allowChat(playerId)) {
          socket.emit('errorMsg', 'Calma no chat.');
          return;
        }
        io.to(`room:${room.id}`).emit('chat', {
          from: rooms.getClient(playerId)?.nick ?? '???',
          text,
          at: Date.now(),
        });
      }),
    );

    socket.on('input', (msg: InputMessage) =>
      guard(() => {
        const parsed = inputSchema.safeParse(msg);
        if (!parsed.success) return;
        rooms.engineOf(playerId)?.applyInput(playerId, parsed.data);
      }),
    );

    socket.on('aim', (msg: AimMessage) =>
      guard(() => {
        const parsed = aimSchema.safeParse(msg);
        if (!parsed.success) return;
        rooms.engineOf(playerId)?.applyAim(playerId, parsed.data);
      }),
    );

    socket.on('disconnect', () => {
      if (!authed) return;
      // Nao remove na hora: uma queda de rede passageira nao pode custar a
      // vaga na partida. `scheduleDisconnect` da uma janela de tolerancia —
      // se um novo socket mandar hello com a MESMA identidade antes dela
      // acabar (ver acima), o cancelamento devolve tudo como estava.
      rooms.scheduleDisconnect(playerId);
    });
  });

  return rooms;
}
