import { io, type Socket } from 'socket.io-client';
import {
  ENGINE_VERSION,
  type AimMessage,
  type ClientToServerEvents,
  type InputMessage,
  type ServerToClientEvents,
} from '@jorbe/shared';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Conexao unica com o servidor. A identidade nunca viaja aqui — o navegador
 * ja manda o cookie httpOnly sozinho por ser a mesma origem, e o servidor
 * verifica esse cookie antes de aceitar o hello.
 */
export class Net {
  readonly socket: GameSocket;
  playerId = '';
  nick = '';
  /**
   * Chamado toda vez que uma RECONEXAO (nao a conexao inicial) e aceita —
   * ex: rede caiu e voltou, socket.io reconectou sozinho por baixo dos
   * panos. Quem usa isso (main.ts) esconde o aviso de "reconectando" — o
   * resto do estado (sala/partida) se resincroniza sozinho, porque o
   * servidor reenvia `roomState`/`matchStart` de catch-up nesse mesmo hello.
   */
  onReconnected: (() => void) | null = null;
  private everConnected = false;

  constructor() {
    // autoConnect:false e proposital — o handshake HTTP/WS so carrega o
    // cookie de sessao UMA vez, no instante em que a conexao abre. Se o
    // socket conectasse sozinho aqui (antes do login), ficaria preso pra
    // sempre numa conexao sem cookie, e chamar .connect() depois nao faz
    // nada (a conexao ja esta aberta). Por isso quem decide QUANDO abrir e
    // o chamador, depois que o cookie de fato existe.
    this.socket = io('/', { path: '/socket.io', autoConnect: false });

    // Sempre que o TRANSPORTE conecta -- a primeira vez OU depois de uma
    // queda (o socket.io reconecta sozinho por padrao) -- manda hello de
    // novo. O cookie de sessao viaja no handshake HTTP, entao o servidor
    // sempre sabe quem e mesmo com o socket.id trocado, e devolve o mesmo
    // `playerId` estavel de antes (ver `identity.sub` no gateway).
    this.socket.on('connect', () => {
      this.socket.emit('hello', { engineVersion: ENGINE_VERSION });
    });
    this.socket.on('hello', (res) => {
      if (!res.ok) return;
      this.playerId = res.playerId;
      this.nick = res.nick;
      if (this.everConnected) this.onReconnected?.();
      this.everConnected = true;
    });
  }

  /** Resolve quando o servidor aceitar (ou recusar) a PRIMEIRA conexao. */
  connect(): Promise<{ ok: boolean; reason?: string }> {
    return new Promise((resolve) => {
      this.socket.once('hello', (res) => resolve({ ok: res.ok, reason: res.reason }));
      if (this.socket.connected) this.socket.emit('hello', { engineVersion: ENGINE_VERSION });
    });
  }

  sendInput(msg: InputMessage): void {
    this.socket.emit('input', msg);
  }

  sendAim(msg: AimMessage): void {
    this.socket.emit('aim', msg);
  }
}
