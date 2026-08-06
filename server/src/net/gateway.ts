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

export function createGateway(io: Server): RoomManager {
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

  const rooms = new RoomManager(emitter);
  rooms.start();

  io.on('connection', (socket: Sock) => {
    let authed = false;

    socket.on('hello', (req: HelloRequest) => {
      if (req?.engineVersion !== ENGINE_VERSION) {
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

      rooms.addClient(socket.id, identity.nick, {
        isGuest: identity.guest,
        userId: identity.guest ? null : identity.sub,
      });
      authed = true;

      socket.emit('hello', {
        ok: true,
        playerId: socket.id,
        nick: identity.nick,
        engineVersion: ENGINE_VERSION,
      });
      socket.emit('rooms', rooms.listRooms());
    });

    const guard = (fn: () => void): void => {
      if (!authed) {
        socket.emit('errorMsg', 'Conecte-se antes.');
        return;
      }
      fn();
    };

    socket.on('roomList', () => guard(() => socket.emit('rooms', rooms.listRooms())));

    socket.on('roomCreate', (req) =>
      guard(() => {
        const id = rooms.createRoom(socket.id, sanitizeText(req?.name, 28), req?.mapId ?? 'fabrica');
        if (!id) return;
        socket.join(`room:${id}`);
        socket.emit('roomState', rooms.getRoomState(id));
      }),
    );

    socket.on('roomJoin', (req) =>
      guard(() => {
        const err = rooms.joinRoom(socket.id, String(req?.roomId ?? ''));
        if (err) {
          socket.emit('errorMsg', err);
          return;
        }
        socket.join(`room:${req.roomId}`);
        socket.emit('roomState', rooms.getRoomState(req.roomId));

        // Entrou com a partida rolando: manda o mundo atual pra assistir.
        const engine = rooms.engineOf(socket.id);
        if (engine) socket.emit('matchStart', engine.catchUp());
      }),
    );

    socket.on('roomLeave', () =>
      guard(() => {
        const room = rooms.roomOf(socket.id);
        rooms.leaveRoom(socket.id);
        if (room) socket.leave(`room:${room.id}`);
        socket.emit('roomState', null);
        socket.emit('rooms', rooms.listRooms());
      }),
    );

    socket.on('roomAddDummy', () =>
      guard(() => {
        const err = rooms.addDummy(socket.id);
        if (err) socket.emit('errorMsg', err);
      }),
    );

    socket.on('roomStart', () =>
      guard(() => {
        const err = rooms.startMatch(socket.id);
        if (err) socket.emit('errorMsg', err);
      }),
    );

    socket.on('chat', (req) =>
      guard(() => {
        const room = rooms.roomOf(socket.id);
        const text = sanitizeText(req?.text, 160);
        if (!room || !text) return;
        if (!rooms.allowChat(socket.id)) {
          socket.emit('errorMsg', 'Calma no chat.');
          return;
        }
        io.to(`room:${room.id}`).emit('chat', {
          from: rooms.getClient(socket.id)?.nick ?? '???',
          text,
          at: Date.now(),
        });
      }),
    );

    socket.on('input', (msg: InputMessage) =>
      guard(() => {
        rooms.engineOf(socket.id)?.applyInput(socket.id, msg);
      }),
    );

    socket.on('aim', (msg: AimMessage) =>
      guard(() => {
        rooms.engineOf(socket.id)?.applyAim(socket.id, msg);
      }),
    );

    socket.on('disconnect', () => {
      rooms.removeClient(socket.id);
    });
  });

  return rooms;
}
