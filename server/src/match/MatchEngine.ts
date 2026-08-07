import {
  CRATE_AMMO_REFILL,
  CRATE_HEAL_AMOUNT,
  CRATE_MAX_PER_INTERVAL,
  CRATE_MIN_PER_INTERVAL,
  CRATE_PICKUP_RADIUS,
  EARLY_RESOLVE_GRACE_MS,
  JORBE_FUEL_PER_ROUND,
  JORBE_HEIGHT,
  JORBE_MAX_HP,
  JORBE_WIDTH,
  MAX_POWER,
  MIN_POWER,
  NO_INPUT,
  PHASE_INTERVAL_SECONDS,
  PHASE_RESOLVE_MAX_TICKS,
  POWER_TO_SPEED,
  Rng,
  SNAPSHOT_RATE,
  TICK_DT,
  Terrain,
  WEAPONS,
  WIND_MAX,
  getWeapon,
  pickSpawns,
  prepSecondsFor,
  simSettled,
  startingAmmo,
  stepCharacter,
  stepProjectiles,
  type AimMessage,
  type CarveOp,
  type CharState,
  type CrateDef,
  type CratePicked,
  type InputMessage,
  type MatchEnd,
  type MatchStart,
  type MoveInput,
  type Phase,
  type PlayerSnapshot,
  type PlayerStat,
  type Projectile,
  type ReadyState,
  type ResolutionPlan,
  type RoundPrep,
  type ShotInit,
  type SimEvent,
  type Snapshot,
} from '@jorbe/shared';
import { pickBotWeapon, solveBotShot } from './bot.js';

export interface MatchPlayerSeed {
  id: string;
  nick: string;
  isBot: boolean;
}

/**
 * Para onde o motor manda mensagem. Abstrair isso mantem o MatchEngine livre
 * do Socket.IO — e por isso ele pode ser testado por inteiro sem rede.
 */
export interface MatchSink {
  toAll<K extends keyof MatchOutbound>(event: K, payload: MatchOutbound[K]): void;
  toPlayer<K extends keyof MatchOutbound>(id: string, event: K, payload: MatchOutbound[K]): void;
  onFinished(result: MatchEnd): void;
}

export interface MatchOutbound {
  matchStart: MatchStart;
  roundPrep: RoundPrep;
  snapshot: Snapshot;
  roundReady: ReadyState;
  crates: CrateDef[];
  cratePicked: CratePicked;
  matchStats: PlayerStat[];
  roundResolve: ResolutionPlan;
  roundEnd: { round: number; alive: string[] };
  matchEnd: MatchEnd;
}

interface PlayerRuntime {
  id: string;
  nick: string;
  isBot: boolean;
  char: CharState;
  ammo: Record<string, number | null>;
  input: MoveInput;
  lastSeq: number;
  aim: AimMessage | null;
  /** Ordem de eliminacao: 0 = ainda vivo. */
  eliminatedAtRound: number;
}

/** Roteiro de um Jorbot pra rodada atual: quanto tempo anda e quando atira. */
interface BotPlan {
  walkDir: -1 | 0 | 1;
  walkUntilMs: number;
  fireAtMs: number;
  targetId: string | null;
  fired: boolean;
}

/**
 * Motor de uma partida: rodadas simultaneas com autoridade total no servidor.
 *
 * Ciclo de cada rodada:
 *   PREP     todos andam e miram ao mesmo tempo (servidor simula o movimento)
 *   RESOLVE  os tiros saem juntos; a fisica roda de uma vez e vira um plano
 *   INTERVAL respiro, checagem de vitoria, proxima rodada
 *
 * `update(dtMs)` e chamado por um timer externo — o motor nunca cria timers
 * proprios, o que permite roda-lo a jato dentro de um teste.
 */
export class MatchEngine {
  readonly mapId: string;
  readonly seed: number;
  readonly terrain: Terrain;

