import { randomUUID } from 'node:crypto';
import {
  MAPS,
  PREP_TICK_RATE,
  ROOM_MAX_PLAYERS,
  ROOM_MIN_PLAYERS_TO_START,
  getMap,
  type MatchEnd,
  type RoomState,
  type RoomSummary,
} from '@jorbe/shared';
import { MatchEngine, type MatchOutbound, type MatchSink } from './MatchEngine.js';

/**
 * Salas e ciclo de partida, tudo em memoria.
 *
 * Nada disso vai para o Mongo de proposito: sala e estado efemero, e o Atlas
 * free tem orcamento de operacoes limitado. Ao banco vai apenas o RESULTADO
 * da partida, e isso e trabalho da F6.
 *
 * A identidade aqui e um nick temporario. A F1 troca isso por conta de verdade.
 */

export interface Emitter {
  toRoom<K extends keyof MatchOutbound>(roomId: string, event: K, payload: MatchOutbound[K]): void;
  toClient<K extends keyof MatchOutbound>(clientId: string, event: K, payload: MatchOutbound[K]): void;
  roomStateChanged(roomId: string): void;
  lobbyChanged(): void;
}

interface Room {
  id: string;
  name: string;
  mapId: string;
  hostId: string;
  /** Ids de cliente (humanos) e de dummy (placeholder de bot da F5). */
  members: string[];
  dummies: string[];
  engine: MatchEngine | null;
}

export interface ClientIdentity {
  /** null para convidado — convidado nao tem linha na colecao users. */
  userId: string | null;
  isGuest: boolean;
}

interface ClientInfo extends ClientIdentity {
  id: string;
  nick: string;
  roomId: string | null;
  lastChatAt: number;
  chatBudget: number;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly clients = new Map<string, ClientInfo>();
  private readonly emitter: Emitter;
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt = 0;
  /** clientId -> timer de remocao pendente (ver `scheduleDisconnect`). */
  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();
  /** Janela pra reconectar (mesma identidade) antes de contar como desistencia de verdade. */
  private readonly reconnectGraceMs: number;
  private static readonly DEFAULT_RECONNECT_GRACE_MS = 25_000;

  /** `reconnectGraceMs` e ajustavel so pra teste conseguir exercitar o timeout sem esperar 25s de verdade. */
  constructor(emitter: Emitter, reconnectGraceMs = RoomManager.DEFAULT_RECONNECT_GRACE_MS) {
    this.emitter = emitter;
    this.reconnectGraceMs = reconnectGraceMs;
  }

