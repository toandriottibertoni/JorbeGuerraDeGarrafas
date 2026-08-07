import {
  GRAVITY,
  JORBE_FUEL_PER_ROUND,
  JORBE_HEIGHT,
  JORBE_MAX_HP,
  MAP_HEIGHT,
  MAP_WIDTH,
  MAX_POWER,
  MIN_POWER,
  NO_INPUT,
  POWER_TO_SPEED,
  PREP_DT,
  TICK_DT,
  Terrain,
  WEAPONS,
  WIND_MAX,
  getWeapon,
  stepCharacter,
  type CharState,
  type CrateDef,
  type CratePicked,
  type MatchEnd,
  type MatchStart,
  type MoveInput,
  type PlayerStat,
  type ReadyState,
  type ResolutionPlan,
  type RoundPrep,
  type SimEvent,
  type Snapshot,
} from '@jorbe/shared';
import {
  Camera,
  FloatingTexts,
  IDLE_ANIM,
  INK,
  PALETTE,
  Particles,
  Shockwaves,
  Spring,
  TerrainRenderer,
  drawCrate,
  drawFilmOverlay,
  drawJorbe,
  drawMinimap,
  drawShieldAura,
  drawSky,
  drawWeaponIcon,
  drawWindIndicator,
  type JorbeAnim,
} from './render.js';
import * as sfx from './audio.js';
import type { Net } from './net.js';

interface AnimRig {
  walkPhase: number;
  walkAmp: number;
  squash: Spring;
  recoilX: Spring;
  recoilY: Spring;
  hitFlash: number;
  wasOnGround: boolean;
  prevHp: number;
  /** Fase propria da respiracao parada — sem isso todo mundo respiraria em sincronia. */
  idleOffset: number;
}

/** Hash bem simples so pra espalhar a fase de respiracao entre os jogadores. */
function idOffset(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1000;
  return (h / 1000) * Math.PI * 2;
}

function freshRig(hp: number, playerId: string): AnimRig {
  return {
    walkPhase: 0,
    walkAmp: 0,
    squash: new Spring(1, 300, 14),
    recoilX: new Spring(0, 240, 16),
    recoilY: new Spring(0, 240, 16),
    hitFlash: 0,
    wasOnGround: true,
    prevHp: hp,
    idleOffset: idOffset(playerId),
  };
}

interface RemotePlayer extends CharState {
  nick: string;
  isBot: boolean;
  /** Alvo vindo do servidor, para suavizar o movimento dos outros. */
  targetX: number;
  targetY: number;
  rig: AnimRig;
}

interface PlaybackProjectile {
  id: number;
  weaponId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  squash: Spring;
  smokeAcc: number;
}

interface Playback {
  plan: ResolutionPlan;
  tick: number;
  eventIdx: number;
  projectiles: Map<number, PlaybackProjectile>;
  lastBoom: { x: number; y: number } | null;
  /** Id do proprio tiro nesta rodada (se atirou) — pra registrar o rastro. */
  selfShotId: number | null;
  selfTrail: { x: number; y: number }[];
}

const CHARGE_PER_SECOND = 70;
const ANGLE_PER_SECOND = 55;
const WALK_CYCLE_SPEED = 9;
const WEAPON_WEIGHT: Record<string, 'light' | 'medium' | 'heavy'> = {
  tampinha: 'light',
  bazuca: 'heavy',
  granada: 'medium',
};

/**
 * Tela de partida.
 *
 * Durante o PREPARO o cliente prediz o proprio movimento e reconcilia com os
 * snapshots do servidor. Durante a RESOLUCAO ele nao detecta colisao nenhuma:
 * integra os projeteis de forma balistica e aplica o log de eventos do
 * servidor tick a tick, o que torna divergencia impossivel por construcao.
 *
 * Toda a "plasticidade" (balanco ao andar, esprime no pouso, coice do tiro,
 * quique da granada) e cosmetica pura: le o estado autoritativo e anima em
 * cima dele, nunca influencia a simulacao.
 */
export class MatchScene {
  /** Abaixo disso a HUD nao cabe numa linha so — empilha em varias. */
  /** 4 cartas de arma (156px + espaco) num layout de linha unica precisam de mais largura que 3. */
  private static readonly HUD_COMPACT_BREAKPOINT = 1100;
  private static readonly FIRED_BEFORE_KEY = 'jorbe_fired_before';

  /** localStorage pode estar bloqueado (modo privado, iframe restrito) — nesse caso so mostra o tutorial sempre. */
  private static readNeverFired(): boolean {
    try {
      return !localStorage.getItem(MatchScene.FIRED_BEFORE_KEY);
    } catch {
      return true;
    }
  }

  private static markFired(): void {
    try {
      localStorage.setItem(MatchScene.FIRED_BEFORE_KEY, '1');
    } catch {
      // Sem storage disponivel — sem problema, so volta a mostrar na proxima vez.
    }
  }

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cam = new Camera();
  private readonly particles = new Particles();
  private readonly shockwaves = new Shockwaves();
  private readonly floatingTexts = new FloatingTexts();
  private readonly net: Net;

  private terrain: Terrain | null = null;
  private terrainRenderer: TerrainRenderer | null = null;
  private players = new Map<string, RemotePlayer>();
  private ownId = '';

  private phase: 'loading' | 'prep' | 'resolve' | 'interval' | 'over' = 'loading';
  private round = 0;
  private wind = 0;
  private remaining = 0;
  private fuel = JORBE_FUEL_PER_ROUND;
  private ammo: Record<string, number | null> = {};

  private aimAngle = 45;
  private power = 0;
  private charging = false;
  private aimLocked = false;
  private weaponIdx = 0;
  /** Escudo e um toggle independente da arma selecionada — pode atirar normal e ainda ficar protegido. */
  private shieldArmed = false;

  private keys = new Set<string>();
  private inputSeq = 0;
  private inputAcc = 0;
  private pending: { seq: number; input: MoveInput }[] = [];
  private wasJumpKeyDown = false;
  private stepArmed = false;
  private readyIds = new Set<string>();
  private lastTickSecond = -1;
  private tickPulse = 0;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly leaveBtn: HTMLButtonElement;
  private readonly readyBtn: HTMLButtonElement;
  private readonly chatBox: HTMLDivElement;
  private readonly chatToggleBtn: HTMLButtonElement;
  private readonly chatLogEl: HTMLDivElement;
  private readonly chatInputEl: HTMLInputElement;
  private chatOpen = false;
  private chatUnread = 0;
  /** O que valia na rodada anterior — vento, e meu ultimo angulo/forca ajustados. */
  private history: { wind: number; angle: number; power: number } | null = null;
  private crates: CrateDef[] = [];
  /** Quando (em this.clock) cada engradado apareceu — o paraquedas some pouco depois. */
  private crateSpawnClock = new Map<number, number>();
  /** Dano/abates acumulados da partida inteira, por jogador — pro painel flutuante. */
  private stats = new Map<string, { damage: number; kills: number }>();
  /** Trajeto real do proprio ultimo tiro — desenhado tracejado enquanto mira o proximo. */
  private lastShotTrail: { x: number; y: number }[] | null = null;
  /** So true ate o jogador atirar pela primeira vez neste navegador — ensina a atirar. */
  private showFireTutorial = MatchScene.readNeverFired();
  /** Quem ativou o escudo nesta rodada — desenha a aura ate a proxima rodada comecar. */
  private shielded = new Set<string>();
  /** Ultima mensagem de chat de cada jogador, com prazo — balaozinho no mundo, estilo RPG. */
  private chatBubbles = new Map<string, { text: string; until: number }>();

  private playback: Playback | null = null;
  private playAcc = 0;

  /** Jogador arrastou a camera manualmente — nenhum auto-follow (tiro ou proprio Jorbe) reassume ate soltar (C) ou nova rodada. */
  private cameraManualHold = false;
  private dragging = false;
  private lastPointer: { x: number; y: number } | null = null;
  private forceDragging = false;
  private aimDragging = false;
  /** Ponta do arraste de mira, em coordenadas de tela — pra desenhar o estilingue. */
  private dragPointer: { x: number; y: number } | null = null;