  private readonly sink: MatchSink;
  private readonly players = new Map<string, PlayerRuntime>();
  /** Ordem estavel de processamento — nunca dependa da ordem de um Map. */
  private readonly order: string[] = [];
  private readonly carves: CarveOp[] = [];
  private crates: CrateDef[] = [];
  private nextCrateId = 1;
  private readonly botRng: Rng;
  private readonly botPlans = new Map<string, BotPlan>();
  /** Dano causado e abates de cada jogador, acumulado a partida inteira. */
  private readonly matchStats = new Map<string, { damage: number; kills: number }>();
  private readonly rng: Rng;

  private phase: Phase = 'prep';
  private phaseElapsedMs = 0;
  private phaseDurationMs = 0;
  private snapshotAccMs = 0;
  private round = 0;
  private wind = 0;
  private nextShotId = 1;
  private eliminationOrder: string[] = [];
  private finished = false;
  /** Momento (relativo a phaseElapsedMs) em que todos ficaram prontos; null = ainda nao. */
  private allReadySince: number | null = null;

  constructor(mapId: string, seed: number, seeds: MatchPlayerSeed[], sink: MatchSink) {
    this.mapId = mapId;
    this.seed = seed;
    this.sink = sink;
    this.terrain = Terrain.generate(mapId, seed);
    this.rng = new Rng(seed ^ 0x9e37);
    this.botRng = new Rng(seed ^ 0xb0b);

    const spawns = pickSpawns(this.terrain, seeds.length, seed);

    seeds.forEach((s, i) => {
      const spawn = spawns[i] ?? { x: 200 + i * 60, y: 100 };
      this.players.set(s.id, {
        id: s.id,
        nick: s.nick,
        isBot: s.isBot,
        ammo: startingAmmo(),
        input: { ...NO_INPUT },
        lastSeq: 0,
        aim: null,
        eliminatedAtRound: 0,
        char: {
          id: s.id,
          x: spawn.x,
          y: spawn.y,
          vx: 0,
          vy: 0,
          onGround: false,
          facing: 1,
          hp: JORBE_MAX_HP,
          alive: true,
          fuel: JORBE_FUEL_PER_ROUND,
        },
      });
      this.order.push(s.id);
      this.matchStats.set(s.id, { damage: 0, kills: 0 });
    });
  }

  // -------------------------------------------------------------------------
  // Ciclo de vida
  // -------------------------------------------------------------------------

