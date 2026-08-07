import {
  CRATE_AMMO_REFILL,
  CRATE_HEAL_AMOUNT,
  CRATE_MAX_PER_INTERVAL,
  CRATE_MIN_PER_INTERVAL,
  CRATE_PICKUP_RADIUS,
  CRATE_WIDTH,
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
  WIND_MAX_DELTA,
  getWeapon,
  groundBelowSpan,
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
  /**
   * Estado da resolucao em andamento — processada aos poucos entre chamadas
   * de update() (ver `advanceResolve`) em vez de tudo numa chamada sincrona
   * so. Uma rodada caotica de 15 jogadores pode levar ate 1200 ticks pra
   * assentar; computar isso de uma vez travaria o event loop inteiro, o que
   * atrasa TODAS as salas do processo, nao so a que esta resolvendo.
   */
  private resolving: {
    chars: CharState[];
    shots: ShotInit[];
    projectiles: Projectile[];
    events: SimEvent[];
    shielded: string[];
    ticks: number;
  } | null = null;
  /** Teto de ticks simulados por chamada de update() — mantem cada chamada barata. */
  private static readonly RESOLVE_TICKS_PER_UPDATE = 60;
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
          shielded: false,
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
      if (timeUp || allReadyElapsed) this.beginResolve();
      return;
    }

    if (this.phase === 'resolve') {
      if (this.resolving) {
        // Ainda processando em lotes — so termina (e transmite o plano)
        // quando `resolving` virar null.
        this.advanceResolve();
        return;
      }
      if (this.phaseElapsedMs >= this.phaseDurationMs) this.beginInterval();
      return;
    }

    if (this.phase === 'interval') {
      if (this.phaseElapsedMs >= this.phaseDurationMs) this.beginPrep();
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

    p.aim = { angle, power, weaponId: weapon.id, fire: !!msg.fire, shield: !!msg.shield };
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
    // Passeio suave a partir do vento anterior — muda pouco a cada rodada em
    // vez de sortear do zero, que dava trocas bruscas e imprevisiveis.
    const delta = this.rng.range(-WIND_MAX_DELTA, WIND_MAX_DELTA);
    this.wind = Math.max(-WIND_MAX, Math.min(WIND_MAX, this.wind + delta));

    for (const p of this.players.values()) {
      p.aim = null;
      p.input = { ...NO_INPUT };
      p.char.fuel = JORBE_FUEL_PER_ROUND;
      // Escudo so protege a rodada em que foi ativado — precisa ativar de novo.
      p.char.shielded = false;
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
      // Travou o tiro: fica parado (mas continua caindo/assentando por
      // gravidade) ate cancelar — travar so a mira e deixar o movimento solto
      // permitia "atirar e fugir" com o combustivel que sobrava.
      const input = p.aim?.fire ? NO_INPUT : p.input;
      stepCharacter(this.terrain, p.char, input, dt, 0, events);
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
    // Armas de drop sao mais raras que uma recarga comum -- peso menor no sorteio.
    const ammoWeapons: string[] = [];
    for (const w of WEAPONS) {
      if (w.ammo === null) continue;
      const weight = w.dropOnly ? 1 : 3;
      for (let i = 0; i < weight; i++) ammoWeapons.push(w.id);
    }

    for (let i = 0; i < count; i++) {
      let placed = false;
      for (let guard = 0; guard < 30 && !placed; guard++) {
        const x = this.rng.int(margin, this.terrain.width - margin);
        // Largura toda, nao so a coluna central — senao a caixa nasce meio
        // enterrada quando cai numa ladeira (mesma armadilha do spawn do Jorbe).
        const y = groundBelowSpan(this.terrain, x, CRATE_WIDTH);
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

        this.applyCratePickup(crate, p.id);
        break;
      }
    }
  }

  /** Da o efeito do engradado (vida ou municao) a um jogador e tira a caixa do mapa. */
  private applyCratePickup(crate: CrateDef, playerId: string): void {
    const p = this.players.get(playerId);
    if (!p) return;

    if (crate.kind === 'health') {
      p.char.hp = Math.min(JORBE_MAX_HP, p.char.hp + CRATE_HEAL_AMOUNT);
    } else if (crate.weaponId) {
      const cur = p.ammo[crate.weaponId];
      if (cur !== null && cur !== undefined) p.ammo[crate.weaponId] = cur + CRATE_AMMO_REFILL;
    }

    this.crates = this.crates.filter((c) => c.id !== crate.id);
    this.sink.toAll('cratePicked', { id: crate.id, playerId, kind: crate.kind });
  }

  /**
   * Um tiro que estoura perto o suficiente de um engradado "acerta" ele —
   * quem atirou fica com o efeito, como se tivesse pego andando.
   */
  private claimCratesFromExplosions(shots: ShotInit[], events: SimEvent[]): void {
    if (this.crates.length === 0) return;

    const shotOwner = new Map<number, string>();
    for (const s of shots) shotOwner.set(s.id, s.ownerId);

    for (const e of events) {
      if (e.kind !== 'explosion' || this.crates.length === 0) continue;
      const ownerId = shotOwner.get(e.shotId);
      if (!ownerId) continue;

      for (const crate of [...this.crates]) {
        const dx = crate.x - e.x;
        const dy = crate.y - e.y;
        if (Math.sqrt(dx * dx + dy * dy) > e.radius) continue;
        // Evento sincronizado ao tick da explosao -- o cliente so estoura a
        // caixa visualmente quando o tiro de fato chega la na reproducao,
        // nao no instante (bem mais cedo) em que o servidor decide o resultado.
        events.push({
          kind: 'crateHit',
          tick: e.tick,
          crateId: crate.id,
          x: crate.x,
          y: crate.y,
          crateKind: crate.kind,
          playerId: ownerId,
        });
        this.applyCratePickup(crate, ownerId);
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
      this.applyAim(botId, { angle: shot.angle, power: shot.power, weaponId: weapon.id, fire: true, shield: false });
    }
  }

  // -------------------------------------------------------------------------
  // Fase de resolucao
  // -------------------------------------------------------------------------

  /** Monta os tiros a partir da mira de cada jogador — trabalho O(jogadores), barato o suficiente pra rodar de uma vez. */
  private beginResolve(): void {
    const chars = this.order.map((id) => this.players.get(id)!.char);
    const shots: ShotInit[] = [];
    const projectiles: Projectile[] = [];
    const shielded: string[] = [];

    // Ordem estavel: dois servidores com a mesma entrada produzem o mesmo plano.
    for (const id of this.order) {
      const p = this.players.get(id)!;
      const aim = p.aim;
      if (!aim || !aim.fire || !p.char.alive) continue;

      // Escudo e independente da arma escolhida — arma antes de processar o
      // tiro, pra proteger inclusive contra explosoes do proprio round.
      if (aim.shield) {
        const shieldAmmo = p.ammo.escudo;
        if (shieldAmmo === null || shieldAmmo === undefined || shieldAmmo > 0) {
          if (shieldAmmo !== null && shieldAmmo !== undefined) p.ammo.escudo = shieldAmmo - 1;
          p.char.shielded = true;
          shielded.push(p.id);
        }
      }

      // Seguranca: um cliente nunca deveria mandar uma arma defensiva como
      // arma de tiro (o escudo agora e ativado via `aim.shield`, nao aqui).
      if (getWeapon(aim.weaponId).defensive) continue;

      const ammo = p.ammo[aim.weaponId];
      if (ammo !== null && ammo !== undefined && ammo <= 0) continue;
      if (ammo !== null && ammo !== undefined) p.ammo[aim.weaponId] = ammo - 1;

      const speed = aim.power * POWER_TO_SPEED;
      // Unico ponto do jogo que usa cos/sin: o resultado ja viaja pronto no
      // plano, entao o cliente nunca precisa reproduzir essa conta.
      const rad = (aim.angle * Math.PI) / 180;
      const dirX = Math.cos(rad);
      const dirY = -Math.sin(rad);
      // Tiro mais vertical (perto de 90 graus, lance mais dificil/arriscado)
      // causa mais dano que um tiro rasteiro (perto de 0/180) — de 0.8x a
      // 1.3x, escalado por sin(angulo) que ja calculamos aqui do mesmo jeito.
      const angleBonus = 0.8 + 0.5 * Math.abs(dirY);

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
        angleBonus,
      });
    }

    this.phase = 'resolve';
    this.phaseElapsedMs = 0;
    this.resolving = { chars, shots, projectiles, events: [], shielded, ticks: 0 };
  }

  /**
   * Processa um lote limitado de ticks da resolucao em andamento — chamado a
   * cada update() enquanto `resolving` existir. So quando a fisica assentar
   * (ou bater no teto de seguranca) e que monta e transmite o plano final.
   */
  private advanceResolve(): void {
    const r = this.resolving;
    if (!r) return;

    const budget = Math.min(MatchEngine.RESOLVE_TICKS_PER_UPDATE, PHASE_RESOLVE_MAX_TICKS - r.ticks);
    for (let i = 0; i < budget; i++) {
      stepProjectiles(this.terrain, r.projectiles, r.chars, this.wind, TICK_DT, r.ticks, r.events);
      for (const c of r.chars) {
        stepCharacter(this.terrain, c, NO_INPUT, TICK_DT, r.ticks, r.events);
      }
      r.ticks++;
      if (simSettled(r.projectiles, r.chars) || r.ticks >= PHASE_RESOLVE_MAX_TICKS) {
        this.finishResolve();
        return;
      }
    }
  }

  /** Assentou (ou bateu o teto): monta o ResolutionPlan final e transmite pra sala. */
  private finishResolve(): void {
    const r = this.resolving;
    if (!r) return;
    this.resolving = null;

    for (const e of r.events) {
      if (e.kind === 'explosion') {
        this.carves.push({ x: e.x, y: e.y, r: getWeapon(e.weaponId).radius });
      } else if (e.kind === 'death') {
        this.noteDeath(e.playerId);
      }
    }
    this.claimCratesFromExplosions(r.shots, r.events);

    const plan: ResolutionPlan = {
      round: this.round,
      wind: this.wind,
      shots: r.shots,
      events: r.events,
      totalTicks: r.ticks,
      finalStates: r.chars.map((c) => ({
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
      shielded: r.shielded,
    };

    // O cliente reproduz o plano em tempo real; damos meio segundo de folga
    // para a animacao terminar antes de trocar de fase.
    this.phaseElapsedMs = 0;
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