  start(): void {
    if (this.timer) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.tick(), 1000 / PREP_TICK_RATE);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.disconnectTimers.values()) clearTimeout(t);
    this.disconnectTimers.clear();
  }

  private tick(): void {
    const now = Date.now();
    const dtMs = now - this.lastTickAt;
    this.lastTickAt = now;
    // Se o processo travou (debugger, GC longo), nao despeje o atraso todo na
    // fisica de uma vez — isso teleportaria os personagens.
    const clamped = Math.min(dtMs, 250);

    for (const room of this.rooms.values()) {
      if (!room.engine) continue;
      room.engine.update(clamped);
      if (room.engine.isFinished) {
        room.engine = null;
        this.emitter.roomStateChanged(room.id);
        this.emitter.lobbyChanged();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Clientes
  // -------------------------------------------------------------------------

  addClient(id: string, nick: string, identity: ClientIdentity): ClientInfo {
    const info: ClientInfo = {
      id,
      nick,
      roomId: null,
      lastChatAt: 0,
      chatBudget: 5,
      userId: identity.userId,
      isGuest: identity.isGuest,
    };
    this.clients.set(id, info);
    return info;
  }

  getClient(id: string): ClientInfo | undefined {
    return this.clients.get(id);
  }

  removeClient(id: string): void {
    this.cancelPendingDisconnect(id);
    this.leaveRoom(id);
    this.clients.delete(id);
  }

  /**
   * Socket caiu (rede ruim, aba fechada, troca de aba/wifi) — diferente de
   * uma saida explicita (`leaveRoom`, chamada direto por "sair da sala/
   * partida"), isso NAO remove o cliente na hora. Da uma janela pra ele
   * voltar com a mesma identidade (ver `cancelPendingDisconnect`, chamado no
   * hello de reconexao) antes de contar como desistencia de verdade. O
   * cliente continua ocupando a vaga/o corpo na partida o tempo todo — so
   * fica sem receber input nenhum ate reconectar ou a janela estourar.
   */
  scheduleDisconnect(id: string): void {
    if (!this.clients.has(id)) return;
    this.cancelPendingDisconnect(id); // seguranca: nunca dois timers pro mesmo id
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(id);
      this.removeClient(id);
    }, this.reconnectGraceMs);
    // Nunca deve segurar o processo vivo sozinho (ex: um teste que fecha o
    // servidor antes da janela estourar, ou um shutdown normal do servidor).
    timer.unref();
    this.disconnectTimers.set(id, timer);
  }

  /** Reconectou a tempo (mesma identidade) — cancela a remocao pendente. Devolve se havia uma. */
  cancelPendingDisconnect(id: string): boolean {
    const timer = this.disconnectTimers.get(id);
    if (!timer) return false;
    clearTimeout(timer);
    this.disconnectTimers.delete(id);
    return true;
  }

  // -------------------------------------------------------------------------
  // Salas
  // -------------------------------------------------------------------------

  listRooms(): RoomSummary[] {
    return [...this.rooms.values()].map((r) => ({
      id: r.id,
      name: r.name,
      players: r.members.length + r.dummies.length,
      maxPlayers: ROOM_MAX_PLAYERS,
      inMatch: r.engine !== null,
    }));
  }

  getRoomState(roomId: string): RoomState | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return {
      id: room.id,
      name: room.name,
      mapId: room.mapId,
      maxPlayers: ROOM_MAX_PLAYERS,
      hostId: room.hostId,
      inMatch: room.engine !== null,
      players: [
        ...room.members.map((id) => ({
          id,
          nick: this.clients.get(id)?.nick ?? '???',
          isHost: id === room.hostId,
          isBot: false,
          isGuest: this.clients.get(id)?.isGuest ?? false,
        })),
        ...room.dummies.map((id, i) => ({
          id,
          nick: `Jorbot ${i + 1}`,
          isHost: false,
          isBot: true,
          isGuest: false,
        })),
      ],
    };
  }

  createRoom(clientId: string, name: string, mapId: string): string | null {
    const client = this.clients.get(clientId);
    if (!client) return null;
    this.leaveRoom(clientId);

    const id = randomUUID().slice(0, 8);
    const clean = name.trim().slice(0, 28) || `Sala do ${client.nick}`;
    const room: Room = {
      id,
      name: clean,
      mapId: getMap(mapId).id,
      hostId: clientId,
      members: [clientId],
      dummies: [],
      engine: null,
    };
    this.rooms.set(id, room);
    client.roomId = id;

    this.emitter.lobbyChanged();
    this.emitter.roomStateChanged(id);
    return id;
  }

  joinRoom(clientId: string, roomId: string): string | null {
    const client = this.clients.get(clientId);
    const room = this.rooms.get(roomId);
    if (!client) return 'Cliente desconhecido.';
    if (!room) return 'Essa sala nao existe mais.';
    if (room.engine) return 'A partida ja comecou.';
    if (room.members.length + room.dummies.length >= ROOM_MAX_PLAYERS) return 'Sala cheia.';
    if (room.members.includes(clientId)) return null;

    this.leaveRoom(clientId);
    room.members.push(clientId);
    client.roomId = roomId;

    this.emitter.lobbyChanged();
    this.emitter.roomStateChanged(roomId);
    return null;
  }

  leaveRoom(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client?.roomId) return;
    const room = this.rooms.get(client.roomId);
    client.roomId = null;
    if (!room) return;

    room.members = room.members.filter((m) => m !== clientId);
    room.engine?.removePlayer(clientId);

    if (room.members.length === 0) {
      this.rooms.delete(room.id);
    } else if (room.hostId === clientId) {
      room.hostId = room.members[0];
    }

    this.emitter.lobbyChanged();
    this.emitter.roomStateChanged(room.id);
  }

  /**
   * Enche a sala com adversarios de teste. E um PLACEHOLDER da F5: o dummy
   * fica parado e nao atira, servindo so para dar com quem testar a rodada
   * simultanea sem precisar de 15 navegadores abertos.
   */
  addDummy(clientId: string): string | null {
    const room = this.roomOf(clientId);
    if (!room) return 'Voce nao esta em uma sala.';
    if (room.hostId !== clientId) return 'So o dono da sala pode adicionar Jorbots.';
    if (room.engine) return 'A partida ja comecou.';
    if (room.members.length + room.dummies.length >= ROOM_MAX_PLAYERS) return 'Sala cheia.';

    room.dummies.push(`bot-${randomUUID().slice(0, 6)}`);
    this.emitter.lobbyChanged();
    this.emitter.roomStateChanged(room.id);
    return null;
  }

  /** Remove um Jorbot especifico da sala (o dono decide qual, nao so o ultimo). */
  removeDummy(clientId: string, dummyId: string): string | null {
    const room = this.roomOf(clientId);
    if (!room) return 'Voce nao esta em uma sala.';
    if (room.hostId !== clientId) return 'So o dono da sala pode remover Jorbots.';
    if (room.engine) return 'A partida ja comecou.';

    const before = room.dummies.length;
    room.dummies = room.dummies.filter((id) => id !== dummyId);
    if (room.dummies.length === before) return 'Esse Jorbot nao existe mais.';

    this.emitter.lobbyChanged();
    this.emitter.roomStateChanged(room.id);
    return null;
  }

  /** Troca a fase (mapa) da sala antes da partida comecar. */
  setMap(clientId: string, mapId: string): string | null {
    const room = this.roomOf(clientId);
    if (!room) return 'Voce nao esta em uma sala.';
    if (room.hostId !== clientId) return 'So o dono da sala pode trocar a fase.';
    if (room.engine) return 'A partida ja comecou.';

    room.mapId = getMap(mapId).id;
    this.emitter.lobbyChanged();
    this.emitter.roomStateChanged(room.id);
    return null;
  }

  startMatch(clientId: string): string | null {
    const room = this.roomOf(clientId);
    if (!room) return 'Voce nao esta em uma sala.';
    if (room.hostId !== clientId) return 'So o dono da sala pode comecar.';
    if (room.engine) return 'A partida ja comecou.';

    const total = room.members.length + room.dummies.length;
    if (total < ROOM_MIN_PLAYERS_TO_START) {
      return `Precisa de pelo menos ${ROOM_MIN_PLAYERS_TO_START} para comecar.`;
    }

    const seeds = [
      ...room.members.map((id) => ({ id, nick: this.clients.get(id)?.nick ?? '???', isBot: false })),
      ...room.dummies.map((id, i) => ({ id, nick: `Jorbot ${i + 1}`, isBot: true })),
    ];

    const roomId = room.id;
    const sink: MatchSink = {
      toAll: (event, payload) => this.emitter.toRoom(roomId, event, payload),
      toPlayer: (id, event, payload) => this.emitter.toClient(id, event, payload),
      onFinished: (_result: MatchEnd) => {
        const r = this.rooms.get(roomId);
        if (r) r.dummies = [];
      },
    };

    const seed = (Math.random() * 0x7fffffff) | 0;
    room.engine = new MatchEngine(room.mapId, seed, seeds, sink);
    room.engine.start();

    this.emitter.lobbyChanged();
    this.emitter.roomStateChanged(room.id);
    return null;
  }

  engineOf(clientId: string): MatchEngine | null {
    return this.roomOf(clientId)?.engine ?? null;
  }

  roomOf(clientId: string): Room | null {
    const roomId = this.clients.get(clientId)?.roomId;
    if (!roomId) return null;
    return this.rooms.get(roomId) ?? null;
  }

  /** Anti-flood simples: 5 mensagens de credito, recuperando 1 por segundo. */
  allowChat(clientId: string): boolean {
    const c = this.clients.get(clientId);
    if (!c) return false;
    const now = Date.now();
    const recovered = (now - c.lastChatAt) / 1000;
    c.chatBudget = Math.min(5, c.chatBudget + recovered);
    c.lastChatAt = now;
    if (c.chatBudget < 1) return false;
    c.chatBudget -= 1;
    return true;
  }

  static get maps(): typeof MAPS {
    return MAPS;
  }
}