  private banner = '';
  private bannerUntil = 0;
  private finalResult: MatchEnd | null = null;
  private lastFrame = 0;
  private clock = 0;
  private running = false;
  private onExit: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, net: Net) {
    this.canvas = canvas;
    this.net = net;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D indisponivel neste navegador.');
    this.ctx = ctx;

    // Botao real de DOM, no espirito do botao de mudo — mais simples e mais
    // acessivel do que hit-testing dentro do canvas.
    this.cancelBtn = document.createElement('button');
    this.cancelBtn.id = 'cancelAimBtn';
    this.cancelBtn.className = 'ghost';
    this.cancelBtn.textContent = 'Cancelar tiro';
    this.cancelBtn.style.display = 'none';
    this.cancelBtn.onclick = () => {
      sfx.sfxUiClick();
      this.cancelAim();
    };
    document.body.appendChild(this.cancelBtn);

    this.leaveBtn = document.createElement('button');
    this.leaveBtn.id = 'leaveMatchBtn';
    this.leaveBtn.className = 'ghost';
    this.leaveBtn.textContent = 'Sair da partida';
    this.leaveBtn.style.display = 'none';
    this.leaveBtn.onclick = () => {
      sfx.sfxUiClick();
      this.net.socket.emit('roomLeave');
    };
    document.body.appendChild(this.leaveBtn);

    this.readyBtn = document.createElement('button');
    this.readyBtn.id = 'readyBtn';
    this.readyBtn.textContent = 'OK — travar tiro';
    this.readyBtn.style.display = 'none';
    this.readyBtn.onclick = () => {
      sfx.sfxUiClick();
      this.fire();
    };
    document.body.appendChild(this.readyBtn);

    // Chat da partida — recolhido por padrao pra nao atrapalhar o jogo, com
    // aviso de mensagem nao lida no botao enquanto fechado.
    this.chatBox = document.createElement('div');
    this.chatBox.id = 'matchChat';
    this.chatBox.style.display = 'none';

    this.chatToggleBtn = document.createElement('button');
    this.chatToggleBtn.id = 'matchChatToggle';
    this.chatToggleBtn.className = 'ghost';
    this.chatToggleBtn.textContent = 'Chat';
    this.chatToggleBtn.onclick = () => {
      sfx.sfxUiClick();
      this.setChatOpen(!this.chatOpen);
    };
    this.chatBox.appendChild(this.chatToggleBtn);

    const chatPanel = document.createElement('div');
    chatPanel.id = 'matchChatPanel';

    this.chatLogEl = document.createElement('div');
    this.chatLogEl.id = 'matchChatLog';
    chatPanel.appendChild(this.chatLogEl);

    const chatRow = document.createElement('div');
    chatRow.id = 'matchChatRow';
    this.chatInputEl = document.createElement('input');
    this.chatInputEl.id = 'matchChatInput';
    this.chatInputEl.maxLength = 160;
    this.chatInputEl.placeholder = 'Falar com a sala...';
    this.chatInputEl.autocomplete = 'off';
    // Impede que teclas do chat (A/D/W/S/ESPACO/1-3/C...) cheguem no jogo.
    this.chatInputEl.addEventListener('keydown', (e) => e.stopPropagation());
    this.chatInputEl.addEventListener('keyup', (e) => e.stopPropagation());
    // Focar o chat solta qualquer tecla de jogo que tenha ficado "presa"
    // (ex: segurando ESPACO e clicando pra digitar) sem disparar o tiro.
    this.chatInputEl.addEventListener('focus', () => {
      this.keys.clear();
      this.charging = false;
    });
    const chatSendBtn = document.createElement('button');
    chatSendBtn.id = 'matchChatSend';
    chatSendBtn.textContent = 'Enviar';
    const sendChat = (): void => {
      const text = this.chatInputEl.value.trim();
      if (!text) return;
      this.net.socket.emit('chat', { text });
      this.chatInputEl.value = '';
    };
    chatSendBtn.onclick = sendChat;
    this.chatInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChat();
    });
    chatRow.appendChild(this.chatInputEl);
    chatRow.appendChild(chatSendBtn);
    chatPanel.appendChild(chatRow);

    this.chatBox.appendChild(chatPanel);
    document.body.appendChild(this.chatBox);
    this.setChatOpen(false);

    this.bindNet();
  }

  private setChatOpen(open: boolean): void {
    this.chatOpen = open;
    this.chatBox.classList.toggle('open', open);
    if (open) {
      this.chatUnread = 0;
      this.chatToggleBtn.textContent = 'Chat';
      this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
      this.chatInputEl.focus();
    }
  }

  private onChatMessage(msg: { from: string; text: string }): void {
    const line = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = `${msg.from}: `;
    line.appendChild(b);
    line.appendChild(document.createTextNode(msg.text));
    this.chatLogEl.appendChild(line);
    while (this.chatLogEl.childNodes.length > 60) this.chatLogEl.removeChild(this.chatLogEl.firstChild!);

    if (this.chatOpen) {
      this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
    } else {
      this.chatUnread += 1;
      this.chatToggleBtn.textContent = `Chat (${this.chatUnread})`;
    }

    const sender = [...this.players.values()].find((p) => p.nick === msg.from);
    if (sender) this.chatBubbles.set(sender.id, { text: msg.text, until: this.clock + 4.5 });
  }

  // -------------------------------------------------------------------------
  // Rede
  // -------------------------------------------------------------------------

  private bindNet(): void {
    const s = this.net.socket;

    s.on('matchStart', (data: MatchStart) => this.onMatchStart(data));
    s.on('roundPrep', (data: RoundPrep) => this.onRoundPrep(data));
    s.on('snapshot', (data: Snapshot) => this.onSnapshot(data));
    s.on('roundReady', (data: ReadyState) => this.onRoundReady(data));
    s.on('crates', (list: CrateDef[]) => {
      this.crates = list;
      // Toda a leva e nova (o servidor sempre manda a lista completa) — todos
      // acabaram de "cair", entao o paraquedas aparece do zero pra cada um.
      const fresh = new Map<number, number>();
      for (const c of list) fresh.set(c.id, this.clock);
      this.crateSpawnClock = fresh;
    });
    s.on('cratePicked', (data: CratePicked) => this.onCratePicked(data));
    s.on('chat', (msg: { from: string; text: string; at: number }) => this.onChatMessage(msg));
    s.on('matchStats', (list: PlayerStat[]) => {
      this.stats = new Map(list.map((s) => [s.playerId, { damage: s.damage, kills: s.kills }]));
    });
    s.on('roundResolve', (plan: ResolutionPlan) => this.onRoundResolve(plan));
    s.on('roundEnd', () => {
      this.phase = 'interval';
    });
    s.on('matchEnd', (data: MatchEnd) => {
      this.finalResult = data;
      this.phase = 'over';
    });
  }

  private onMatchStart(data: MatchStart): void {
    this.ownId = this.net.playerId;
    this.terrain = Terrain.generate(data.mapId, data.seed);
    // Quem entra no meio da partida recebe as crateras ja abertas.
    for (const c of data.carves) this.terrain.carve(c);
    this.terrain.consumeDirty();
    this.terrainRenderer = new TerrainRenderer(this.terrain);
    this.particles.setTerrain(this.terrain);

    this.players = new Map();
    for (const p of data.players) {
      this.players.set(p.id, {
        id: p.id,
        nick: p.nick,
        isBot: p.isBot,
        x: p.x,
        y: p.y,
        targetX: p.x,
        targetY: p.y,
        vx: 0,
        vy: 0,
        onGround: false,
        facing: 1,
        hp: p.hp,
        alive: true,
        fuel: JORBE_FUEL_PER_ROUND,
        shielded: false,
        rig: freshRig(p.hp, p.id),
      });
    }

    this.crates = data.crates;
    // Quem entra no meio da partida ve engradados ja pousados havia tempo —
    // sem paraquedas.
    this.crateSpawnClock = new Map(data.crates.map((c) => [c.id, -999]));
    this.stats = new Map();
    this.lastShotTrail = null;
    this.finalResult = null;
    this.phase = 'interval';
    const self = this.players.get(this.ownId);
    if (self) this.cam.centerOn(self.x, self.y);
    this.start();
  }

  private onRoundPrep(data: RoundPrep): void {
    // Toca ANTES de sobrescrever o vento antigo — e a mudanca que interessa.
    if (Math.abs(data.wind - this.wind) > 0.5) sfx.sfxWindChange(data.wind);

    // Guarda o que valia ate agora, antes de resetar pra rodada nova.
    if (this.round > 0) {
      this.history = { wind: this.wind, angle: this.aimAngle, power: this.power };
    }

    this.round = data.round;
    this.wind = data.wind;
    this.remaining = data.seconds;
    this.fuel = data.fuel;
    this.ammo = data.ammo;
    this.phase = 'prep';
    this.power = 0;
    this.charging = false;
    this.aimLocked = false;
    this.pending = [];
    this.cameraManualHold = false;
    this.shielded = new Set();
    this.shieldArmed = false;
    this.readyIds = new Set();
    this.lastTickSecond = -1;
    this.tickPulse = 0;
    this.showBanner(`Rodada ${data.round} — mire!`, 1800);
    sfx.sfxRoundStart();
  }

  private onRoundReady(data: ReadyState): void {
    const wasAllReady = this.allHumansReady();
    this.readyIds = new Set(data.ready);
    if (!wasAllReady && this.allHumansReady()) {
      this.showBanner('Todos prontos — atirando!', 900);
    }
  }

  /** So conta jogadores humanos vivos — Jorbots nunca aparecem no painel. */
  private allHumansReady(): boolean {
    const humans = [...this.players.values()].filter((p) => p.alive && !p.isBot);
    return humans.length > 0 && humans.every((p) => this.readyIds.has(p.id));
  }

  private onCratePicked(data: CratePicked): void {
    const crate = this.crates.find((c) => c.id === data.id);
    this.crates = this.crates.filter((c) => c.id !== data.id);
    if (!crate) return;

    const color = crate.kind === 'health' ? PALETTE.red : PALETTE.crust;
    this.particles.burst(crate.x, crate.y - 14, 18, color);
    this.particles.flash(crate.x, crate.y - 14, 14);
    sfx.sfxPickup(crate.kind);

    if (data.playerId === this.ownId) {
      this.showBanner(crate.kind === 'health' ? 'Vida recuperada!' : 'Municao recebida!', 1000);
    }
  }

  private onSnapshot(data: Snapshot): void {
    this.remaining = data.remaining;
    this.fuel = data.fuel;
    // Ammo pode mudar no meio do preparo (engradado) — o snapshot e a fonte
    // de verdade, roundPrep so da o valor inicial da rodada.
    this.ammo = data.ammo;

    for (const sp of data.players) {
      const p = this.players.get(sp.id);
      if (!p) continue;
      this.applyDamageFeedback(p, sp.hp);
      p.hp = sp.hp;
      p.alive = sp.alive;
      p.facing = sp.facing;

      // So conta como "pouso" com queda de verdade — chao irregular faz o
      // onGround piscar false/true a cada solavanco de andar, e sem esse
      // piso minimo o coice se acumulava a cada bump e distorcia o sprite.
      const landedNow = sp.onGround && !p.rig.wasOnGround && sp.vy > 40;
      if (landedNow) {
        p.rig.squash.kick(-260);
        if (sp.id === this.ownId) sfx.sfxLand();
      }
      p.rig.wasOnGround = sp.onGround;

      if (sp.id === this.ownId) {
        // Reconciliacao: assume a posicao do servidor e reaplica os inputs
        // que ele ainda nao processou, para o andar nao "voltar no tempo".
        p.x = sp.x;
        p.y = sp.y;
        p.vx = sp.vx;
        p.vy = sp.vy;
        p.onGround = sp.onGround;
        p.fuel = data.fuel;

        this.pending = this.pending.filter((q) => q.seq > data.ackSeq);
        if (this.terrain) {
          const scratch: SimEvent[] = [];
          for (const q of this.pending) {
            stepCharacter(this.terrain, p, q.input, PREP_DT, 0, scratch);
          }
        }
      } else {
        // Os outros sao interpolados: nada de teletransporte a cada pacote.
        p.targetX = sp.x;
        p.targetY = sp.y;
        p.vx = sp.vx;
        p.vy = sp.vy;
        p.onGround = sp.onGround;
      }
    }
  }

  private applyDamageFeedback(p: RemotePlayer, newHp: number): void {
    if (newHp < p.rig.prevHp) {
      p.rig.hitFlash = 1;
      if (newHp > 0) sfx.sfxHit();
    }
    p.rig.prevHp = newHp;
  }

  private onRoundResolve(plan: ResolutionPlan): void {
    this.phase = 'resolve';
    this.playAcc = 0;
    this.charging = false;
    this.shielded = new Set(plan.shielded);

    const projectiles = new Map<number, PlaybackProjectile>();
    for (const s of plan.shots) {
      projectiles.set(s.id, {
        id: s.id,
        weaponId: s.weaponId,
        x: s.x,
        y: s.y,
        vx: s.vx,
        vy: s.vy,
        rot: 0,
        squash: new Spring(1, 260, 14),
        smokeAcc: 0,
      });
      sfx.sfxShot(WEAPON_WEIGHT[s.weaponId] ?? 'light');
    }

    const selfShotId = plan.shots.find((s) => s.ownerId === this.ownId)?.id ?? null;
    this.playback = { plan, tick: 0, eventIdx: 0, projectiles, lastBoom: null, selfShotId, selfTrail: [] };
    this.showBanner('Fogo!', 1200);
  }

  // -------------------------------------------------------------------------
  // Entrada
  // -------------------------------------------------------------------------

  attachControls(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    // Botao direito agora e dedicado a mover a camera — sem isso o navegador
    // abriria o menu de contexto nativo a cada clique direito no jogo.
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  detachControls(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('resize', this.onResize);
  }

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  /** Roda do mouse: aproxima ou afasta a camera, mantendo o centro da tela fixo. */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.cam.zoomBy(factor);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (document.activeElement === this.chatInputEl) return;
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    this.keys.add(k);

    if (k === ' ') {
      e.preventDefault();
      if (this.phase === 'prep' && !this.aimLocked && this.canFire()) {
        this.charging = true;
        this.power = MIN_POWER;
      }
    }
    if (k === 'c') this.cameraManualHold = false;
    if (k >= '1' && k <= '3') this.selectWeapon(Number(k) - 1);
    if (k === '4' || k === 'e') this.toggleShield();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (document.activeElement === this.chatInputEl) return;
    const k = e.key.toLowerCase();
    this.keys.delete(k);
    if (k === ' ' && this.charging) {
      this.charging = false;
      this.fire();
    }
  };

  /** Abaixo da largura de corte, empilha tudo em varias linhas em vez de uma so. */
  private get compactHud(): boolean {
    return this.cam.viewW < MatchScene.HUD_COMPACT_BREAKPOINT;
  }

  /** Altura do painel inferior do HUD — cresce no modo empilhado pra caber as linhas extras. */
  private get hudH(): number {
    return this.compactHud ? 232 : 124;
  }

  /** Y do topo do painel inferior do HUD — usado tanto pra desenhar quanto pra testar clique. */
  private get hudY(): number {
    return this.cam.viewH - this.hudH;
  }

  private weaponCardRect(i: number): { x: number; y: number; w: number; h: number } {
    if (!this.compactHud) {
      return { x: 400 + i * 164, y: this.hudY + 14, w: 156, h: 62 };
    }
    const margin = 14;
    const gap = 8;
    const count = WEAPONS.length;
    const w = Math.min(156, (this.cam.viewW - margin * 2 - gap * (count - 1)) / count);
    return { x: margin + i * (w + gap), y: this.hudY + 118, w, h: 62 };
  }

  private forceBarRect(): { x: number; y: number; w: number; h: number } {
    if (!this.compactHud) {
      return { x: 195, y: this.hudY + 44, w: 190, h: 14 };
    }
    const x = 14;
    return { x, y: this.hudY + 66, w: Math.max(80, this.cam.viewW - x - 60), h: 14 };
  }

  /** Retangulo da barra de combustivel — depende do modo compacto assim como a de forca. */
  private fuelBarRect(): { x: number; y: number; w: number; h: number } {
    if (!this.compactHud) {
      return { x: 195, y: this.hudY + 72, w: 190, h: 12 };
    }
    const x = 14;
    return { x, y: this.hudY + 96, w: this.cam.viewW - x * 2, h: 12 };
  }

  private inRect(x: number, y: number, r: { x: number; y: number; w: number; h: number }): boolean {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  /** Encurta o texto com reticencias ate caber em maxWidth — `ctx.fillText` nao clipa nem quebra linha sozinho. */
  private fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
    return `${t}…`;
  }

  private selectWeapon(idx: number): void {
    if (this.aimLocked || idx < 0 || idx >= WEAPONS.length || WEAPONS[idx]!.defensive) return;
    this.weaponIdx = idx;
    this.sendAim(false);
    sfx.sfxUiClick();
  }

  /** Escudo e um toggle a parte — arma/desarma sem trocar a arma que vai atirar. */
  private toggleShield(): void {
    if (this.aimLocked) return;
    const ammo = this.ammo.escudo;
    const hasCharge = ammo === null || ammo === undefined || ammo > 0;
    if (!this.shieldArmed && !hasCharge) return;
    this.shieldArmed = !this.shieldArmed;
    this.sendAim(false);
    sfx.sfxShieldUp();
  }

  private setPowerFromClientX(clientX: number): void {
    const r = this.forceBarRect();
    const t = (clientX - r.x) / r.w;
    this.power = Math.max(MIN_POWER, Math.min(MAX_POWER, t * MAX_POWER));
  }

  /** Posicao do proprio Jorbe na tela — origem do "estilingue" da mira por arraste. */
  private ownScreenAnchor(): { x: number; y: number } | null {
    const self = this.players.get(this.ownId);
    if (!self || !self.alive) return null;
    return {
      x: (self.x - this.cam.renderX) * this.cam.zoom,
      y: (self.y - JORBE_HEIGHT * 0.55 - this.cam.renderY) * this.cam.zoom,
    };
  }

  /** Angry Birds: puxar do Jorbe pra tras define angulo e forca de uma vez. */
  private applyAimDrag(clientX: number, clientY: number): void {
    const anchor = this.ownScreenAnchor();
    if (!anchor) return;
    const dragX = clientX - anchor.x;
    const dragY = clientY - anchor.y;
    const dist = Math.hypot(dragX, dragY);

    if (dist > 6) {
      const rawAngle = (Math.atan2(dragY, -dragX) * 180) / Math.PI;
      this.aimAngle = Math.max(0, Math.min(180, rawAngle));
    }
    const maxDrag = 150;
    this.power = MIN_POWER + (Math.min(dist, maxDrag) / maxDrag) * (MAX_POWER - MIN_POWER);
  }

  private onPointerDown = (e: PointerEvent): void => {
    const canAdjust = this.phase === 'prep' && !this.aimLocked;

    // Botao direito: mira em QUALQUER ponto do mapa — nao precisa acertar o
    // Jorbe, o vetor de estilingue e calculado a partir dele de qualquer jeito.
    if (e.button === 2) {
      if (!canAdjust) return;
      const anchor = this.ownScreenAnchor();
      if (anchor) {
        this.aimDragging = true;
        this.dragPointer = { x: e.clientX, y: e.clientY };
        this.applyAimDrag(e.clientX, e.clientY);
      }
      return;
    }
    if (e.button !== 0) return;

    // Botao esquerdo: cartas de arma e barra de forca continuam sendo
    // botoes normais de UI; fora delas, arrasta a camera.
    if (canAdjust) {
      for (let i = 0; i < WEAPONS.length; i++) {
        if (this.inRect(e.clientX, e.clientY, this.weaponCardRect(i))) {
          if (WEAPONS[i]!.defensive) this.toggleShield();
          else this.selectWeapon(i);
          return;
        }
      }
      if (this.inRect(e.clientX, e.clientY, this.forceBarRect())) {
        this.forceDragging = true;
        this.setPowerFromClientX(e.clientX);
        return;
      }
    }

    this.dragging = true;
    this.cameraManualHold = true;
    this.lastPointer = { x: e.clientX, y: e.clientY };
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.forceDragging) {
      this.setPowerFromClientX(e.clientX);
      return;
    }
    if (this.aimDragging) {
      this.dragPointer = { x: e.clientX, y: e.clientY };
      this.applyAimDrag(e.clientX, e.clientY);
      return;
    }
    if (!this.dragging || !this.lastPointer) return;
    this.cam.pan(this.lastPointer.x - e.clientX, this.lastPointer.y - e.clientY);
    this.lastPointer = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (): void => {
    // Soltar o mouse depois de mirar arrastando ja trava o tiro — nao precisa
    // clicar em OK separado, o proprio gesto de soltar e o "atirar".
    const wasAimDragging = this.aimDragging;

    this.dragging = false;
    this.lastPointer = null;
    this.forceDragging = false;
    this.aimDragging = false;
    this.dragPointer = null;

    if (wasAimDragging) this.fire();
  };

  private onResize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cam.setViewport(w, h);
    // Os botoes de DOM (cancelar/OK) ficam presos ao topo da HUD via CSS —
    // ela muda de altura no modo empilhado, entao o offset precisa acompanhar.
    document.documentElement.style.setProperty('--hud-h', `${this.hudH}px`);
  };

  private get weapon(): (typeof WEAPONS)[number] {
    return WEAPONS[this.weaponIdx] ?? WEAPONS[0];
  }

  private canFire(): boolean {
    const a = this.ammo[this.weapon.id];
    return a === null || a === undefined || a > 0;
  }

  private sendAim(fire: boolean): void {
    this.net.sendAim({
      angle: this.aimAngle,
      power: Math.max(MIN_POWER, this.power),
      weaponId: this.weapon.id,
      fire,
      shield: this.shieldArmed,
    });
  }

  private fire(): void {
    if (this.phase !== 'prep' || this.aimLocked || !this.canFire()) return;
    this.aimLocked = true;
    this.sendAim(true);
    if (this.showFireTutorial) {
      this.showFireTutorial = false;
      MatchScene.markFired();
    }

    this.showBanner(
      this.shieldArmed ? 'Tiro travado — escudo armado' : 'Tiro travado — aguardando a rodada',
      1500,
    );
    // Coice imediato no proprio Jorbe — feedback instantaneo, antes mesmo do
    // servidor confirmar. E so cosmetico, a fisica de verdade so roda na
    // resolucao.
    const self = this.players.get(this.ownId);
    if (self) {
      const rad = (this.aimAngle * Math.PI) / 180;
      const mag = 90 + (this.power / MAX_POWER) * 120;
      self.rig.recoilX.kick(-Math.cos(rad) * mag);
      self.rig.recoilY.kick(Math.sin(rad) * mag);
    }
  }

  /**
   * Destrava o tiro pra mirar de novo, enquanto ainda houver tempo na rodada.
   * Zera a forca (o angulo fica onde estava, mais rapido de ajustar) e avisa
   * o servidor que essa mao nao esta mais pronta — o que tambem cancela uma
   * resolucao antecipada que estivesse prestes a disparar.
   */
  private cancelAim(): void {
    if (this.phase !== 'prep' || !this.aimLocked || this.remaining <= 0) return;
    this.aimLocked = false;
    this.power = 0;
    this.charging = false;
    this.sendAim(false);
    this.showBanner('Tiro destravado — mire de novo', 1200);
  }

  // -------------------------------------------------------------------------
  // Laco principal
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  stop(onExit?: () => void): void {
    this.running = false;
    this.onExit = onExit ?? null;
  }

  private frame = (now: number): void => {
    if (!this.running) {
      this.onExit?.();
      return;
    }
    const dtMs = Math.min(64, now - this.lastFrame);
    this.lastFrame = now;

    this.update(dtMs);
    this.draw();

    requestAnimationFrame(this.frame);
  };

  private update(dtMs: number): void {
    const dt = dtMs / 1000;
    this.clock += dt;
    this.particles.update(dt);
    this.shockwaves.update(dt);
    this.floatingTexts.update(dt);
    this.cam.updateShake(dt);
    this.tickPulse = Math.max(0, this.tickPulse - dt * 5);

    if (this.phase === 'prep') this.updatePrep(dtMs);
    else if (this.phase === 'resolve') this.updatePlayback(dtMs);

    for (const p of this.players.values()) {
      this.updateRig(p, dt);
      // Interpola os outros jogadores em direcao ao alvo do servidor.
      if (p.id !== this.ownId) {
        p.x += (p.targetX - p.x) * Math.min(1, dt * 12);
        p.y += (p.targetY - p.y) * Math.min(1, dt * 12);
      }
    }

    this.terrainRenderer?.syncDirty();
    this.updateCamera(dt);
    this.updateActionButtons();
  }

  private updateActionButtons(): void {
    const self = this.players.get(this.ownId);
    const inPrep = this.phase === 'prep' && !!self?.alive && this.remaining > 0;
    this.cancelBtn.style.display = inPrep && this.aimLocked ? 'block' : 'none';
    this.readyBtn.style.display = inPrep && !this.aimLocked && this.canFire() ? 'block' : 'none';
    this.leaveBtn.style.display = this.terrainRenderer ? 'block' : 'none';
    this.chatBox.style.display = this.terrainRenderer ? 'flex' : 'none';
  }

  /** Avanca as molas de animacao de um Jorbe: caminhada, esprime e coice. */
  private updateRig(p: RemotePlayer, dt: number): void {
    const moving = p.alive && p.onGround && Math.abs(p.vx) > 6;
    p.rig.walkAmp += ((moving ? 1 : 0) - p.rig.walkAmp) * Math.min(1, dt * 10);
    if (p.rig.walkAmp > 0.02) {
      p.rig.walkPhase += dt * WALK_CYCLE_SPEED * (0.6 + Math.min(1, Math.abs(p.vx) / 80));
    }

    p.rig.squash.update(dt, 1);
    p.rig.recoilX.update(dt, 0);
    p.rig.recoilY.update(dt, 0);
    p.rig.hitFlash = Math.max(0, p.rig.hitFlash - dt * 3.2);
  }

  private updatePrep(dtMs: number): void {
    const dt = dtMs / 1000;
    this.remaining = Math.max(0, this.remaining - dt);

    const secLeft = Math.ceil(this.remaining);
    if (secLeft <= 5 && secLeft > 0 && secLeft !== this.lastTickSecond) {
      this.lastTickSecond = secLeft;
      sfx.sfxTick();
      this.tickPulse = 1;
    }

    // Mira
    if (!this.aimLocked) {
      let delta = 0;
      if (this.keys.has('arrowup') || this.keys.has('w')) delta += ANGLE_PER_SECOND * dt;
      if (this.keys.has('arrowdown') || this.keys.has('s')) delta -= ANGLE_PER_SECOND * dt;
      if (delta !== 0) {
        this.aimAngle = Math.max(0, Math.min(180, this.aimAngle + delta));
      }
      if (this.charging) {
        this.power = Math.min(MAX_POWER, this.power + CHARGE_PER_SECOND * dt);
        sfx.sfxChargeTick(this.power);
        if (this.power >= MAX_POWER) {
          this.charging = false;
          this.fire();
        }
      }
    }

    // Movimento com predicao local em passo fixo.
    const self = this.players.get(this.ownId);
    if (!self || !self.alive || !this.terrain) return;

    // Travou o tiro: sem movimento (mas a fisica local continua rodando —
    // gravidade/queda — pra nao dessincronizar do servidor, que faz o mesmo).
    // Senao dava pra travar o tiro e ainda fugir com o combustivel que sobrou.
    const jumpDown = !this.aimLocked && this.keys.has('shift');
    if (jumpDown && !this.wasJumpKeyDown && self.onGround) {
      sfx.sfxJump();
      self.rig.squash.kick(220);
    }
    this.wasJumpKeyDown = jumpDown;

    const walking =
      !this.aimLocked &&
      self.onGround &&
      (this.keys.has('a') || this.keys.has('d') || this.keys.has('arrowleft') || this.keys.has('arrowright'));
    if (walking && self.rig.walkAmp > 0.6) {
      const stepEvery = Math.PI;
      const phaseInStep = self.rig.walkPhase % stepEvery;
      if (!this.stepArmed) this.stepArmed = phaseInStep > stepEvery * 0.5;
      if (this.stepArmed && phaseInStep <= stepEvery * 0.5) {
        sfx.sfxStep();
        this.stepArmed = false;
      }
    }

    this.inputAcc += dtMs;
    const stepMs = PREP_DT * 1000;
    const scratch: SimEvent[] = [];

    while (this.inputAcc >= stepMs) {
      this.inputAcc -= stepMs;
      const input: MoveInput = this.aimLocked
        ? { left: false, right: false, jump: false }
        : {
            left: this.keys.has('a') || this.keys.has('arrowleft'),
            right: this.keys.has('d') || this.keys.has('arrowright'),
            jump: this.keys.has('shift'),
          };
      this.inputSeq += 1;
      this.net.sendInput({ seq: this.inputSeq, ...input });
      this.pending.push({ seq: this.inputSeq, input });
      stepCharacter(this.terrain, self, input, PREP_DT, 0, scratch);
      this.fuel = self.fuel;
    }
  }

  private updatePlayback(dtMs: number): void {
    const pb = this.playback;
    const t = this.terrain;
    if (!pb || !t) return;

    this.playAcc += dtMs;
    const stepMs = TICK_DT * 1000;
    const scratch: SimEvent[] = [];

    while (this.playAcc >= stepMs && pb.tick < pb.plan.totalTicks) {
      this.playAcc -= stepMs;

      // 1) Projeteis: integracao puramente balistica, sem colisao.
      for (const p of pb.projectiles.values()) {
        const w = getWeapon(p.weaponId);
        p.vy += GRAVITY * TICK_DT;
        p.vx += pb.plan.wind * w.windFactor * TICK_DT;
        p.x += p.vx * TICK_DT;
        p.y += p.vy * TICK_DT;
        p.rot += Math.hypot(p.vx, p.vy) * 0.012 * TICK_DT;
        p.squash.update(TICK_DT, 1);

        if (p.weaponId === 'bazuca') {
          p.smokeAcc += TICK_DT;
          if (p.smokeAcc > 0.03) {
            p.smokeAcc = 0;
            this.particles.puff(p.x, p.y, PALETTE.smoke, 1);
          }
        }

        if (p.id === pb.selfShotId) pb.selfTrail.push({ x: p.x, y: p.y });
      }

      // 2) Eventos autoritativos deste tick.
      while (pb.eventIdx < pb.plan.events.length && pb.plan.events[pb.eventIdx].tick === pb.tick) {
        this.applyEvent(pb.plan.events[pb.eventIdx], pb);
        pb.eventIdx++;
      }

      // 3) Personagens seguem a fisica com o terreno ja atualizado.
      for (const p of this.players.values()) {
        stepCharacter(t, p, NO_INPUT, TICK_DT, pb.tick, scratch);
      }

      pb.tick++;
    }

    if (pb.tick >= pb.plan.totalTicks) {
      // Sincronia final: o servidor manda a palavra final sobre onde todo
      // mundo parou e com quanta vida.
      for (const fs of pb.plan.finalStates) {
        const p = this.players.get(fs.id);
        if (!p) continue;
        this.applyDamageFeedback(p, fs.hp);
        p.x = fs.x;
        p.y = fs.y;
        p.targetX = fs.x;
        p.targetY = fs.y;
        p.vx = fs.vx;
        p.vy = fs.vy;
        p.onGround = fs.onGround;
        p.hp = fs.hp;
        p.alive = fs.alive;
      }
      if (pb.selfTrail.length > 1) this.lastShotTrail = pb.selfTrail;
      this.playback = null;
      this.phase = 'interval';
    }
  }

  private applyEvent(e: SimEvent, pb: Playback): void {
    const t = this.terrain;
    if (!t) return;

    switch (e.kind) {
      case 'explosion': {
        const w = getWeapon(e.weaponId);
        t.carve({ x: e.x, y: e.y, r: e.radius });
        this.particles.burst(e.x, e.y, e.radius, w.color);
        this.particles.flash(e.x, e.y, e.radius);
        this.shockwaves.spawn(e.x, e.y, e.radius * 2.1);
        this.cam.addTrauma(Math.min(1, e.radius / 55));
        sfx.sfxExplosion(e.radius);
        pb.projectiles.delete(e.shotId);
        pb.lastBoom = { x: e.x, y: e.y };
        break;
      }
      case 'bounce': {
        const p = pb.projectiles.get(e.shotId);
        if (p) {
          p.x = e.x;
          p.y = e.y;
          p.vx = e.vx;
          p.vy = e.vy;
          p.squash.kick(-320);
        }
        break;
      }
      case 'knockback': {
        const p = this.players.get(e.playerId);
        if (p) {
          p.vx = e.vx;
          p.vy = e.vy;
          p.onGround = false;
        }
        break;
      }
      case 'damage': {
        const p = this.players.get(e.playerId);
        // hp e absoluto: mesmo que a predicao local tenha errado, aqui corrige.
        if (p) this.applyDamageFeedback(p, e.hp);
        if (p) p.hp = e.hp;
        if (p) this.floatingTexts.spawn(p.x, p.y - JORBE_HEIGHT - 10, `-${Math.round(e.amount)}`, PALETTE.red);
        break;
      }
      case 'death': {
        const p = this.players.get(e.playerId);
        if (p) {
          p.alive = false;
          p.hp = 0;
          this.particles.burst(p.x, p.y - JORBE_HEIGHT / 2, 30, PALETTE.bottle);
          sfx.sfxDeath();
        }
        break;
      }
      case 'blocked': {
        const p = this.players.get(e.playerId);
        if (p) {
          this.floatingTexts.spawn(p.x, p.y - JORBE_HEIGHT - 10, 'BLOQUEADO!', '#6fb8d6');
          this.particles.flash(p.x, p.y - JORBE_HEIGHT / 2, 26);
          sfx.sfxShieldBlock();
        }
        break;
      }
    }
  }

  private updateCamera(dt: number): void {
    if (this.dragging || this.cameraManualHold) return;

    if (this.phase === 'resolve' && this.playback) {
      // Segue o tiro mais alto ainda no ar; se todos ja estouraram, olha a
      // ultima explosao.
      const live = [...this.playback.projectiles.values()];
      if (live.length > 0) {
        const target = live.reduce((a, b) => (a.y < b.y ? a : b));
        this.cam.glideTo(target.x, target.y, Math.min(1, dt * 6));
        return;
      }
      if (this.playback.lastBoom) {
        this.cam.glideTo(this.playback.lastBoom.x, this.playback.lastBoom.y, Math.min(1, dt * 3));
        return;
      }
    }

    const self = this.players.get(this.ownId);
    if (self) this.cam.glideTo(self.x, self.y - 40, Math.min(1, dt * 6));
  }

  // -------------------------------------------------------------------------
  // Desenho
  // -------------------------------------------------------------------------

  private draw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cam.viewW, this.cam.viewH);
    drawSky(ctx, this.cam);

    if (!this.terrainRenderer) {
      this.drawCenteredText('gerando a fabrica...', PALETTE.cream);
      return;
    }

    ctx.save();
    ctx.scale(this.cam.zoom, this.cam.zoom);
    ctx.translate(-Math.round(this.cam.renderX), -Math.round(this.cam.renderY));

    ctx.drawImage(this.terrainRenderer.canvas, 0, 0);

    if (this.lastShotTrail && this.phase === 'prep') {
      ctx.save();
      ctx.setLineDash([7, 7]);
      ctx.strokeStyle = 'rgba(244,228,193,0.4)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(this.lastShotTrail[0]!.x, this.lastShotTrail[0]!.y);
      for (let i = 1; i < this.lastShotTrail.length; i++) {
        ctx.lineTo(this.lastShotTrail[i]!.x, this.lastShotTrail[i]!.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    const aimPreview = this.computeAimPreview();
    if (aimPreview) {
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = this.weapon.color;
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(aimPreview[0]!.x, aimPreview[0]!.y);
      for (let i = 1; i < aimPreview.length; i++) {
        ctx.lineTo(aimPreview[i]!.x, aimPreview[i]!.y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    for (const crate of this.crates) {
      const weapon = crate.weaponId ? getWeapon(crate.weaponId) : null;
      const spawnAt = this.crateSpawnClock.get(crate.id) ?? this.clock;
      const elapsed = this.clock - spawnAt;
      // Queda visual (so cosmetica — a posicao real pro servidor ja e a final):
      // comeca bem alto no ceu e desacelera se aproximando do chao, como se o
      // paraquedas estivesse freando.
      const fallDuration = 2.2;
      const dropHeight = 460;
      const fallProgress = Math.min(1, Math.max(0, elapsed / fallDuration));
      const eased = 1 - (1 - fallProgress) * (1 - fallProgress);
      const drawY = crate.y - (1 - eased) * dropHeight;
      const showParachute = elapsed < fallDuration + 0.15;
      drawCrate(
        ctx,
        crate.x,
        drawY,
        crate.kind,
        crate.weaponId,
        weapon?.color ?? PALETTE.crust,
        this.clock * 1.4 + crate.id,
        showParachute,
      );
    }

    for (const p of this.players.values()) {
      const isSelf = p.id === this.ownId;
      // Parado, o Jorbe respira — um esprime bem sutil, fora de fase entre jogadores.
      const idleBob = p.alive && p.rig.walkAmp < 0.05
        ? Math.sin(this.clock * 2.1 + p.rig.idleOffset) * 0.018
        : 0;
      const anim: JorbeAnim = {
        walkPhase: p.rig.walkPhase,
        walkAmp: p.rig.walkAmp,
        // Pousos seguidos em terreno irregular (andando) podem empurrar a mola
        // repetidas vezes antes dela assentar — sem limite, o valor podia
        // passar de zero e o `ctx.scale` virava o sprite de cabeca pra baixo.
        squashY: Math.max(0.4, Math.min(1.8, p.rig.squash.value + idleBob)),
        recoilX: p.rig.recoilX.value,
        recoilY: p.rig.recoilY.value,
        hitFlash: p.rig.hitFlash,
      };
      if (p.alive && this.shielded.has(p.id)) {
        drawShieldAura(ctx, p.x, p.y, this.clock);
      }

      const canAim = isSelf && this.phase === 'prep' && p.alive;
      drawJorbe(ctx, {
        x: p.x,
        y: p.y,
        facing: p.facing,
        hp: p.hp,
        alive: p.alive,
        nick: p.nick,
        isSelf,
        aimAngle: canAim ? this.aimAngle : null,
        aimPower: (Math.max(MIN_POWER, this.power) - MIN_POWER) / (MAX_POWER - MIN_POWER),
        aimLabel:
          canAim && !this.showFireTutorial
            ? `${this.aimAngle.toFixed(0)}° · ${Math.round(this.power)}${this.shieldArmed ? ' · Escudo' : ''}`
            : null,
        anim: p.alive ? anim : { ...IDLE_ANIM, hitFlash: 0 },
      });

      if (isSelf && this.showFireTutorial && this.phase === 'prep' && !this.aimLocked && p.alive) {
        this.drawFireTutorialBalloon(ctx, p);
      }

      const bubble = this.chatBubbles.get(p.id);
      if (bubble) {
        if (bubble.until > this.clock) this.drawChatBubble(ctx, p, bubble.text);
        else this.chatBubbles.delete(p.id);
      }
    }

    if (this.playback) {
      for (const p of this.playback.projectiles.values()) {
        this.drawProjectile(ctx, p);
      }
    }

    this.particles.draw(ctx);
    this.shockwaves.draw(ctx);
    this.floatingTexts.draw(ctx);
    ctx.restore();

    this.drawHud();
    if (this.phase !== 'over') drawWindIndicator(ctx, this.cam.viewW, this.wind, WIND_MAX);
    if (this.phase !== 'over') this.drawStatsPanel(ctx);
    drawFilmOverlay(ctx, this.cam.viewW, this.cam.viewH, this.clock);
  }

  /** Painel flutuante e transparente: quem mais deu dano e quem mais matou ate agora. */
  private drawStatsPanel(ctx: CanvasRenderingContext2D): void {
    if (this.round === 0) return;
    // Na HUD empilhada o botao OK/cancelar e o painel de prontidao ja disputam
    // esse mesmo canto durante o preparo — o placar volta a aparecer entre rodadas.
    if (this.compactHud && this.phase === 'prep') return;
    const rows = [...this.players.values()]
      .map((p) => ({ p, s: this.stats.get(p.id) ?? { damage: 0, kills: 0 } }))
      .filter((r) => r.s.damage > 0 || r.s.kills > 0)
      .sort((a, b) => b.s.damage - a.s.damage)
      .slice(0, 6);
    if (rows.length === 0) return;

    const topDamageId = rows[0]!.p.id;
    const topKillId = [...rows].sort((a, b) => b.s.kills - a.s.kills)[0]!;
    const topKillsValue = topKillId.s.kills;

    const w = Math.min(208, this.cam.viewW - 32);
    const rowH = 22;
    const h = 32 + rows.length * rowH;
    // Canto inferior esquerdo, acima da barra do HUD — nunca colide com o
    // minimapa/painel de prontidao (topo direito) nem com o vento (topo centro).
    const x = 16;
    const y = this.cam.viewH - this.hudH - h - 12;

    ctx.save();
    ctx.fillStyle = 'rgba(19,8,2,0.7)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = PALETTE.crust;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    ctx.font = 'bold 13px Georgia, serif';
    ctx.fillStyle = PALETTE.crust;
    ctx.fillText('PLACAR', x + 10, y + 20);

    rows.forEach((r, i) => {
      const ry = y + 40 + i * rowH;
      const isTopDamage = r.p.id === topDamageId;
      const isTopKill = topKillsValue > 0 && r.p.id === topKillId.p.id;

      ctx.font = '13px Georgia, serif';
      ctx.fillStyle = r.p.id === this.ownId ? PALETTE.crust : PALETTE.cream;
      ctx.fillText(r.p.nick.slice(0, 12), x + 10, ry);

      ctx.textAlign = 'right';
      ctx.font = isTopDamage ? 'bold 13px Georgia, serif' : '13px Georgia, serif';
      ctx.fillStyle = isTopDamage ? PALETTE.red : 'rgba(244,228,193,0.8)';
      ctx.fillText(`${Math.round(r.s.damage)} dmg`, x + w - 46, ry);

      ctx.font = isTopKill ? 'bold 13px Georgia, serif' : '13px Georgia, serif';
      ctx.fillStyle = isTopKill ? PALETTE.bottle : 'rgba(244,228,193,0.8)';
      ctx.fillText(`${r.s.kills} abt`, x + w - 10, ry);
      ctx.textAlign = 'left';
    });

    ctx.restore();
  }

  /** Balaozinho de tutorial — mostra so ate o jogador atirar pela primeira vez neste navegador. */
  private drawFireTutorialBalloon(ctx: CanvasRenderingContext2D, p: RemotePlayer): void {
    const lines = ['Sua vez de atirar!', 'Botao direito arrasta a mira, ou segure ESPACO'];
    ctx.save();
    ctx.font = '11px Georgia, serif';
    const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const bw = textW + 20;
    const lineH = 16;
    const bh = 12 + lines.length * lineH;
    const bob = Math.sin(this.clock * 3) * 3;
    const cx = p.x;
    const by = p.y - JORBE_HEIGHT - 34 - bh + bob;
    const bx = cx - bw / 2;

    ctx.fillStyle = 'rgba(19,8,2,0.92)';
    ctx.strokeStyle = PALETTE.bottle;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 8);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx - 6, by + bh - 1);
    ctx.lineTo(cx, by + bh + 8);
    ctx.lineTo(cx + 6, by + bh - 1);
    ctx.closePath();
    ctx.fillStyle = 'rgba(19,8,2,0.92)';
    ctx.fill();

    ctx.textAlign = 'center';
    lines.forEach((line, i) => {
      ctx.font = i === 0 ? 'bold 13px Georgia, serif' : '11px Georgia, serif';
      ctx.fillStyle = i === 0 ? PALETTE.bottle : PALETTE.cream;
      ctx.fillText(line, cx, by + 17 + i * lineH);
    });
    ctx.textAlign = 'left';
    ctx.restore();
  }

  /** Balaozinho de fala estilo RPG — aparece no mundo, do lado do Jorbe, quando o jogador manda uma mensagem no chat. */
  private drawChatBubble(ctx: CanvasRenderingContext2D, p: RemotePlayer, text: string): void {
    const truncated = text.length > 46 ? `${text.slice(0, 46)}…` : text;
    ctx.save();
    ctx.font = '12px Georgia, serif';
    const textW = ctx.measureText(truncated).width;
    const bw = textW + 22;
    const bh = 26;
    const cx = p.x;
    // Mais alto que o balao de mira/tutorial pra nao se sobrepor quando os dois aparecem juntos.
    const by = p.y - JORBE_HEIGHT - 56 - bh;
    const bx = cx - bw / 2;

    ctx.fillStyle = 'rgba(244,228,193,0.95)';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 9);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx - 6, by + bh - 1);
    ctx.lineTo(cx, by + bh + 8);
    ctx.lineTo(cx + 6, by + bh - 1);
    ctx.closePath();
    ctx.fillStyle = 'rgba(244,228,193,0.95)';
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.stroke();

    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.fillText(truncated, cx, by + bh / 2 + 4);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  private drawProjectile(ctx: CanvasRenderingContext2D, p: PlaybackProjectile): void {
    const w = getWeapon(p.weaponId);
    ctx.save();
    ctx.translate(p.x, p.y);

    if (p.weaponId === 'bazuca') {
      const angle = Math.atan2(p.vy, p.vx);
      ctx.rotate(angle);
      ctx.fillStyle = w.color;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(-w.size * 1.6, -w.size * 0.6, w.size * 3.2, w.size * 1.2, w.size * 0.5);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.rotate(p.rot);
      ctx.scale(1 / p.squash.value, p.squash.value);
      ctx.fillStyle = w.color;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, w.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (p.weaponId === 'tampinha') {
        ctx.strokeStyle = 'rgba(26,10,0,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-w.size * 0.6, 0);
        ctx.lineTo(w.size * 0.6, 0);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawHud(): void {
    const ctx = this.ctx;
    const self = this.players.get(this.ownId);

    const mm = drawMinimap(
      ctx,
      this.terrainRenderer!.canvas,
      this.cam,
      [...this.players.values()].map((p) => ({
        x: p.x,
        y: p.y,
        alive: p.alive,
        isSelf: p.id === this.ownId,
      })),
    );
    this.drawReadyPanel(ctx, mm);

    // Painel inferior
    const compact = this.compactHud;
    const h = this.hudH;
    const y = this.hudY;
    ctx.fillStyle = 'rgba(19,8,2,0.88)';
    ctx.fillRect(0, y, this.cam.viewW, h);
    ctx.strokeStyle = PALETTE.crust;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(this.cam.viewW, y);
    ctx.stroke();

    ctx.font = '15px Georgia, serif';
    ctx.fillStyle = PALETTE.cream;

    const windDir = this.wind > 0 ? '>>>' : '<<<';
    const windText = `Vento ${Math.abs(this.wind).toFixed(0)} ${Math.abs(this.wind) < 1 ? '--' : windDir}`;
    const historyText = this.history
      ? `antes: vento ${Math.abs(this.history.wind).toFixed(0)} ${
          this.history.wind > 0 ? '>>>' : this.history.wind < 0 ? '<<<' : '--'
        } · ${this.history.angle.toFixed(0)}° · forca ${Math.round(this.history.power)}`
      : null;

    if (!compact) {
      // Tempo e rodada — pulsa e faz tique-taque nos ultimos segundos.
      ctx.save();
      ctx.font = 'bold 27px Georgia, serif';
      ctx.fillStyle = this.remaining < 6 ? PALETTE.red : PALETTE.crust;
      ctx.translate(18, y + 36);
      const pulseScale = 1 + this.tickPulse * 0.4;
      ctx.scale(pulseScale, pulseScale);
      ctx.fillText(`${Math.ceil(this.remaining)}s`, 0, 0);
      ctx.restore();
      ctx.font = '15px Georgia, serif';
      ctx.fillStyle = PALETTE.cream;
      ctx.fillText(`Rodada ${this.round}`, 18, y + 58);
      ctx.fillText(windText, 18, y + 80);

      if (historyText) {
        ctx.font = 'italic 12px Georgia, serif';
        ctx.fillStyle = 'rgba(244,228,193,0.55)';
        ctx.fillText(historyText, 18, y + 102);
        ctx.font = '15px Georgia, serif';
      }

      // Angulo e forca
      ctx.fillStyle = PALETTE.cream;
      ctx.fillText(`Angulo ${this.aimAngle.toFixed(0)} graus`, 130, y + 30);
      ctx.fillText('Forca (clique/arraste)', 130, y + 54);
    } else {
      // Empilhado: cronometro + rodada + vento numa linha soh, o resto embaixo.
      ctx.save();
      ctx.font = 'bold 20px Georgia, serif';
      ctx.fillStyle = this.remaining < 6 ? PALETTE.red : PALETTE.crust;
      const pulseScale = 1 + this.tickPulse * 0.4;
      ctx.translate(16, y + 24);
      ctx.scale(pulseScale, pulseScale);
      const timerText = `${Math.ceil(this.remaining)}s`;
      ctx.fillText(timerText, 0, 0);
      const timerW = ctx.measureText(timerText).width * pulseScale;
      ctx.restore();

      ctx.font = '14px Georgia, serif';
      ctx.fillStyle = PALETTE.cream;
      ctx.fillText(`Rodada ${this.round} · ${windText}`, 16 + timerW + 12, y + 24);

      if (historyText) {
        ctx.font = 'italic 11px Georgia, serif';
        ctx.fillStyle = 'rgba(244,228,193,0.55)';
        ctx.fillText(historyText, 16, y + 42);
      }

      ctx.font = '14px Georgia, serif';
      ctx.fillStyle = PALETTE.cream;
      ctx.fillText(`Angulo ${this.aimAngle.toFixed(0)}°`, 16, y + 60);
    }

    const fbar = this.forceBarRect();
    ctx.fillStyle = 'rgba(244,228,193,0.25)';
    ctx.fillRect(fbar.x, fbar.y, fbar.w, fbar.h);
    ctx.fillStyle = this.power > 80 ? PALETTE.red : PALETTE.crust;
    ctx.fillRect(fbar.x, fbar.y, (fbar.w * this.power) / MAX_POWER, fbar.h);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.strokeRect(fbar.x, fbar.y, fbar.w, fbar.h);
    ctx.fillStyle = PALETTE.cream;
    ctx.font = 'bold 13px Georgia, serif';
    ctx.fillText(`${Math.round(this.power)}`, fbar.x + fbar.w + 8, fbar.y + 11);
    ctx.font = '15px Georgia, serif';
    if (!compact) {
      ctx.fillStyle = PALETTE.cream;
      ctx.font = '15px Georgia, serif';
      ctx.fillText('Forca (clique/arraste)', 130, y + 54);
    }

    // Combustivel
    const fuelBar = this.fuelBarRect();
    if (!compact) {
      ctx.fillStyle = PALETTE.cream;
      ctx.fillText('Passos', 130, y + 82);
    }
    ctx.fillStyle = 'rgba(244,228,193,0.25)';
    ctx.fillRect(fuelBar.x, fuelBar.y, fuelBar.w, fuelBar.h);
    ctx.fillStyle = PALETTE.bottle;
    ctx.fillRect(fuelBar.x, fuelBar.y, (fuelBar.w * this.fuel) / JORBE_FUEL_PER_ROUND, fuelBar.h);

    // Armas — cartas com icone desenhado, clicaveis, nao so texto.
    WEAPONS.forEach((w, i) => {
      const card = this.weaponCardRect(i);
      // Escudo e um toggle a parte (armado/desarmado), nao uma "arma selecionada"
      // como as outras tres — usa a propria cor pra deixar essa diferenca clara.
      const active = w.defensive ? this.shieldArmed : i === this.weaponIdx;
      const activeColor = w.defensive ? '#6fb8d6' : PALETTE.crust;
      const ammo = this.ammo[w.id];
      const out = ammo !== null && ammo !== undefined && ammo <= 0;
      const narrow = card.w < 130;

      ctx.fillStyle = active ? activeColor : 'rgba(244,228,193,0.12)';
      ctx.beginPath();
      ctx.roundRect(card.x, card.y, card.w, card.h, 6);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.stroke();

      const iconColor = out ? 'rgba(217,164,65,0.3)' : w.color;
      const textColor = active ? INK : out ? 'rgba(244,228,193,0.35)' : PALETTE.cream;
      const ammoLabel = ammo === null || ammo === undefined ? 'infinita' : `${ammo}`;

      if (narrow) {
        drawWeaponIcon(ctx, w.id, card.x + card.w / 2, card.y + 20, 22, iconColor);
        ctx.textAlign = 'center';
        ctx.fillStyle = textColor;
        ctx.font = 'bold 12px Georgia, serif';
        ctx.fillText(`${i + 1}`, card.x + card.w / 2, card.y + 44);
        ctx.font = '11px Georgia, serif';
        ctx.fillText(this.fitText(ctx, ammoLabel, card.w - 8), card.x + card.w / 2, card.y + 57);
        ctx.textAlign = 'left';
      } else {
        drawWeaponIcon(ctx, w.id, card.x + 24, card.y + 31, 30, iconColor);
        ctx.fillStyle = textColor;
        ctx.font = 'bold 14px Georgia, serif';
        const nameMaxW = card.w - 48 - 6;
        ctx.fillText(this.fitText(ctx, `${i + 1}. ${w.name}`, nameMaxW), card.x + 48, card.y + 24);
        ctx.font = '13px Georgia, serif';
        const ammoText = ammo === null || ammo === undefined ? 'infinita' : `${ammo} restantes`;
        ctx.fillText(this.fitText(ctx, ammoText, nameMaxW), card.x + 48, card.y + 44);
      }
    });

    // Estado
    let status = '';
    if (this.phase === 'prep') {
      status = this.aimLocked ? 'Tiro travado. Aguardando os outros...' : 'A/D anda · SEGURE ESPACO';
    } else if (this.phase === 'resolve') status = 'Resolvendo a rodada...';
    else if (this.phase === 'interval') status = 'Fim da rodada';
    if (self && !self.alive) status = 'Voce foi eliminado — assistindo';

    if (!compact) {
      const wx = this.weaponCardRect(WEAPONS.length - 1).x + this.weaponCardRect(WEAPONS.length - 1).w;
      ctx.font = '15px Georgia, serif';
      ctx.fillStyle = PALETTE.crust;
      const statusMaxW = this.cam.viewW - wx - 20;
      ctx.fillText(this.fitText(ctx, status, statusMaxW), wx + 10, y + 40);
    } else {
      ctx.font = '13px Georgia, serif';
      ctx.fillStyle = PALETTE.crust;
      ctx.textAlign = 'center';
      ctx.fillText(status, this.cam.viewW / 2, y + 204);
      ctx.textAlign = 'left';
    }

    this.drawAimDragLine(ctx);

    if (this.banner && performance.now() < this.bannerUntil) {
      ctx.font = 'bold 34px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 5;
      ctx.strokeText(this.banner, this.cam.viewW / 2, 90);
      ctx.fillStyle = PALETTE.crust;
      ctx.fillText(this.banner, this.cam.viewW / 2, 90);
      ctx.textAlign = 'left';
    }

    if (this.phase === 'over' && this.finalResult) this.drawResults();
  }

  /**
   * Previsao da trajetoria do tiro atual — puramente cosmetica, roda so no
   * cliente com trigonometria normal (sem restricao de determinismo, porque
   * nunca vira estado de jogo real: o servidor sempre recalcula o tiro de
   * verdade com sua propria fisica na resolucao).
   */
  private computeAimPreview(): { x: number; y: number }[] | null {
    if (this.phase !== 'prep' || this.aimLocked || !this.terrain) return null;
    const self = this.players.get(this.ownId);
    if (!self || !self.alive) return null;

    const w = this.weapon;
    const rad = (this.aimAngle * Math.PI) / 180;
    const dirX = Math.cos(rad);
    const dirY = -Math.sin(rad);
    const muzzle = JORBE_HEIGHT * 0.55 + 6;

    let x = self.x + dirX * muzzle;
    let y = self.y - JORBE_HEIGHT / 2 + dirY * muzzle;
    const speed = Math.max(MIN_POWER, this.power) * POWER_TO_SPEED;
    let vx = dirX * speed;
    let vy = dirY * speed;

    const points: { x: number; y: number }[] = [{ x, y }];
    const dt = 1 / 30;
    for (let i = 0; i < 240; i++) {
      vy += GRAVITY * dt;
      vx += this.wind * w.windFactor * dt;
      x += vx * dt;
      y += vy * dt;
      points.push({ x, y });
      if (y > MAP_HEIGHT + 80 || x < -80 || x > MAP_WIDTH + 80) break;
      if (this.terrain.isSolid(Math.round(x), Math.round(y))) break;
    }
    return points.length > 1 ? points : null;
  }

  /** Faixa tracejada do estilingue, do Jorbe ate o ponto que o mouse esta puxando. */
  private drawAimDragLine(ctx: CanvasRenderingContext2D): void {
    if (!this.aimDragging || !this.dragPointer) return;
    const anchor = this.ownScreenAnchor();
    if (!anchor) return;

    ctx.save();
    ctx.strokeStyle = PALETTE.crust;
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(anchor.x, anchor.y);
    ctx.lineTo(this.dragPointer.x, this.dragPointer.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = PALETTE.red;
    ctx.beginPath();
    ctx.arc(this.dragPointer.x, this.dragPointer.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  /** Mostra quem ja travou o tiro nesta rodada — nunca o que cada um mirou. */
  private drawReadyPanel(ctx: CanvasRenderingContext2D, mm: { x: number; y: number; w: number; h: number }): void {
    if (this.phase !== 'prep') return;
    const humans = [...this.players.values()].filter((p) => p.alive && !p.isBot);
    if (humans.length === 0) return;

    const rowH = 22;
    const maxRows = 8;
    const shown = humans.slice(0, maxRows);
    const panelY = mm.y + mm.h + 10;
    const panelH = 30 + shown.length * rowH + (humans.length > maxRows ? rowH : 0);

    ctx.fillStyle = 'rgba(19,8,2,0.85)';
    ctx.fillRect(mm.x, panelY, mm.w, panelH);
    ctx.strokeStyle = PALETTE.crust;
    ctx.lineWidth = 2;
    ctx.strokeRect(mm.x, panelY, mm.w, panelH);

    const readyCount = humans.filter((p) => this.readyIds.has(p.id)).length;
    ctx.font = 'bold 13px Georgia, serif';
    ctx.fillStyle = readyCount === humans.length ? PALETTE.bottle : PALETTE.crust;
    ctx.fillText(`PRONTOS: ${readyCount}/${humans.length}`, mm.x + 8, panelY + 19);

    shown.forEach((p, i) => {
      const ready = this.readyIds.has(p.id);
      const ry = panelY + 38 + i * rowH;

      ctx.beginPath();
      ctx.arc(mm.x + 15, ry - 5, 6, 0, Math.PI * 2);
      ctx.fillStyle = ready ? PALETTE.bottle : 'rgba(244,228,193,0.18)';
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      if (ready) {
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(mm.x + 12, ry - 5);
        ctx.lineTo(mm.x + 14.5, ry - 2);
        ctx.lineTo(mm.x + 19, ry - 9);
        ctx.stroke();
      }

      ctx.font = '13px Georgia, serif';
      ctx.fillStyle = p.id === this.ownId ? PALETTE.crust : PALETTE.cream;
      ctx.fillText(p.nick.slice(0, 16), mm.x + 28, ry);
    });

    if (humans.length > maxRows) {
      ctx.font = 'italic 12px Georgia, serif';
      ctx.fillStyle = '#a08a63';
      ctx.fillText(`+${humans.length - maxRows} outros`, mm.x + 28, panelY + 38 + shown.length * rowH);
    }
  }

  private drawResults(): void {
    const ctx = this.ctx;
    const r = this.finalResult!;
    ctx.fillStyle = 'rgba(19,8,2,0.92)';
    ctx.fillRect(0, 0, this.cam.viewW, this.cam.viewH);

    ctx.textAlign = 'center';
    ctx.font = 'bold 42px Georgia, serif';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 4;
    ctx.strokeText('FIM DA GUERRA', this.cam.viewW / 2, 110);
    ctx.fillStyle = PALETTE.crust;
    ctx.fillText('FIM DA GUERRA', this.cam.viewW / 2, 110);

    ctx.font = '20px Georgia, serif';
    r.placements.slice(0, 10).forEach((p, i) => {
      ctx.fillStyle = i === 0 ? PALETTE.bottle : PALETTE.cream;
      const label = i === 0 ? `CAMPEAO — ${p.nick}` : `${p.placement}o — ${p.nick}`;
      ctx.fillText(label, this.cam.viewW / 2, 170 + i * 30);
    });

    ctx.font = '15px Georgia, serif';
    ctx.fillStyle = PALETTE.crust;
    ctx.fillText('pressione ESC para voltar ao lobby', this.cam.viewW / 2, this.cam.viewH - 60);
    ctx.textAlign = 'left';
  }

  private drawCenteredText(text: string, color: string): void {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.font = '20px Georgia, serif';
    ctx.fillStyle = color;
    ctx.fillText(text, this.cam.viewW / 2, this.cam.viewH / 2);
    ctx.textAlign = 'left';
  }

  private showBanner(text: string, ms: number): void {
    this.banner = text;
    this.bannerUntil = performance.now() + ms;
  }

  /** Usado pelo main para saber se deve mostrar o lobby por cima. */
  get isOver(): boolean {
    return this.phase === 'over';
  }

  get mapSize(): { w: number; h: number } {
    return { w: MAP_WIDTH, h: MAP_HEIGHT };
  }

  get maxHp(): number {
    return JORBE_MAX_HP;
  }
}
