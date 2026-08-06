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

  constructor() {
    // autoConnect:false e proposital — o handshake HTTP/WS so carrega o
    // cookie de sessao UMA vez, no instante em que a conexao abre. Se o
    // socket conectasse sozinho aqui (antes do login), ficaria preso pra
    // sempre numa conexao sem cookie, e chamar .connect() depois nao faz
    // nada (a conexao ja esta aberta). Por isso quem decide QUANDO abrir e
    // o chamador, depois que o cookie de fato existe.
    this.socket = io('/', { path: '/socket.io', autoConnect: false });
  }

  /** Resolve quando o servidor aceitar (ou recusar) a conexao. */
  connect(): Promise<{ ok: boolean; reason?: string }> {
    return new Promise((resolve) => {
      this.socket.once('hello', (res) => {
        if (res.ok) {
          this.playerId = res.playerId;
          this.nick = res.nick;
        }
        resolve({ ok: res.ok, reason: res.reason });
      });
      const send = (): void => {
        this.socket.emit('hello', { engineVersion: ENGINE_VERSION });
      };
      if (this.socket.connected) send();
      else this.socket.once('connect', send);
    });
  }

  sendInput(msg: InputMessage): void {
    this.socket.emit('input', msg);
  }

  sendAim(msg: AimMessage): void {
    this.socket.emit('aim', msg);
  }
}
