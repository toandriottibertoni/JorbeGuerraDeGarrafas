import {
  EARLY_RESOLVE_GRACE_MS,
  JORBE_FUEL_PER_ROUND,
  JORBE_HEIGHT,
  JORBE_MAX_HP,
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
  type InputMessage,
  type MatchEnd,
  type MatchStart,
  type MoveInput,
  type Phase,
  type PlayerSnapshot,
  type Projectile,
  type ReadyState,
  type ResolutionPlan,
  type RoundPrep,
  type ShotInit,
  type SimEvent,
  type Snapshot,
} from '@jorbe/shared';

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

    for (const id of this.order) {
      const p = this.players.get(id)!;
      stepCharacter(this.terrain, p.char, p.input, dt, 0, events);
    }

    // Mesmo no preparo alguem pode andar pra fora do mapa e morrer.
    for (const e of events) {
      if (e.kind === 'death') this.noteDeath(e.playerId);
    }

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
        players,
        remaining,
      });
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

    this.sink.toAll('roundResolve', plan);
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

    if (alive.length <= 1) this.finish();
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
