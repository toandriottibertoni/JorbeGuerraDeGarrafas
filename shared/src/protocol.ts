import type { SimEvent } from './physics.js';

/**
 * Contrato de rede entre cliente e servidor.
 *
 * Principio: o cliente manda INTENCAO ("quero andar pra direita", "miro em tal
 * angulo") e recebe FATO. Ele nunca informa posicao, dano ou morte — isso e
 * decidido no servidor. Assim nao ha o que trapacear pelo DevTools.
 */

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

export interface RoomSummary {
  id: string;
  name: string;
  players: number;
  maxPlayers: number;
  inMatch: boolean;
}

export interface RoomPlayer {
  id: string;
  nick: string;
  isHost: boolean;
  isBot: boolean;
  isGuest: boolean;
}

export interface RoomState {
  id: string;
  name: string;
  mapId: string;
  maxPlayers: number;
  hostId: string;
  players: RoomPlayer[];
  inMatch: boolean;
}

// ---------------------------------------------------------------------------
// Partida
// ---------------------------------------------------------------------------

export type Phase = 'prep' | 'resolve' | 'interval' | 'over';

export interface MatchPlayerInit {
  id: string;
  nick: string;
  isBot: boolean;
  x: number;
  y: number;
  hp: number;
}

export interface MatchStart {
  mapId: string;
  seed: number;
  players: MatchPlayerInit[];
  /** Crateras ja abertas — preenchido para quem entra como espectador no meio. */
  carves: { x: number; y: number; r: number }[];
}

export interface RoundPrep {
  round: number;
  /** Duracao da fase de preparo, em segundos. */
  seconds: number;
  /** Vento da rodada em px/s^2; positivo empurra pra direita. */
  wind: number;
  fuel: number;
  /** Municao de cada arma do jogador que recebe (null = infinita). */
  ammo: Record<string, number | null>;
}

/** Estado publico de um Jorbe. Mira NAO entra aqui: e segredo ate o disparo. */
export interface PlayerSnapshot {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  onGround: boolean;
  facing: 1 | -1;
  hp: number;
  alive: boolean;
}

export interface Snapshot {
  /** Momento do servidor, em ms desde o inicio da fase. */
  t: number;
  /** Ultimo input do destinatario que o servidor processou (reconciliacao). */
  ackSeq: number;
  /** Combustivel restante do destinatario. */
  fuel: number;
  players: PlayerSnapshot[];
  /** Segundos restantes da fase de preparo. */
  remaining: number;
}

export interface ShotInit {
  id: number;
  ownerId: string;
  weaponId: string;
  x: number;
  y: number;
  /** Velocidade inicial ja resolvida pelo servidor — o cliente nunca recalcula
   *  a partir do angulo, para nao depender de Math.cos/sin do motor dele. */
  vx: number;
  vy: number;
}

/**
 * Tudo que o cliente precisa para reproduzir a resolucao da rodada.
 * O cliente re-simula localmente so para desenhar movimento suave, mas os
 * `events` do servidor sao a verdade: cada explosao e um ponto de sincronia
 * rigido, entao qualquer divergencia numerica morre em milissegundos.
 */
export interface ResolutionPlan {
  round: number;
  wind: number;
  shots: ShotInit[];
  events: SimEvent[];
  totalTicks: number;
  finalStates: PlayerSnapshot[];
}

export interface RoundEnd {
  round: number;
  alive: string[];
}

export interface MatchEnd {
  /** Ordem inversa de eliminacao: primeiro da lista e o campeao. */
  placements: { id: string; nick: string; placement: number }[];
}

// ---------------------------------------------------------------------------
// Eventos Socket.IO
// ---------------------------------------------------------------------------

/** A identidade nao viaja aqui — ela vem do cookie httpOnly emitido no login/cadastro/convidado. */
export interface HelloRequest {
  engineVersion: number;
}

export interface HelloResponse {
  ok: boolean;
  playerId: string;
  nick: string;
  engineVersion: number;
  reason?: string;
}

export interface InputMessage {
  seq: number;
  left: boolean;
  right: boolean;
  jump: boolean;
}

export interface AimMessage {
  /** Graus, 0 = direita, sentido anti-horario. */
  angle: number;
  /** 5 a 100. */
  power: number;
  weaponId: string;
  /** false = passa a vez sem atirar. */
  fire: boolean;
}

/**
 * Quem ja travou o tiro nesta rodada — so o "pronto", nunca o que cada um
 * mirou. Transmitido pra sala inteira toda vez que alguem trava ou destrava.
 */
export interface ReadyState {
  ready: string[];
}

export interface ServerToClientEvents {
  hello: (res: HelloResponse) => void;
  rooms: (rooms: RoomSummary[]) => void;
  roomState: (state: RoomState | null) => void;
  chat: (msg: { from: string; text: string; at: number }) => void;
  matchStart: (data: MatchStart) => void;
  roundPrep: (data: RoundPrep) => void;
  snapshot: (data: Snapshot) => void;
  roundReady: (data: ReadyState) => void;
  roundResolve: (plan: ResolutionPlan) => void;
  roundEnd: (data: RoundEnd) => void;
  matchEnd: (data: MatchEnd) => void;
  errorMsg: (msg: string) => void;
}

export interface ClientToServerEvents {
  hello: (req: HelloRequest) => void;
  roomList: () => void;
  roomCreate: (req: { name: string; mapId: string }) => void;
  roomJoin: (req: { roomId: string }) => void;
  roomLeave: () => void;
  roomStart: () => void;
  roomAddDummy: () => void;
  chat: (req: { text: string }) => void;
  input: (msg: InputMessage) => void;
  aim: (msg: AimMessage) => void;
}
