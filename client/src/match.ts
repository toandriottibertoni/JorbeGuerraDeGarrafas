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
  type ReadyState,
  type ResolutionPlan,
  type RoundPrep,
  type SimEvent,
  type Snapshot,
} from '@jorbe/shared';
import {
  Camera,
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
  /** Altura do painel inferior do HUD — geometria compartilhada por desenho e clique. */
  private static readonly HUD_H = 108;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cam = new Camera();
  private readonly particles = new Particles();
  private readonly shockwaves = new Shockwaves();
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
  /** O que valia na rodada anterior — vento, e meu ultimo angulo/forca ajustados. */
  private history: { wind: number; angle: number; power: number } | null = null;
  private crates: CrateDef[] = [];

  private playback: Playback | null = null;
  private playAcc = 0;

  private camFollowSelf = true;
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

    this.bindNet();
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
    });
    s.on('cratePicked', (data: CratePicked) => this.onCratePicked(data));
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
        rig: freshRig(p.hp, p.id),
      });
    }

    this.crates = data.crates;
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
    this.camFollowSelf = true;
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

      const landedNow = sp.onGround && !p.rig.wasOnGround;
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

    this.playback = { plan, tick: 0, eventIdx: 0, projectiles, lastBoom: null };
    this.camFollowSelf = false;
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
    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  detachControls(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('resize', this.onResize);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
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
    if (k === 'c') this.camFollowSelf = true;
    if (k >= '1' && k <= '9') this.selectWeapon(Number(k) - 1);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase();
    this.keys.delete(k);
    if (k === ' ' && this.charging) {
      this.charging = false;
      this.fire();
    }
  };

  /** Y do topo do painel inferior do HUD — usado tanto pra desenhar quanto pra testar clique. */
  private get hudY(): number {
    return this.cam.viewH - MatchScene.HUD_H;
  }

  private weaponCardRect(i: number): { x: number; y: number; w: number; h: number } {
    return { x: 400 + i * 158, y: this.hudY + 14, w: 150, h: 54 };
  }

  private forceBarRect(): { x: number; y: number; w: number; h: number } {
    return { x: 175, y: this.hudY + 38, w: 180, h: 12 };
  }

  private inRect(x: number, y: number, r: { x: number; y: number; w: number; h: number }): boolean {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  private selectWeapon(idx: number): void {
    if (this.aimLocked || idx >= WEAPONS.length) return;
    this.weaponIdx = idx;
    this.sendAim(false);
    sfx.sfxUiClick();
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
      x: self.x - this.cam.renderX,
      y: self.y - JORBE_HEIGHT * 0.55 - this.cam.renderY,
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

    if (canAdjust) {
      for (let i = 0; i < WEAPONS.length; i++) {
        if (this.inRect(e.clientX, e.clientY, this.weaponCardRect(i))) {
          this.selectWeapon(i);
          return;
        }
      }
      if (this.inRect(e.clientX, e.clientY, this.forceBarRect())) {
        this.forceDragging = true;
        this.setPowerFromClientX(e.clientX);
        return;
      }
      const anchor = this.ownScreenAnchor();
      if (anchor && Math.hypot(e.clientX - anchor.x, e.clientY - anchor.y) <= 46) {
        this.aimDragging = true;
        this.dragPointer = { x: e.clientX, y: e.clientY };
        this.applyAimDrag(e.clientX, e.clientY);
        return;
      }
    }

    this.dragging = true;
    this.camFollowSelf = false;
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
    this.dragging = false;
    this.lastPointer = null;
    this.forceDragging = false;
    this.aimDragging = false;
    this.dragPointer = null;
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
    });
  }

  private fire(): void {
    if (this.phase !== 'prep' || this.aimLocked || !this.canFire()) return;
    this.aimLocked = true;
    this.sendAim(true);
    this.showBanner('Tiro travado — aguardando a rodada', 1500);

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

    const jumpDown = this.keys.has('shift');
    if (jumpDown && !this.wasJumpKeyDown && self.onGround) {
      sfx.sfxJump();
      self.rig.squash.kick(220);
    }
    this.wasJumpKeyDown = jumpDown;

    const walking = self.onGround && (this.keys.has('a') || this.keys.has('d') || this.keys.has('arrowleft') || this.keys.has('arrowright'));
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
      const input: MoveInput = {
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
    }
  }

  private updateCamera(dt: number): void {
    if (this.dragging) return;

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

    if (this.camFollowSelf) {
      const self = this.players.get(this.ownId);
      if (self) this.cam.glideTo(self.x, self.y - 40, Math.min(1, dt * 6));
    }
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
    ctx.translate(-Math.round(this.cam.renderX), -Math.round(this.cam.renderY));

    ctx.drawImage(this.terrainRenderer.canvas, 0, 0);

    for (const crate of this.crates) {
      const weapon = crate.weaponId ? getWeapon(crate.weaponId) : null;
      drawCrate(ctx, crate.x, crate.y, crate.kind, crate.weaponId, weapon?.color ?? PALETTE.crust, this.clock * 1.4 + crate.id);
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
        squashY: p.rig.squash.value + idleBob,
        recoilX: p.rig.recoilX.value,
        recoilY: p.rig.recoilY.value,
        hitFlash: p.rig.hitFlash,
      };
      drawJorbe(ctx, {
        x: p.x,
        y: p.y,
        facing: p.facing,
        hp: p.hp,
        alive: p.alive,
        nick: p.nick,
        isSelf,
        aimAngle: isSelf && this.phase === 'prep' && p.alive ? this.aimAngle : null,
        aimPower: (Math.max(MIN_POWER, this.power) - MIN_POWER) / (MAX_POWER - MIN_POWER),
        anim: p.alive ? anim : { ...IDLE_ANIM, hitFlash: 0 },
      });
    }

    if (this.playback) {
      for (const p of this.playback.projectiles.values()) {
        this.drawProjectile(ctx, p);
      }
    }

    this.particles.draw(ctx);
    this.shockwaves.draw(ctx);
    ctx.restore();

    this.drawHud();
    if (this.phase !== 'over') drawWindIndicator(ctx, this.cam.viewW, this.wind, WIND_MAX);
    drawFilmOverlay(ctx, this.cam.viewW, this.cam.viewH, this.clock);
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
    const h = MatchScene.HUD_H;
    const y = this.hudY;
    ctx.fillStyle = 'rgba(19,8,2,0.88)';
    ctx.fillRect(0, y, this.cam.viewW, h);
    ctx.strokeStyle = PALETTE.crust;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(this.cam.viewW, y);
    ctx.stroke();

    ctx.font = '13px Georgia, serif';
    ctx.fillStyle = PALETTE.cream;

    // Tempo e rodada — pulsa e faz tique-taque nos ultimos segundos.
    ctx.save();
    ctx.font = 'bold 22px Georgia, serif';
    ctx.fillStyle = this.remaining < 6 ? PALETTE.red : PALETTE.crust;
    ctx.translate(18, y + 32);
    const pulseScale = 1 + this.tickPulse * 0.4;
    ctx.scale(pulseScale, pulseScale);
    ctx.fillText(`${Math.ceil(this.remaining)}s`, 0, 0);
    ctx.restore();
    ctx.font = '12px Georgia, serif';
    ctx.fillStyle = PALETTE.cream;
    ctx.fillText(`Rodada ${this.round}`, 18, y + 50);

    // Vento
    const windDir = this.wind > 0 ? '>>>' : '<<<';
    ctx.fillText(
      `Vento ${Math.abs(this.wind).toFixed(0)} ${Math.abs(this.wind) < 1 ? '--' : windDir}`,
      18,
      y + 70,
    );

    // Historico da rodada anterior — pra comparar antes de ajustar de novo.
    if (this.history) {
      const hDir = this.history.wind > 0 ? '>>>' : this.history.wind < 0 ? '<<<' : '--';
      ctx.font = 'italic 10px Georgia, serif';
      ctx.fillStyle = 'rgba(244,228,193,0.5)';
      ctx.fillText(
        `antes: vento ${Math.abs(this.history.wind).toFixed(0)} ${hDir} · ${this.history.angle.toFixed(0)}° · forca ${Math.round(this.history.power)}`,
        18,
        y + 90,
      );
      ctx.font = '13px Georgia, serif';
    }

    // Angulo e forca
    ctx.fillStyle = PALETTE.cream;
    ctx.fillText(`Angulo ${this.aimAngle.toFixed(0)} graus`, 130, y + 26);

    ctx.fillText('Forca (clique ou arraste)', 130, y + 48);
    const fbar = this.forceBarRect();
    ctx.fillStyle = 'rgba(244,228,193,0.25)';
    ctx.fillRect(fbar.x, fbar.y, fbar.w, fbar.h);
    ctx.fillStyle = this.power > 80 ? PALETTE.red : PALETTE.crust;
    ctx.fillRect(fbar.x, fbar.y, (fbar.w * this.power) / MAX_POWER, fbar.h);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.strokeRect(fbar.x, fbar.y, fbar.w, fbar.h);
    ctx.fillStyle = PALETTE.cream;
    ctx.font = 'bold 11px Georgia, serif';
    ctx.fillText(`${Math.round(this.power)}`, fbar.x + fbar.w + 6, fbar.y + 9);
    ctx.font = '13px Georgia, serif';

    // Combustivel
    ctx.fillStyle = PALETTE.cream;
    ctx.fillText('Passos', 130, y + 70);
    ctx.fillStyle = 'rgba(244,228,193,0.25)';
    ctx.fillRect(185, y + 60, 170, 10);
    ctx.fillStyle = PALETTE.bottle;
    ctx.fillRect(185, y + 60, (170 * this.fuel) / JORBE_FUEL_PER_ROUND, 10);

    // Armas — cartas com icone desenhado, clicaveis, nao so texto.
    WEAPONS.forEach((w, i) => {
      const card = this.weaponCardRect(i);
      const selected = i === this.weaponIdx;
      const ammo = this.ammo[w.id];
      const out = ammo !== null && ammo !== undefined && ammo <= 0;

      ctx.fillStyle = selected ? PALETTE.crust : 'rgba(244,228,193,0.12)';
      ctx.beginPath();
      ctx.roundRect(card.x, card.y, card.w, card.h, 6);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.stroke();

      drawWeaponIcon(ctx, w.id, card.x + 22, card.y + 27, 26, out ? 'rgba(217,164,65,0.3)' : w.color);

      ctx.fillStyle = selected ? INK : out ? 'rgba(244,228,193,0.35)' : PALETTE.cream;
      ctx.font = 'bold 12px Georgia, serif';
      ctx.fillText(`${i + 1}. ${w.name}`, card.x + 42, card.y + 20);
      ctx.font = '11px Georgia, serif';
      ctx.fillText(ammo === null || ammo === undefined ? 'infinita' : `${ammo} restantes`, card.x + 42, card.y + 38);
    });
    const wx = this.weaponCardRect(WEAPONS.length - 1).x + this.weaponCardRect(WEAPONS.length - 1).w;

    // Estado
    ctx.font = '13px Georgia, serif';
    ctx.fillStyle = PALETTE.crust;
    let status = '';
    if (this.phase === 'prep') {
      status = this.aimLocked ? 'Tiro travado. Aguardando os outros...' : 'A/D anda · W/S mira · SEGURE ESPACO';
    } else if (this.phase === 'resolve') status = 'Resolvendo a rodada...';
    else if (this.phase === 'interval') status = 'Fim da rodada';
    if (self && !self.alive) status = 'Voce foi eliminado — assistindo';
    ctx.fillText(status, wx + 10, y + 40);

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

    const rowH = 18;
    const maxRows = 8;
    const shown = humans.slice(0, maxRows);
    const panelY = mm.y + mm.h + 10;
    const panelH = 26 + shown.length * rowH + (humans.length > maxRows ? rowH : 0);

    ctx.fillStyle = 'rgba(19,8,2,0.85)';
    ctx.fillRect(mm.x, panelY, mm.w, panelH);
    ctx.strokeStyle = PALETTE.crust;
    ctx.lineWidth = 2;
    ctx.strokeRect(mm.x, panelY, mm.w, panelH);

    const readyCount = humans.filter((p) => this.readyIds.has(p.id)).length;
    ctx.font = 'bold 11px Georgia, serif';
    ctx.fillStyle = readyCount === humans.length ? PALETTE.bottle : PALETTE.crust;
    ctx.fillText(`PRONTOS: ${readyCount}/${humans.length}`, mm.x + 8, panelY + 16);

    shown.forEach((p, i) => {
      const ready = this.readyIds.has(p.id);
      const ry = panelY + 32 + i * rowH;

      ctx.beginPath();
      ctx.arc(mm.x + 14, ry - 4, 5, 0, Math.PI * 2);
      ctx.fillStyle = ready ? PALETTE.bottle : 'rgba(244,228,193,0.18)';
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      if (ready) {
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(mm.x + 11.5, ry - 4);
        ctx.lineTo(mm.x + 13.5, ry - 1.5);
        ctx.lineTo(mm.x + 17, ry - 7);
        ctx.stroke();
      }

      ctx.font = '11px Georgia, serif';
      ctx.fillStyle = p.id === this.ownId ? PALETTE.crust : PALETTE.cream;
      ctx.fillText(p.nick.slice(0, 16), mm.x + 26, ry);
    });

    if (humans.length > maxRows) {
      ctx.font = 'italic 10px Georgia, serif';
      ctx.fillStyle = '#a08a63';
      ctx.fillText(`+${humans.length - maxRows} outros`, mm.x + 26, panelY + 32 + shown.length * rowH);
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