  start(): void {
    this.sink.toAll('matchStart', {
      mapId: this.mapId,
      seed: this.seed,
      players: this.order.map((id) => {
        const p = this.players.get(id)!;
        return { id: p.id, nick: p.nick, isBot: p.isBot, x: p.char.x, y: p.char.y, hp: p.char.hp };
      }),
      carves: [],
      crates: [],
    });
    this.beginPrep();
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Estado inicial para quem conecta com a partida ja em andamento. */
  catchUp(): MatchStart {
    return {
      mapId: this.mapId,
      seed: this.seed,
      players: this.order.map((id) => {
        const p = this.players.get(id)!;
        return { id: p.id, nick: p.nick, isBot: p.isBot, x: p.char.x, y: p.char.y, hp: p.char.hp };
      }),
      carves: this.carves.slice(),
      crates: this.crates.slice(),
    };
  }

  update(dtMs: number): void {
    if (this.finished) return;
    this.phaseElapsedMs += dtMs;

    if (this.phase === 'prep') {
      this.updatePrep(dtMs);
      const timeUp = this.phaseElapsedMs >= this.phaseDurationMs;
      const allReadyElapsed =
        this.allReadySince !== null && this.phaseElapsedMs - this.allReadySince >= EARLY_RESOLVE_GRACE_MS;
      // Todo mundo travou o tiro: nao faz sentido esperar o resto do timer.
      // A folga curta e so pra nao cortar seco assim que o ultimo trava.
      if (timeUp || allReadyElapsed) this.runResolve();
      return;
    }

    if (this.phase === 'resolve' || this.phase === 'interval') {
      if (this.phaseElapsedMs >= this.phaseDurationMs) {
        if (this.phase === 'resolve') this.beginInterval();
        else this.beginPrep();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Entrada dos jogadores
  // -------------------------------------------------------------------------

  applyInput(playerId: string, msg: InputMessage): void {
    const p = this.players.get(playerId);
    if (!p || !p.char.alive || this.phase !== 'prep') return;
    // Descarta pacote fora de ordem (UDP-like reordering do transporte).
    if (msg.seq <= p.lastSeq) return;
    p.lastSeq = msg.seq;
    p.input = { left: !!msg.left, right: !!msg.right, jump: !!msg.jump };
  }

  applyAim(playerId: string, msg: AimMessage): void {
    const p = this.players.get(playerId);
    if (!p || !p.char.alive || this.phase !== 'prep') return;

    // Validacao no servidor: cliente adulterado nao consegue angulo/forca fora
    // da faixa, nem arma que nao existe, nem municao que nao tem.
    const weapon = getWeapon(msg.weaponId);
    const angle = Number.isFinite(msg.angle) ? ((msg.angle % 360) + 360) % 360 : 45;
    const power = Number.isFinite(msg.power) ? Math.min(MAX_POWER, Math.max(MIN_POWER, msg.power)) : MIN_POWER;

    p.aim = { angle, power, weaponId: weapon.id, fire: !!msg.fire };
    this.recomputeReadiness();
  }

  removePlayer(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p || !p.char.alive) return;
    // Desconectar equivale a desistir: elimina sem dar a vitoria a ninguem.
    p.char.alive = false;
    p.char.hp = 0;
    this.eliminationOrder.push(playerId);
    this.recomputeReadiness();
  }

  /**
   * Recalcula e transmite quem ja travou o tiro. So conta jogadores HUMANOS
   * vivos — Jorbots nunca miram, entao exigir isso deles travaria a
   * resolucao antecipada pra sempre em qualquer sala com bot.
   */
  private recomputeReadiness(): void {
    if (this.phase !== 'prep') return;

    const humans = this.order
      .map((id) => this.players.get(id)!)
      .filter((p) => p.char.alive && !p.isBot);
    const ready = humans.filter((p) => p.aim?.fire).map((p) => p.id);

    this.sink.toAll('roundReady', { ready });

    if (humans.length > 0 && ready.length === humans.length) {
      if (this.allReadySince === null) this.allReadySince = this.phaseElapsedMs;
    } else {
      this.allReadySince = null;
    }
  }

  hasPlayer(playerId: string): boolean {
    return this.players.has(playerId);
  }

  // -------------------------------------------------------------------------
  // Fase de preparo
  // -------------------------------------------------------------------------

  private beginPrep(): void {
    this.round += 1;
    this.phase = 'prep';
    this.phaseElapsedMs = 0;
    this.snapshotAccMs = 0;
    this.allReadySince = null;

    const alive = this.alivePlayers();
    this.phaseDurationMs = prepSecondsFor(alive.length) * 1000;
    this.wind = this.rng.range(-WIND_MAX, WIND_MAX);

    for (const p of this.players.values()) {
      p.aim = null;
      p.input = { ...NO_INPUT };
      p.char.fuel = JORBE_FUEL_PER_ROUND;
    }

    this.planBotsForRound();

    for (const p of this.players.values()) {
      const prep: RoundPrep = {
        round: this.round,
        seconds: this.phaseDurationMs / 1000,
        wind: this.wind,
        fuel: p.char.fuel,
        ammo: { ...p.ammo },
      };
      this.sink.toPlayer(p.id, 'roundPrep', prep);
    }
    // Broadcast inicial: lista vazia, pra limpar o painel de prontidao de todo mundo.
    this.sink.toAll('roundReady', { ready: [] });
  }

  private updatePrep(dtMs: number): void {
    const events: SimEvent[] = [];
    const dt = dtMs / 1000;

    this.driveBots(dtMs);

    for (const id of this.order) {
      const p = this.players.get(id)!;
      stepCharacter(this.terrain, p.char, p.input, dt, 0, events);
    }

    // Mesmo no preparo alguem pode andar pra fora do mapa e morrer.
    for (const e of events) {
      if (e.kind === 'death') this.noteDeath(e.playerId);
    }

    this.checkCratePickups();

    this.snapshotAccMs += dtMs;
    const interval = 1000 / SNAPSHOT_RATE;
    if (this.snapshotAccMs >= interval) {
      this.snapshotAccMs = 0;
      this.broadcastSnapshot();
    }
  }

  private broadcastSnapshot(): void {
    const players: PlayerSnapshot[] = this.order.map((id) => {
      const c = this.players.get(id)!.char;
      return {
        id,
        x: c.x,
        y: c.y,
        vx: c.vx,
        vy: c.vy,
        onGround: c.onGround,
        facing: c.facing,
        hp: c.hp,
        alive: c.alive,
      };
    });

    const remaining = Math.max(0, (this.phaseDurationMs - this.phaseElapsedMs) / 1000);

    for (const p of this.players.values()) {
      this.sink.toPlayer(p.id, 'snapshot', {
        t: this.phaseElapsedMs,
        ackSeq: p.lastSeq,
        fuel: p.char.fuel,
        ammo: { ...p.ammo },
        players,
        remaining,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Engradados
  // -------------------------------------------------------------------------

  /** Sorteia 0-2 engradados em pontos jogaveis do mapa. Chamado a cada intervalo. */
  private spawnCrates(): void {
    this.crates = [];
    const count = this.rng.int(CRATE_MIN_PER_INTERVAL, CRATE_MAX_PER_INTERVAL);
    const margin = 150;
    const ammoWeapons = WEAPONS.filter((w) => w.ammo !== null).map((w) => w.id);

    for (let i = 0; i < count; i++) {
      let placed = false;
      for (let guard = 0; guard < 30 && !placed; guard++) {
        const x = this.rng.int(margin, this.terrain.width - margin);
        const y = this.terrain.groundBelow(x, 0);
        if (y >= this.terrain.height - 30) continue; // caiu numa faixa sem chao jogavel

        const kind: CrateDef['kind'] = this.rng.next() < 0.5 ? 'health' : 'ammo';
        const weaponId = kind === 'ammo' && ammoWeapons.length > 0 ? this.rng.pick(ammoWeapons) : undefined;
        this.crates.push({ id: this.nextCrateId++, x, y: y - 1, kind, weaponId });
        placed = true;
      }
    }

    this.sink.toAll('crates', this.crates.slice());
  }

  /** Um Jorbe encostou num engradado? Aplica o efeito e tira ele do mapa. */
  private checkCratePickups(): void {
    if (this.crates.length === 0) return;

    for (const crate of [...this.crates]) {
      for (const id of this.order) {
        const p = this.players.get(id)!;
        if (!p.char.alive) continue;
        const dx = Math.abs(p.char.x - crate.x);
        const dy = Math.abs(p.char.y - crate.y);
        if (dx > JORBE_WIDTH / 2 + CRATE_PICKUP_RADIUS || dy > JORBE_HEIGHT + CRATE_PICKUP_RADIUS) continue;

        if (crate.kind === 'health') {
          p.char.hp = Math.min(JORBE_MAX_HP, p.char.hp + CRATE_HEAL_AMOUNT);
        } else if (crate.weaponId) {
          const cur = p.ammo[crate.weaponId];
          if (cur !== null && cur !== undefined) p.ammo[crate.weaponId] = cur + CRATE_AMMO_REFILL;
        }

        this.crates = this.crates.filter((c) => c.id !== crate.id);
        this.sink.toAll('cratePicked', { id: crate.id, playerId: p.id, kind: crate.kind });
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Jorbots
  // -------------------------------------------------------------------------

  /** Sorteia o roteiro de cada Jorbot vivo pra rodada que esta comecando. */
  private planBotsForRound(): void {
    this.botPlans.clear();
    const bots = this.order.map((id) => this.players.get(id)!).filter((p) => p.isBot && p.char.alive);
    if (bots.length === 0) return;

    const humans = this.order.map((id) => this.players.get(id)!).filter((p) => !p.isBot && p.char.alive);

    for (const bot of bots) {
      // Prefere mirar em gente de verdade; so atira em outro bot se nao sobrar humano.
      const targets = humans.length > 0 ? humans : bots.filter((b) => b.id !== bot.id);
      const target = targets.length > 0 ? this.botRng.pick(targets) : null;

      const walkDir = this.botRng.pick([-1, 0, 1] as const);
      const walkUntilMs = this.botRng.range(400, Math.min(2600, this.phaseDurationMs * 0.4));
      // Atira numa janela do meio da rodada — nunca cedo demais (fica robotico
      // atirar instantaneamente) nem tarde demais (precisa de folga antes do fim).
      const earliest = walkUntilMs + 300;
      const latest = Math.max(earliest + 200, this.phaseDurationMs - 1200);
      const fireAtMs = this.botRng.range(earliest, latest);

      this.botPlans.set(bot.id, {
        walkDir,
        walkUntilMs,
        fireAtMs,
        targetId: target?.id ?? null,
        fired: false,
      });
    }
  }

  /** Aplica o roteiro dos bots a cada tick: anda um pouco, depois mira e atira uma vez. */
  private driveBots(dtMs: number): void {
    if (this.botPlans.size === 0) return;

    for (const [botId, plan] of this.botPlans) {
      const bot = this.players.get(botId);
      if (!bot || !bot.char.alive) continue;

      if (this.phaseElapsedMs < plan.walkUntilMs) {
        bot.input = { left: plan.walkDir < 0, right: plan.walkDir > 0, jump: false };
      } else if (bot.input.left || bot.input.right) {
        bot.input = { ...NO_INPUT };
      }

      if (plan.fired || this.phaseElapsedMs < plan.fireAtMs) continue;
      plan.fired = true;

      const target = plan.targetId ? this.players.get(plan.targetId) : null;
      if (!target || !target.char.alive) continue; // alvo morreu antes da hora — passa a vez.

      const weapon = pickBotWeapon(bot.ammo, this.botRng);
      const shot = solveBotShot(bot.char.x, bot.char.y, target.char.x, target.char.y, this.wind, this.botRng);
      this.applyAim(botId, { angle: shot.angle, power: shot.power, weaponId: weapon.id, fire: true });
    }
  }

  // -------------------------------------------------------------------------
  // Fase de resolucao
  // -------------------------------------------------------------------------

  private runResolve(): void {
    const plan = this.simulateResolution();

    this.phase = 'resolve';
    this.phaseElapsedMs = 0;
    // O cliente reproduz o plano em tempo real; damos meio segundo de folga
    // para a animacao terminar antes de trocar de fase.
    this.phaseDurationMs = (plan.totalTicks / 60) * 1000 + 500;

    this.attributeStats(plan);
    this.sink.toAll('roundResolve', plan);
    this.sink.toAll(
      'matchStats',
      [...this.matchStats.entries()].map(([playerId, s]) => ({ playerId, damage: s.damage, kills: s.kills })),
    );
  }

  /**
   * Credita dano/abates a quem atirou. So conta dano de explosao (fall/void
   * nao tem atirador) e nunca credita um "abate" de quem se explodiu sozinho
   * — isso e azar, nao habilidade.
   */
  private attributeStats(plan: ResolutionPlan): void {
    const shotOwner = new Map<number, string>();
    for (const s of plan.shots) shotOwner.set(s.id, s.ownerId);

    let lastOwner: string | null = null;
    for (const e of plan.events) {
      if (e.kind === 'explosion') {
        lastOwner = shotOwner.get(e.shotId) ?? null;
        continue;
      }
      if (!lastOwner || e.kind !== 'damage' && e.kind !== 'death') continue;
      if (e.cause !== 'blast') continue;

      if (e.kind === 'damage') {
        const stat = this.matchStats.get(lastOwner);
        if (stat) stat.damage += e.amount;
      } else if (e.playerId !== lastOwner) {
        const stat = this.matchStats.get(lastOwner);
        if (stat) stat.kills += 1;
      }
    }
  }

  private simulateResolution(): ResolutionPlan {
    const chars = this.order.map((id) => this.players.get(id)!.char);
    const shots: ShotInit[] = [];
    const projectiles: Projectile[] = [];

    // Ordem estavel: dois servidores com a mesma entrada produzem o mesmo plano.
    for (const id of this.order) {
      const p = this.players.get(id)!;
      const aim = p.aim;
      if (!aim || !aim.fire || !p.char.alive) continue;

      const ammo = p.ammo[aim.weaponId];
      if (ammo !== null && ammo !== undefined && ammo <= 0) continue;
      if (ammo !== null && ammo !== undefined) p.ammo[aim.weaponId] = ammo - 1;

      const speed = aim.power * POWER_TO_SPEED;
      // Unico ponto do jogo que usa cos/sin: o resultado ja viaja pronto no
      // plano, entao o cliente nunca precisa reproduzir essa conta.
      const rad = (aim.angle * Math.PI) / 180;
      const dirX = Math.cos(rad);
      const dirY = -Math.sin(rad);

      const muzzle = JORBE_HEIGHT * 0.55 + 6;
      const shot: ShotInit = {
        id: this.nextShotId++,
        ownerId: p.id,
        weaponId: aim.weaponId,
        x: p.char.x + dirX * muzzle,
        y: p.char.y - JORBE_HEIGHT / 2 + dirY * muzzle,
        vx: dirX * speed,
        vy: dirY * speed,
      };
      shots.push(shot);
      projectiles.push({
        id: shot.id,
        ownerId: shot.ownerId,
        weaponId: shot.weaponId,
        x: shot.x,
        y: shot.y,
        vx: shot.vx,
        vy: shot.vy,
        age: 0,
        dead: false,
      });
    }

    const events: SimEvent[] = [];
    let ticks = 0;
    for (; ticks < PHASE_RESOLVE_MAX_TICKS; ticks++) {
      stepProjectiles(this.terrain, projectiles, chars, this.wind, TICK_DT, ticks, events);
      for (const c of chars) {
        stepCharacter(this.terrain, c, NO_INPUT, TICK_DT, ticks, events);
      }
      if (simSettled(projectiles, chars)) break;
    }

    for (const e of events) {
      if (e.kind === 'explosion') {
        this.carves.push({ x: e.x, y: e.y, r: getWeapon(e.weaponId).radius });
      } else if (e.kind === 'death') {
        this.noteDeath(e.playerId);
      }
    }

    return {
      round: this.round,
      wind: this.wind,
      shots,
      events,
      totalTicks: ticks + 1,
      finalStates: chars.map((c) => ({
        id: c.id,
        x: c.x,
        y: c.y,
        vx: c.vx,
        vy: c.vy,
        onGround: c.onGround,
        facing: c.facing,
        hp: c.hp,
        alive: c.alive,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Intervalo e fim de partida
  // -------------------------------------------------------------------------

  private beginInterval(): void {
    this.phase = 'interval';
    this.phaseElapsedMs = 0;
    this.phaseDurationMs = PHASE_INTERVAL_SECONDS * 1000;

    const alive = this.alivePlayers();
    this.sink.toAll('roundEnd', { round: this.round, alive: alive.map((p) => p.id) });

    if (alive.length <= 1) {
      this.finish();
      return;
    }

    this.spawnCrates();
  }

  private noteDeath(playerId: string): void {
    if (this.eliminationOrder.includes(playerId)) return;
    const p = this.players.get(playerId);
    if (!p) return;
    p.eliminatedAtRound = this.round;
    this.eliminationOrder.push(playerId);
    // Uma morte durante o preparo (ex: andou pra fora do mapa) muda quem
    // conta pra prontidao — reavalia se os sobreviventes ja estao todos prontos.
    this.recomputeReadiness();
  }

  private alivePlayers(): PlayerRuntime[] {
    return this.order.map((id) => this.players.get(id)!).filter((p) => p.char.alive);
  }

  private finish(): void {
    this.finished = true;
    this.phase = 'over';

    const survivors = this.alivePlayers().map((p) => p.id);
    // Campeao primeiro; depois, quem morreu por ultimo fica melhor colocado.
    const ranked = [...survivors, ...[...this.eliminationOrder].reverse()];

    const result: MatchEnd = {
      placements: ranked.map((id, i) => {
        const p = this.players.get(id)!;
        return { id, nick: p.nick, placement: i + 1 };
      }),
    };

    this.sink.toAll('matchEnd', result);
    this.sink.onFinished(result);
  }
}
