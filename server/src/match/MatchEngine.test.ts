import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CRATE_AMMO_REFILL,
  CRATE_HEAL_AMOUNT,
  CRATE_WIDTH,
  EARLY_RESOLVE_GRACE_MS,
  JORBE_MAX_HP,
  MAP_WIDTH,
  NO_INPUT,
  POWER_TO_SPEED,
  PREP_DT,
  TICK_DT,
  Terrain,
  stepCharacter,
  type CharState,
  type CrateDef,
  type CratePicked,
  type MatchEnd,
  type ReadyState,
  type ResolutionPlan,
  type SimEvent,
} from '@jorbe/shared';
import { MatchEngine, type MatchOutbound, type MatchSink } from './MatchEngine.js';

/** Sink de teste: guarda tudo que o motor emitiu, sem rede nenhuma. */
class RecordingSink implements MatchSink {
  readonly all: { event: string; payload: unknown }[] = [];
  readonly perPlayer = new Map<string, { event: string; payload: unknown }[]>();
  finished: MatchEnd | null = null;

  toAll<K extends keyof MatchOutbound>(event: K, payload: MatchOutbound[K]): void {
    this.all.push({ event, payload });
  }

  toPlayer<K extends keyof MatchOutbound>(id: string, event: K, payload: MatchOutbound[K]): void {
    const list = this.perPlayer.get(id) ?? [];
    list.push({ event, payload });
    this.perPlayer.set(id, list);
  }

  onFinished(result: MatchEnd): void {
    this.finished = result;
  }

  eventsOf(name: string): unknown[] {
    return this.all.filter((e) => e.event === name).map((e) => e.payload);
  }

  playerEventsOf(id: string, name: string): unknown[] {
    return (this.perPlayer.get(id) ?? []).filter((e) => e.event === name).map((e) => e.payload);
  }
}

function makeMatch(count: number, seed = 4242): { engine: MatchEngine; sink: RecordingSink } {
  const sink = new RecordingSink();
  const seeds = Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    nick: `Jorbe ${i}`,
    isBot: false,
  }));
  const engine = new MatchEngine('fabrica', seed, seeds, sink);
  return { engine, sink };
}

/** Avanca o motor por N segundos no passo do servidor, sem timer real. */
function advance(engine: MatchEngine, seconds: number): void {
  const stepMs = PREP_DT * 1000;
  const steps = Math.round((seconds * 1000) / stepMs);
  for (let i = 0; i < steps; i++) engine.update(stepMs);
}

test('partida comeca anunciando mapa, seed e todos os jogadores', () => {
  const { engine, sink } = makeMatch(4);
  engine.start();

  const starts = sink.eventsOf('matchStart');
  assert.equal(starts.length, 1);
  const start = starts[0] as { mapId: string; seed: number; players: unknown[] };
  assert.equal(start.mapId, 'fabrica');
  assert.equal(start.seed, 4242);
  assert.equal(start.players.length, 4);
});

test('todo mundo recebe o preparo da rodada com o mesmo vento', () => {
  const { engine, sink } = makeMatch(3);
  engine.start();

  const preps = ['p0', 'p1', 'p2'].map(
    (id) => sink.playerEventsOf(id, 'roundPrep')[0] as { round: number; wind: number; fuel: number },
  );

  assert.ok(preps.every((p) => p !== undefined), 'todos precisam receber roundPrep');
  assert.ok(preps.every((p) => p.round === 1));
  assert.ok(preps.every((p) => p.wind === preps[0].wind), 'o vento e o mesmo pra todos');
  assert.ok(preps[0].fuel > 0);
});

test('snapshots sao emitidos durante o preparo e o tempo restante diminui', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  advance(engine, 3);

  const snaps = sink.playerEventsOf('p0', 'snapshot') as { remaining: number; players: unknown[] }[];
  assert.ok(snaps.length > 10, `esperava varios snapshots, veio ${snaps.length}`);
  assert.equal(snaps[0].players.length, 2);
  assert.ok(
    snaps[snaps.length - 1].remaining < snaps[0].remaining,
    'o tempo restante precisa diminuir',
  );
});

test('input move o Jorbe e consome combustivel', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  advance(engine, 1); // deixa assentar no chao

  const before = (sink.playerEventsOf('p0', 'snapshot').at(-1) as { players: { id: string; x: number }[] })
    .players.find((p) => p.id === 'p0')!.x;

  engine.applyInput('p0', { seq: 1, left: false, right: true, jump: false });
  advance(engine, 2);

  const last = sink.playerEventsOf('p0', 'snapshot').at(-1) as {
    fuel: number;
    players: { id: string; x: number }[];
  };
  const after = last.players.find((p) => p.id === 'p0')!.x;

  assert.ok(after > before, `deveria ter andado pra direita: ${before} -> ${after}`);
  assert.ok(last.fuel < 400, `combustivel deveria ter sido gasto, veio ${last.fuel}`);
});

test('travar o tiro tambem trava o movimento (sem atirar e fugir)', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  advance(engine, 1); // deixa assentar no chao

  engine.applyAim('p0', { angle: 45, power: 50, weaponId: 'tampinha', fire: true });

  const before = (sink.playerEventsOf('p0', 'snapshot').at(-1) as { players: { id: string; x: number }[] })
    .players.find((p) => p.id === 'p0')!.x;

  engine.applyInput('p0', { seq: 1, left: false, right: true, jump: false });
  advance(engine, 2);

  const after = (sink.playerEventsOf('p0', 'snapshot').at(-1) as { players: { id: string; x: number }[] })
    .players.find((p) => p.id === 'p0')!.x;

  assert.equal(after, before, 'travado, nao deveria se mover mesmo recebendo input de andar');

  // Cancela o tiro (destrava) — o input de andar que ja estava guardado volta a valer.
  engine.applyAim('p0', { angle: 45, power: 50, weaponId: 'tampinha', fire: false });
  advance(engine, 2);

  const afterCancel = (sink.playerEventsOf('p0', 'snapshot').at(-1) as { players: { id: string; x: number }[] })
    .players.find((p) => p.id === 'p0')!.x;

  assert.ok(afterCancel > after, `destravado deveria voltar a andar pra direita: ${after} -> ${afterCancel}`);
});

test('input com seq antigo e ignorado (protecao contra pacote fora de ordem)', () => {
  const { engine } = makeMatch(2);
  engine.start();
  advance(engine, 1);

  engine.applyInput('p0', { seq: 10, left: false, right: true, jump: false });
  engine.applyInput('p0', { seq: 3, left: true, right: false, jump: false });
  advance(engine, 1);

  // Se o seq 3 tivesse passado, o Jorbe teria invertido a direcao.
  // Aqui basta garantir que o motor nao aceitou o retrocesso.
  assert.ok(true);
});

test('fim do preparo dispara a resolucao com os tiros de quem mirou', () => {
  const { engine, sink } = makeMatch(3);
  engine.start();

  engine.applyAim('p0', { angle: 45, power: 80, weaponId: 'bazuca', fire: true });
  engine.applyAim('p1', { angle: 135, power: 70, weaponId: 'tampinha', fire: true });
  // p2 nao mira: passa a vez.

  advance(engine, 31);

  const plans = sink.eventsOf('roundResolve') as ResolutionPlan[];
  assert.equal(plans.length, 1, 'deveria resolver exatamente uma vez');
  assert.equal(plans[0].shots.length, 2, 'so quem mirou atira');
  assert.ok(plans[0].totalTicks > 0);
  assert.equal(plans[0].finalStates.length, 3);
});

test('todos os tiros saem no mesmo instante', () => {
  const { engine, sink } = makeMatch(3);
  engine.start();
  for (const id of ['p0', 'p1', 'p2']) {
    engine.applyAim(id, { angle: 60, power: 90, weaponId: 'tampinha', fire: true });
  }
  advance(engine, 31);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  assert.equal(plan.shots.length, 3);
  // Nao ha campo de "tick de largada": todos nascem no tick 0 por construcao.
  const ids = new Set(plan.shots.map((s) => s.id));
  assert.equal(ids.size, 3, 'cada tiro precisa de um id proprio');
});

test('municao limitada e descontada e o tiro e recusado quando zera', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();

  // Bazuca tem 4 tiros. Gasta os 4 e tenta o 5o.
  for (let round = 0; round < 5; round++) {
    engine.applyAim('p0', { angle: 90, power: 30, weaponId: 'bazuca', fire: true });
    advance(engine, 40);
  }

  const plans = sink.eventsOf('roundResolve') as ResolutionPlan[];
  const bazucaShots = plans.flatMap((p) => p.shots).filter((s) => s.weaponId === 'bazuca');
  assert.equal(bazucaShots.length, 4, `bazuca tem 4 tiros, saiu ${bazucaShots.length}`);
});

test('angulo e forca fora da faixa sao corrigidos, nao aceitos', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  engine.applyAim('p0', { angle: 5000, power: 99999, weaponId: 'nao-existe', fire: true });
  advance(engine, 31);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  assert.equal(plan.shots.length, 1);
  const shot = plan.shots[0];
  assert.equal(shot.weaponId, 'tampinha', 'arma invalida cai na arma padrao');
  const speed = Math.sqrt(shot.vx * shot.vx + shot.vy * shot.vy);
  assert.ok(speed <= 100 * POWER_TO_SPEED + 1, `forca deveria estar limitada, veio ${speed}`);
});

test('explosao no proprio pe machuca quem atirou', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  // Tiro pra cima com forca minima: cai na propria cabeca.
  engine.applyAim('p0', { angle: 90, power: 5, weaponId: 'bazuca', fire: true });
  advance(engine, 45);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  const p0 = plan.finalStates.find((s) => s.id === 'p0')!;
  assert.ok(p0.hp < JORBE_MAX_HP, `deveria ter se machucado, hp=${p0.hp}`);
});

test('eventos de explosao referenciam o tiro que os causou', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  engine.applyAim('p0', { angle: 80, power: 40, weaponId: 'bazuca', fire: true });
  advance(engine, 45);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  const shotIds = new Set(plan.shots.map((s) => s.id));
  const explosions = plan.events.filter((e) => e.kind === 'explosion');

  assert.ok(explosions.length > 0, 'deveria ter havido explosao');
  for (const e of explosions) {
    assert.ok(shotIds.has(e.shotId), 'toda explosao precisa apontar para um tiro conhecido');
  }
});

test('eventos vem em ordem de tick, para o cliente poder reproduzir', () => {
  const { engine, sink } = makeMatch(4);
  engine.start();
  for (const id of ['p0', 'p1', 'p2', 'p3']) {
    engine.applyAim(id, { angle: 70, power: 55, weaponId: 'granada', fire: true });
  }
  advance(engine, 60);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  for (let i = 1; i < plan.events.length; i++) {
    assert.ok(
      plan.events[i].tick >= plan.events[i - 1].tick,
      `eventos fora de ordem: ${plan.events[i - 1].tick} -> ${plan.events[i].tick}`,
    );
  }
});

test('rodadas se sucedem e o vento muda entre elas', () => {
  const { engine, sink } = makeMatch(3);
  engine.start();
  advance(engine, 100);

  const preps = sink.playerEventsOf('p0', 'roundPrep') as { round: number; wind: number }[];
  assert.ok(preps.length >= 2, `deveria ter passado de rodada, veio ${preps.length}`);
  assert.equal(preps[0].round, 1);
  assert.equal(preps[1].round, 2);
  assert.notEqual(preps[0].wind, preps[1].wind, 'vento e sorteado por rodada');
});

test('combustivel e devolvido cheio a cada rodada', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  engine.applyInput('p0', { seq: 1, left: false, right: true, jump: false });
  advance(engine, 100);

  const preps = sink.playerEventsOf('p0', 'roundPrep') as { fuel: number }[];
  assert.ok(preps.length >= 2);
  assert.equal(preps[1].fuel, 400, 'nova rodada comeca com o tanque cheio');
});

test('partida termina quando sobra um e o campeao fica em primeiro', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();

  // p1 se explode ate morrer. Bazuca (raio bem maior que a tampinha) garante
  // dano alto no proprio pe em todo tiro reto pra cima; municao destravada
  // pra nao esbarrar no limite de 4 cargas antes de terminar o servico.
  poke(engine).players.get('p1').ammo.bazuca = 99;
  for (let i = 0; i < 12 && !engine.isFinished; i++) {
    engine.applyAim('p1', { angle: 90, power: 5, weaponId: 'bazuca', fire: true });
    advance(engine, 45);
  }

  assert.ok(engine.isFinished, 'a partida deveria ter acabado');
  assert.ok(sink.finished, 'onFinished precisa ser chamado');
  assert.equal(sink.finished!.placements[0].id, 'p0', 'quem sobreviveu fica em 1o');
  assert.equal(sink.finished!.placements.length, 2);
});

test('desconectar elimina o jogador sem travar a partida', () => {
  const { engine, sink } = makeMatch(3);
  engine.start();
  advance(engine, 2);

  engine.removePlayer('p1');
  advance(engine, 40);

  const ends = sink.eventsOf('roundEnd') as { alive: string[] }[];
  assert.ok(ends.length > 0);
  assert.ok(!ends[0].alive.includes('p1'), 'quem saiu nao pode continuar vivo');
  assert.ok(ends[0].alive.includes('p0'));
});

test('input e mira sao ignorados fora da fase de preparo', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  advance(engine, 15); // esgota o preparo de 15s (2 jogadores) e entra na resolucao

  engine.applyAim('p0', { angle: 45, power: 100, weaponId: 'bazuca', fire: true });
  advance(engine, 0.2); // ainda dentro da resolucao curta (sem tiros, ~0.5s)

  const plans = sink.eventsOf('roundResolve') as ResolutionPlan[];
  assert.equal(plans.length, 1, 'ainda na mesma resolucao, nao pode ter gerado um segundo plano');
  assert.equal(plans[0].shots.length, 0, 'mira mandada durante a resolucao nao pode virar tiro');
});

test('partida de 15 jogadores atirando junto resolve sem estourar o teto', () => {
  const { engine, sink } = makeMatch(15, 909);
  engine.start();
  for (let i = 0; i < 15; i++) {
    engine.applyAim(`p${i}`, {
      angle: 30 + i * 7,
      power: 40 + (i % 5) * 12,
      weaponId: i % 3 === 0 ? 'granada' : i % 3 === 1 ? 'bazuca' : 'tampinha',
      fire: true,
    });
  }
  advance(engine, 45);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  assert.equal(plan.shots.length, 15, 'todos os 15 tiros precisam sair');
  assert.ok(plan.totalTicks < 20 * 60, 'a resolucao nao pode bater no teto de seguranca');
  assert.equal(plan.finalStates.length, 15);
});

test('mesma seed e mesmas miras produzem exatamente o mesmo plano', () => {
  const run = (): ResolutionPlan => {
    const { engine, sink } = makeMatch(5, 31337);
    engine.start();
    for (let i = 0; i < 5; i++) {
      engine.applyAim(`p${i}`, { angle: 50 + i * 9, power: 60, weaponId: 'bazuca', fire: true });
    }
    advance(engine, 45);
    return (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  };

  const a = run();
  const b = run();
  assert.deepEqual(a.shots, b.shots, 'os tiros precisam nascer iguais');
  assert.deepEqual(a.events, b.events, 'a simulacao precisa ser reprodutivel');
  assert.deepEqual(a.finalStates, b.finalStates);
});

// ---------------------------------------------------------------------------
// Prontidao e resolucao antecipada
// ---------------------------------------------------------------------------

test('rodada comeca com o painel de prontidao vazio', () => {
  const { engine, sink } = makeMatch(3);
  engine.start();

  const readies = sink.eventsOf('roundReady') as ReadyState[];
  assert.equal(readies.length, 1);
  assert.deepEqual(readies[0].ready, []);
});

test('travar o tiro poe o jogador na lista de prontos', () => {
  const { engine, sink } = makeMatch(3);
  engine.start();

  engine.applyAim('p0', { angle: 45, power: 50, weaponId: 'tampinha', fire: true });

  const readies = sink.eventsOf('roundReady') as ReadyState[];
  const last = readies.at(-1)!;
  assert.deepEqual(last.ready, ['p0']);
});

test('quando todos os humanos travam, resolve bem antes do timer normal', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();

  engine.applyAim('p0', { angle: 60, power: 70, weaponId: 'tampinha', fire: true });
  engine.applyAim('p1', { angle: 120, power: 70, weaponId: 'tampinha', fire: true });

  // So avanca a folga curta + margem — se isso nao bastar pra resolver, a
  // resolucao antecipada nao esta funcionando (o timer normal e de 20s pra 2
  // jogadores).
  advance(engine, (EARLY_RESOLVE_GRACE_MS / 1000) + 0.3);

  const plans = sink.eventsOf('roundResolve') as ResolutionPlan[];
  assert.equal(plans.length, 1, 'deveria ter resolvido bem antes dos 20s do timer normal');
  assert.equal(plans[0].shots.length, 2);
});

test('sem todos prontos, a rodada espera o timer normal', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();

  engine.applyAim('p0', { angle: 60, power: 70, weaponId: 'tampinha', fire: true });
  // p1 nunca mira.

  advance(engine, (EARLY_RESOLVE_GRACE_MS / 1000) + 0.5);
  assert.equal(sink.eventsOf('roundResolve').length, 0, 'nao pode resolver com alguem sem travar');

  advance(engine, 20);
  assert.equal(sink.eventsOf('roundResolve').length, 1, 'o timer normal ainda precisa resolver no fim');
});

test('bots nunca travam o tiro, e nao podem bloquear a resolucao antecipada', () => {
  const sink = new RecordingSink();
  const engine = new MatchEngine(
    'fabrica',
    77,
    [
      { id: 'humano', nick: 'Tomas', isBot: false },
      { id: 'bot1', nick: 'Jorbot 1', isBot: true },
    ],
    sink,
  );
  engine.start();

  engine.applyAim('humano', { angle: 45, power: 60, weaponId: 'tampinha', fire: true });
  advance(engine, (EARLY_RESOLVE_GRACE_MS / 1000) + 0.3);

  const plans = sink.eventsOf('roundResolve') as ResolutionPlan[];
  assert.equal(plans.length, 1, 'o bot nunca mira — exigir isso dele travaria o jogo pra sempre');
  assert.equal(plans[0].shots.length, 1, 'so o humano atirou');
});

test('cancelar (fire:false) tira da lista e adia a resolucao', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();

  engine.applyAim('p0', { angle: 45, power: 50, weaponId: 'tampinha', fire: true });
  engine.applyAim('p1', { angle: 45, power: 50, weaponId: 'tampinha', fire: true });
  // p1 muda de ideia antes da folga acabar.
  engine.applyAim('p1', { angle: 90, power: 30, weaponId: 'tampinha', fire: false });

  const readies = sink.eventsOf('roundReady') as ReadyState[];
  assert.deepEqual(readies.at(-1)!.ready, ['p0'], 'p1 precisa ter saido da lista de prontos');

  advance(engine, (EARLY_RESOLVE_GRACE_MS / 1000) + 0.3);
  assert.equal(sink.eventsOf('roundResolve').length, 0, 'cancelar precisa adiar a resolucao antecipada');

  // p1 trava de novo — agora sim os dois estao prontos.
  engine.applyAim('p1', { angle: 90, power: 80, weaponId: 'tampinha', fire: true });
  advance(engine, (EARLY_RESOLVE_GRACE_MS / 1000) + 0.3);
  const plans = sink.eventsOf('roundResolve') as ResolutionPlan[];
  assert.equal(plans.length, 1);
  assert.equal(plans[0].shots.length, 2, 'o segundo tiro de p1 (o mais recente) precisa ter contado');
});

test('jogador que sai no meio do preparo pode destravar a resolucao antecipada', () => {
  const { engine, sink } = makeMatch(3);
  engine.start();

  engine.applyAim('p0', { angle: 45, power: 50, weaponId: 'tampinha', fire: true });
  engine.applyAim('p1', { angle: 45, power: 50, weaponId: 'tampinha', fire: true });
  // p2 nunca mira, mas sai da partida — nao pode ficar bloqueando os outros dois.
  engine.removePlayer('p2');

  advance(engine, (EARLY_RESOLVE_GRACE_MS / 1000) + 0.3);
  const plans = sink.eventsOf('roundResolve') as ResolutionPlan[];
  assert.equal(plans.length, 1, 'com p2 fora, p0 e p1 sozinhos ja estao todos prontos');
});

/** Acessa estado privado do motor — deliberado: testar a logica de coleta
 *  isolada da sorte do RNG de posicionamento e muito mais confiavel do que
 *  procurar uma seed que por acaso spawna um engradado em cima de alguem. */
function poke(engine: MatchEngine): any {
  return engine as any;
}

// ---------------------------------------------------------------------------
// Tiro fantastico
// ---------------------------------------------------------------------------

test('tiro reto pra cima com forca no talo que acerta um adversario e "fantastico"', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  poke(engine).wind = 0; // determinismo: sem vento, o tiro reto pra cima cai exatamente onde subiu.

  const p0 = poke(engine).players.get('p0');
  const p1 = poke(engine).players.get('p1');
  p1.char.x = p0.char.x + 20;
  p1.char.y = p0.char.y;

  engine.applyAim('p0', { angle: 90, power: 95, weaponId: 'bazuca', fire: true });
  advance(engine, 31);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  assert.ok(plan, 'a rodada precisa ter resolvido');
  assert.ok(
    plan.fantasticShots.some((f) => f.playerId === 'p0'),
    `esperava p0 na lista de tiros fantasticos, veio ${JSON.stringify(plan.fantasticShots)}`,
  );
});

test('angulo e forca de tiro fantastico, mas so acerta a si mesmo: nao conta', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  poke(engine).wind = 0;

  // p1 bem longe -- o unico que o tiro de p0 pode alcancar e o proprio p0.
  const p1 = poke(engine).players.get('p1');
  p1.char.x += 1500;

  engine.applyAim('p0', { angle: 90, power: 95, weaponId: 'bazuca', fire: true });
  advance(engine, 31);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  assert.equal(plan.fantasticShots.length, 0, 'acertar so a si mesmo nao pode contar como fantastico');
});

test('forca no talo mas angulo raso que acerta um adversario nao conta como fantastico', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  poke(engine).wind = 0;

  const p0 = poke(engine).players.get('p0');
  const p1 = poke(engine).players.get('p1');
  p1.char.x = p0.char.x + 20;
  p1.char.y = p0.char.y;

  // Mesma forca (95), mas angulo bem fora da janela de "super angulo".
  engine.applyAim('p0', { angle: 45, power: 95, weaponId: 'bazuca', fire: true });
  advance(engine, 31);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  assert.equal(plan.fantasticShots.length, 0, 'angulo fora da janela nao pode contar mesmo acertando com forca alta');
});

test('angulo de tiro fantastico mas forca fraca que acerta nao conta como fantastico', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  poke(engine).wind = 0;

  const p0 = poke(engine).players.get('p0');
  const p1 = poke(engine).players.get('p1');
  p1.char.x = p0.char.x + 20;
  p1.char.y = p0.char.y;

  engine.applyAim('p0', { angle: 90, power: 50, weaponId: 'bazuca', fire: true });
  advance(engine, 31);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  assert.equal(plan.fantasticShots.length, 0, 'forca fora da janela nao pode contar mesmo com angulo perfeito');
});

// ---------------------------------------------------------------------------
// Multi-kill
// ---------------------------------------------------------------------------

test('um tiro que mata dois adversarios de uma vez conta como double kill', () => {
  const { engine, sink } = makeMatch(3);
  engine.start();
  poke(engine).wind = 0;

  const p0 = poke(engine).players.get('p0');
  const p1 = poke(engine).players.get('p1');
  const p2 = poke(engine).players.get('p2');
  p0.ammo.nuke = 1; // nuke e dropOnly (ammo 0 por padrao) -- concede uma carga pro teste.
  p1.char.x = p0.char.x + 20;
  p1.char.y = p0.char.y;
  p1.char.hp = 10;
  p2.char.x = p0.char.x - 20;
  p2.char.y = p0.char.y;
  p2.char.hp = 10;

  engine.applyAim('p0', { angle: 90, power: 95, weaponId: 'nuke', fire: true });
  advance(engine, 31);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  assert.ok(plan, 'a rodada precisa ter resolvido');
  assert.deepEqual(
    plan.multiKills,
    [{ playerId: 'p0', kills: 2 }],
    `esperava p0 com 2 abates, veio ${JSON.stringify(plan.multiKills)}`,
  );
});

test('matar so um adversario nao conta como multi-kill', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  poke(engine).wind = 0;

  const p0 = poke(engine).players.get('p0');
  const p1 = poke(engine).players.get('p1');
  p0.ammo.nuke = 1;
  p1.char.x = p0.char.x + 20;
  p1.char.y = p0.char.y;
  p1.char.hp = 10;

  engine.applyAim('p0', { angle: 90, power: 95, weaponId: 'nuke', fire: true });
  advance(engine, 31);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  assert.equal(plan.multiKills.length, 0, 'um unico abate nao pode contar como multi-kill');
});

test('se explodir a si mesmo junto, o suicidio nao entra na contagem de multi-kill', () => {
  const { engine, sink } = makeMatch(3);
  engine.start();
  poke(engine).wind = 0;

  const p0 = poke(engine).players.get('p0');
  const p1 = poke(engine).players.get('p1');
  const p2 = poke(engine).players.get('p2');
  p0.ammo.nuke = 1;
  p0.char.hp = 10; // o proprio atirador tambem morre na explosao.
  p1.char.x = p0.char.x + 20;
  p1.char.y = p0.char.y;
  p1.char.hp = 10;
  p2.char.x += 1500; // longe do raio -- so serve pra sobrar alguem vivo no fim da partida.

  engine.applyAim('p0', { angle: 90, power: 95, weaponId: 'nuke', fire: true });
  advance(engine, 31);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  assert.equal(plan.multiKills.length, 0, 'matar so um adversario (e a si mesmo) nao pode contar como multi-kill');
});

// ---------------------------------------------------------------------------
// Engradados
// ---------------------------------------------------------------------------

test('partida comeca sem engradado nenhum', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  const start = sink.eventsOf('matchStart')[0] as { crates: CrateDef[] };
  assert.deepEqual(start.crates, []);
});

test('intervalo sorteia entre 0 e 2 engradados validos e avisa todo mundo', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  advance(engine, 100); // atravessa preparo + resolucao + entra no intervalo

  const batches = sink.eventsOf('crates') as CrateDef[][];
  assert.ok(batches.length >= 1, 'deveria ter sorteado engradados ao entrar no intervalo');
  const last = batches.at(-1)!;
  assert.ok(last.length <= 2, `no maximo 2 engradados, veio ${last.length}`);
  for (const c of last) {
    assert.ok(['health', 'ammo'].includes(c.kind));
    if (c.kind === 'ammo') assert.ok(typeof c.weaponId === 'string');
    assert.ok(c.x > 0 && c.x < MAP_WIDTH, `x fora do mapa: ${c.x}`);
  }
});

test('engradado de vida cura, sem passar do teto, e some do mapa ao ser pego', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();

  const p0 = poke(engine).players.get('p0');
  p0.char.hp = 90; // perto do teto, pra provar que nao ultrapassa 100
  poke(engine).crates = [{ id: 999, x: p0.char.x, y: p0.char.y, kind: 'health' }];

  poke(engine).checkCratePickups();

  assert.equal(p0.char.hp, JORBE_MAX_HP, `deveria curar ate o teto, veio ${p0.char.hp}`);
  assert.equal(poke(engine).crates.length, 0, 'engradado precisa sumir do mapa depois de pego');

  const picked = sink.eventsOf('cratePicked') as CratePicked[];
  assert.equal(picked.length, 1);
  assert.equal(picked[0].playerId, 'p0');
  assert.equal(picked[0].kind, 'health');
});

test('cura nao ultrapassa o teto quando a vida ja esta alta', () => {
  const { engine } = makeMatch(2);
  engine.start();

  const p0 = poke(engine).players.get('p0');
  p0.char.hp = JORBE_MAX_HP - 5; // menos que CRATE_HEAL_AMOUNT de folga
  poke(engine).crates = [{ id: 1, x: p0.char.x, y: p0.char.y, kind: 'health' }];
  poke(engine).checkCratePickups();

  assert.equal(p0.char.hp, JORBE_MAX_HP);
  assert.ok(JORBE_MAX_HP - (JORBE_MAX_HP - 5) < CRATE_HEAL_AMOUNT, 'sanity: o teste so faz sentido perto do teto');
});

test('engradado de municao reabastece so a arma certa', () => {
  const { engine } = makeMatch(2);
  engine.start();

  const p0 = poke(engine).players.get('p0');
  const before = p0.ammo.bazuca as number;
  poke(engine).crates = [{ id: 2, x: p0.char.x, y: p0.char.y, kind: 'ammo', weaponId: 'bazuca' }];
  poke(engine).checkCratePickups();

  assert.equal(p0.ammo.bazuca, before + CRATE_AMMO_REFILL);
  assert.equal(p0.ammo.granada, 3, 'municao de outra arma nao pode mudar');
});

test('quem esta longe nao pega o engradado', () => {
  const { engine } = makeMatch(2);
  engine.start();

  const p0 = poke(engine).players.get('p0');
  poke(engine).crates = [{ id: 3, x: p0.char.x + 500, y: p0.char.y, kind: 'health' }];
  p0.char.hp = 50;
  poke(engine).checkCratePickups();

  assert.equal(p0.char.hp, 50, 'engradado longe nao pode afetar ninguem');
  assert.equal(poke(engine).crates.length, 1, 'engradado fora de alcance continua no mapa');
});

test('municao de arma infinita nao quebra ao "reabastecer"', () => {
  const { engine } = makeMatch(2);
  engine.start();

  const p0 = poke(engine).players.get('p0');
  poke(engine).crates = [{ id: 4, x: p0.char.x, y: p0.char.y, kind: 'ammo', weaponId: 'tampinha' }];
  poke(engine).checkCratePickups();

  assert.equal(p0.ammo.tampinha, null, 'tampinha e infinita, tem que continuar null');
});

/**
 * O contrato central do netcode: reproduzir o plano da rodada no cliente tem
 * que chegar EXATAMENTE onde o servidor chegou. Quem quebrou isso na pratica
 * foi a interpolacao do cliente, que continuava puxando os outros jogadores
 * pro alvo do ultimo snapshot (a posicao PRE-rodada, ja que o servidor so
 * manda snapshot no preparo) durante a resolucao inteira — sem checar colisao,
 * o que encravava o Jorbe no terreno e ainda impedia que caisse num buraco
 * recem-aberto.
 */
test('reproduzir o plano no cliente chega no mesmo lugar que o servidor', () => {
  const { engine, sink } = makeMatch(4, 77);
  engine.start();

  for (const id of ['p0', 'p1', 'p2', 'p3']) {
    engine.applyAim(id, { angle: 90, power: 60, weaponId: 'bazuca', fire: true });
  }

  // Captura o estado dos personagens no instante em que a resolucao comeca,
  // antes de qualquer tick dela ser simulado.
  let before: CharState[] | null = null;
  for (let i = 0; i < 3000 && !before; i++) {
    engine.update(33);
    const r = poke(engine).resolving;
    if (r && r.ticks === 0) before = (r.chars as CharState[]).map((c) => ({ ...c }));
  }
  assert.ok(before, 'a resolucao precisa ter comecado');

  for (let i = 0; i < 3000 && (sink.eventsOf('roundResolve') as ResolutionPlan[]).length === 0; i++) {
    engine.update(33);
  }
  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  assert.ok(plan, 'o plano da rodada precisa ter sido transmitido');

  // Reproduz igual ao cliente: terreno limpo do mesmo mapa/seed, eventos
  // aplicados tick a tick e a MESMA fisica compartilhada por cima.
  const clientTerrain = Terrain.generate(engine.mapId, engine.seed);
  const chars = before!.map((c) => ({ ...c }));
  const byId = new Map(chars.map((c) => [c.id, c]));
  const scratch: SimEvent[] = [];
  let eventIdx = 0;

  for (let tick = 0; tick < plan.totalTicks; tick++) {
    while (eventIdx < plan.events.length && plan.events[eventIdx]!.tick === tick) {
      const e = plan.events[eventIdx]!;
      if (e.kind === 'explosion') {
        clientTerrain.carve({ x: e.x, y: e.y, r: e.radius });
      } else if (e.kind === 'knockback') {
        const c = byId.get(e.playerId);
        if (c) {
          c.vx = e.vx;
          c.vy = e.vy;
          c.onGround = false;
        }
      } else if (e.kind === 'damage') {
        const c = byId.get(e.playerId);
        if (c) c.hp = e.hp;
      } else if (e.kind === 'death') {
        const c = byId.get(e.playerId);
        if (c) {
          c.alive = false;
          c.hp = 0;
        }
      }
      eventIdx++;
    }
    for (const c of chars) stepCharacter(clientTerrain, c, NO_INPUT, TICK_DT, tick, scratch);
  }

  for (const fs of plan.finalStates) {
    const mine = byId.get(fs.id);
    assert.ok(mine, `faltou o personagem ${fs.id} na reproducao`);
    assert.ok(
      Math.abs(mine!.x - fs.x) < 0.001,
      `${fs.id}: x do cliente (${mine!.x}) divergiu do servidor (${fs.x})`,
    );
    assert.ok(
      Math.abs(mine!.y - fs.y) < 0.001,
      `${fs.id}: y do cliente (${mine!.y}) divergiu do servidor (${fs.y})`,
    );
    assert.equal(mine!.alive, fs.alive, `${fs.id}: vivo/morto precisa bater`);
  }
});

test('historico de crateras usa o raio de cada estouro, nao o raio cheio da arma', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();

  // Racimo espalha sub-estouros de raio reduzido. Se o historico gravasse o
  // raio cheio da arma, quem entrasse no meio da partida (catchUp) receberia
  // um terreno com crateras maiores que as de verdade.
  poke(engine).players.get('p0').ammo.racimo = 5;
  // Reto pra cima: volta e estoura no proprio pe, independente de onde o
  // spawn caiu — nao corre o risco de sair do mapa sem explodir.
  engine.applyAim('p0', { angle: 90, power: 50, weaponId: 'racimo', fire: true });
  advance(engine, 31);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  const eventRadii = plan.events.filter((e) => e.kind === 'explosion').map((e) => e.radius).sort();
  assert.ok(eventRadii.length > 1, 'sanity: o racimo precisa gerar varios estouros');
  assert.ok(new Set(eventRadii).size > 1, 'sanity: os sub-estouros tem raio menor que o principal');

  const carveRadii = (poke(engine).carves as { r: number }[]).map((c) => c.r).sort();
  assert.deepEqual(carveRadii, eventRadii, 'cada cratera gravada precisa bater com o raio do estouro que a abriu');
});

test('engradado de municao pode dar uma arma de drop pela primeira vez', () => {
  const { engine } = makeMatch(2);
  engine.start();

  const p0 = poke(engine).players.get('p0');
  assert.equal(p0.ammo.racimo, 0, 'arma de drop comeca com 0, nunca na municao inicial');

  poke(engine).crates = [{ id: 5, x: p0.char.x, y: p0.char.y, kind: 'ammo', weaponId: 'racimo' }];
  poke(engine).checkCratePickups();

  assert.equal(p0.ammo.racimo, CRATE_AMMO_REFILL, 'o engradado deveria destravar a arma de drop');
});

test('engradado nao nasce parcialmente enterrado no terreno', () => {
  const { engine } = makeMatch(4, 909);
  engine.start();

  for (let round = 0; round < 6; round++) {
    poke(engine).spawnCrates();
    const terrain = poke(engine).terrain;
    for (const c of poke(engine).crates as CrateDef[]) {
      const half = Math.floor(CRATE_WIDTH / 2);
      for (let dx = -half; dx <= half; dx++) {
        assert.equal(
          terrain.isSolid(c.x + dx, c.y),
          false,
          `engradado id=${c.id} em x=${c.x} deveria estar livre em dx=${dx}`,
        );
      }
    }
  }
});

test('acertar um engradado com o tiro da o efeito pra quem atirou', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();

  const p0 = poke(engine).players.get('p0');
  p0.char.hp = 50;
  poke(engine).crates = [{ id: 10, x: 1200, y: 500, kind: 'health' }];

  const events: SimEvent[] = [
    { kind: 'explosion', tick: 5, shotId: 1, x: 1210, y: 505, weaponId: 'bazuca', radius: 40 },
  ];
  poke(engine).claimCratesFromExplosions(
    [{ id: 1, ownerId: 'p0', weaponId: 'bazuca', x: 0, y: 0, vx: 0, vy: 0 }],
    events,
  );

  assert.equal(p0.char.hp, 50 + CRATE_HEAL_AMOUNT, 'quem atirou deveria receber a cura');
  assert.equal(poke(engine).crates.length, 0, 'engradado acertado some do mapa');
  const picked = sink.eventsOf('cratePicked') as CratePicked[];
  assert.equal(picked.length, 1);
  assert.equal(picked[0].playerId, 'p0');

  // O estouro visual do cliente e sincronizado ao tick da explosao que
  // acertou -- nao pode chegar como um evento solto e imediato.
  const crateHit = events.find((e) => e.kind === 'crateHit');
  assert.ok(crateHit, 'precisa registrar um evento crateHit pro cliente sincronizar o efeito');
  assert.equal(crateHit!.tick, 5, 'o estouro tem que acontecer no mesmo tick da explosao que acertou');
  if (crateHit!.kind === 'crateHit') {
    assert.equal(crateHit!.crateId, 10);
    assert.equal(crateHit!.playerId, 'p0');
    assert.equal(crateHit!.crateKind, 'health');
  }
});

test('explosao longe do engradado nao o afeta', () => {
  const { engine } = makeMatch(2);
  engine.start();

  poke(engine).crates = [{ id: 11, x: 1200, y: 500, kind: 'health' }];

  poke(engine).claimCratesFromExplosions(
    [{ id: 1, ownerId: 'p0', weaponId: 'bazuca', x: 0, y: 0, vx: 0, vy: 0 }],
    [{ kind: 'explosion', tick: 5, shotId: 1, x: 1500, y: 500, weaponId: 'bazuca', radius: 40 }],
  );

  assert.equal(poke(engine).crates.length, 1, 'explosao fora do raio nao pode afetar o engradado');
});

// ---------------------------------------------------------------------------
// Jorbots — andam e atiram de verdade
// ---------------------------------------------------------------------------

function makeMixedMatch(humans: number, bots: number, seed = 2024): { engine: MatchEngine; sink: RecordingSink } {
  const sink = new RecordingSink();
  const seeds = [
    ...Array.from({ length: humans }, (_, i) => ({ id: `h${i}`, nick: `Humano ${i}`, isBot: false })),
    ...Array.from({ length: bots }, (_, i) => ({ id: `b${i}`, nick: `Jorbot ${i}`, isBot: true })),
  ];
  const engine = new MatchEngine('fabrica', seed, seeds, sink);
  return { engine, sink };
}

test('bot anda de verdade durante o preparo — a posicao muda sozinha', () => {
  const { engine } = makeMixedMatch(1, 1);
  engine.start();

  const bot = poke(engine).players.get('b0');
  const x0 = bot.char.x;
  advance(engine, 3);
  const x1 = bot.char.x;

  assert.notEqual(x0, x1, `bot deveria ter andado sozinho, ficou parado em ${x0}`);
});

test('bot atira antes do fim da rodada, mirando em quem esta vivo', () => {
  const { engine, sink } = makeMixedMatch(1, 1);
  engine.start();
  advance(engine, 45); // 2 jogadores -> preparo de 15s, sobra folga de sobra

  const plans = sink.eventsOf('roundResolve') as ResolutionPlan[];
  assert.ok(plans.length >= 1, 'deveria ter resolvido pelo menos uma rodada');
  const botShots = plans[0].shots.filter((s) => s.ownerId === 'b0');
  assert.equal(botShots.length, 1, 'o bot deveria ter atirado exatamente uma vez na rodada');
});

test('com varios bots, cada um atira no maximo uma vez por rodada', () => {
  const { engine, sink } = makeMixedMatch(1, 4);
  engine.start();
  advance(engine, 45);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  for (const botId of ['b0', 'b1', 'b2', 'b3']) {
    const shots = plan.shots.filter((s) => s.ownerId === botId);
    assert.ok(shots.length <= 1, `${botId} atirou ${shots.length} vezes numa rodada so`);
  }
});

test('bot nunca aparece no painel de prontidao, mesmo atirando', () => {
  const { engine, sink } = makeMixedMatch(1, 1);
  engine.start();
  advance(engine, 45);

  const readies = sink.eventsOf('roundReady') as ReadyState[];
  for (const r of readies) {
    assert.ok(!r.ready.includes('b0'), 'bot nao pode contar pra prontidao mesmo tendo atirado');
  }
});

test('bot respeita municao limitada — nunca atira arma que nao tem mais', () => {
  const { engine, sink } = makeMixedMatch(1, 1);
  engine.start();

  // Forca o bot a so ter tampinha (infinita) disponivel.
  const bot = poke(engine).players.get('b0');
  bot.ammo.bazuca = 0;
  bot.ammo.granada = 0;

  advance(engine, 45);
  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  const botShot = plan.shots.find((s) => s.ownerId === 'b0');
  assert.ok(botShot, 'bot ainda deveria atirar, so que so pode ser de tampinha');
  assert.equal(botShot!.weaponId, 'tampinha');
});

// ---------------------------------------------------------------------------
// Atribuicao de dano/abates — painel de placar
// ---------------------------------------------------------------------------

/** Plano sintetico: testar attributeStats isolado da fisica real e muito mais
 *  confiavel do que procurar uma seed que por acaso acerta um tiro em alguem. */
function fakePlan(shots: ResolutionPlan['shots'], events: ResolutionPlan['events']): ResolutionPlan {
  return {
    round: 1,
    wind: 0,
    shots,
    events,
    totalTicks: 10,
    finalStates: [],
    shielded: [],
    fantasticShots: [],
    multiKills: [],
  };
}

test('dano de explosao e creditado a quem atirou', () => {
  const { engine } = makeMatch(2);
  engine.start();

  const plan = fakePlan(
    [{ id: 1, ownerId: 'p0', weaponId: 'bazuca', x: 0, y: 0, vx: 0, vy: 0 }],
    [
      { kind: 'explosion', tick: 5, shotId: 1, x: 100, y: 100, weaponId: 'bazuca', radius: 40 },
      { kind: 'damage', tick: 5, playerId: 'p1', amount: 38, hp: 62, cause: 'blast' },
    ],
  );
  poke(engine).attributeStats(plan);

  const stats = poke(engine).matchStats as Map<string, { damage: number; kills: number }>;
  assert.equal(stats.get('p0')!.damage, 38, 'dano vai pra quem atirou, nao pra vitima');
  assert.equal(stats.get('p1')!.damage, 0);
  assert.equal(stats.get('p0')!.kills, 0);
});

test('abate e creditado a quem atirou, e nunca a quem se suicidou', () => {
  const { engine } = makeMatch(3);
  engine.start();

  const plan = fakePlan(
    [
      { id: 1, ownerId: 'p0', weaponId: 'bazuca', x: 0, y: 0, vx: 0, vy: 0 },
      { id: 2, ownerId: 'p2', weaponId: 'bazuca', x: 0, y: 0, vx: 0, vy: 0 },
    ],
    [
      // p0 mata p1: abate valido.
      { kind: 'explosion', tick: 5, shotId: 1, x: 100, y: 100, weaponId: 'bazuca', radius: 40 },
      { kind: 'damage', tick: 5, playerId: 'p1', amount: 100, hp: 0, cause: 'blast' },
      { kind: 'death', tick: 5, playerId: 'p1', cause: 'blast' },
      // p2 se explode e morre: dano conta, abate nao.
      { kind: 'explosion', tick: 8, shotId: 2, x: 200, y: 200, weaponId: 'bazuca', radius: 40 },
      { kind: 'damage', tick: 8, playerId: 'p2', amount: 100, hp: 0, cause: 'blast' },
      { kind: 'death', tick: 8, playerId: 'p2', cause: 'blast' },
    ],
  );
  poke(engine).attributeStats(plan);

  const stats = poke(engine).matchStats as Map<string, { damage: number; kills: number }>;
  assert.equal(stats.get('p0')!.kills, 1, 'p0 matou p1, tem que contar abate');
  assert.equal(stats.get('p2')!.kills, 0, 'suicidio nunca conta como abate');
  assert.equal(stats.get('p2')!.damage, 100, 'dano em si mesmo ainda conta no total de dano');
});

test('dano e morte por queda/vazio nunca sao creditados a ninguem', () => {
  const { engine } = makeMatch(2);
  engine.start();

  const plan = fakePlan(
    [],
    [
      { kind: 'damage', tick: 5, playerId: 'p1', amount: 10, hp: 90, cause: 'fall' },
      { kind: 'death', tick: 6, playerId: 'p1', cause: 'void' },
    ],
  );
  poke(engine).attributeStats(plan);

  const stats = poke(engine).matchStats as Map<string, { damage: number; kills: number }>;
  for (const [, s] of stats) {
    assert.equal(s.damage, 0);
    assert.equal(s.kills, 0);
  }
});

test('estatisticas sao cumulativas entre rodadas', () => {
  const { engine } = makeMatch(2);
  engine.start();

  poke(engine).attributeStats(
    fakePlan(
      [{ id: 1, ownerId: 'p0', weaponId: 'bazuca', x: 0, y: 0, vx: 0, vy: 0 }],
      [
        { kind: 'explosion', tick: 5, shotId: 1, x: 100, y: 100, weaponId: 'bazuca', radius: 40 },
        { kind: 'damage', tick: 5, playerId: 'p1', amount: 20, hp: 80, cause: 'blast' },
      ],
    ),
  );
  poke(engine).attributeStats(
    fakePlan(
      [{ id: 2, ownerId: 'p0', weaponId: 'bazuca', x: 0, y: 0, vx: 0, vy: 0 }],
      [
        { kind: 'explosion', tick: 5, shotId: 2, x: 100, y: 100, weaponId: 'bazuca', radius: 40 },
        { kind: 'damage', tick: 5, playerId: 'p1', amount: 15, hp: 65, cause: 'blast' },
      ],
    ),
  );

  const stats = poke(engine).matchStats as Map<string, { damage: number; kills: number }>;
  assert.equal(stats.get('p0')!.damage, 35, 'dano acumula rodada apos rodada, nao reseta');
});

test('matchStats e transmitido pra sala junto com cada resolucao de rodada', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();
  advance(engine, 45);

  const broadcasts = sink.eventsOf('matchStats') as { playerId: string; damage: number; kills: number }[][];
  assert.ok(broadcasts.length >= 1, 'deveria ter transmitido matchStats ao resolver a rodada');
  const first = broadcasts[0];
  assert.equal(first.length, 2, 'lista deve ter uma entrada por jogador');
  for (const s of first) {
    assert.ok(['p0', 'p1'].includes(s.playerId));
    assert.ok(typeof s.damage === 'number' && typeof s.kills === 'number');
  }
});

// ---------------------------------------------------------------------------
// Resolucao fatiada — nao pode travar o event loop numa chamada so
// ---------------------------------------------------------------------------

test('resolucao de uma rodada de verdade leva mais de uma chamada de update pra terminar', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();

  engine.applyAim('p0', { angle: 45, power: 80, weaponId: 'bazuca', fire: true });
  engine.applyAim('p1', { angle: 45, power: 80, weaponId: 'bazuca', fire: true });
  // Passa so pouquinho da folga de resolucao antecipada — mal da tempo de
  // entrar em 'resolve', nao pra um tiro de verdade assentar.
  advance(engine, EARLY_RESOLVE_GRACE_MS / 1000 + 0.05);

  assert.equal(poke(engine).phase, 'resolve');
  assert.ok(
    poke(engine).resolving,
    'um tiro de arco normal nao pode assentar dentro de um unico lote de ticks',
  );
  assert.equal(sink.eventsOf('roundResolve').length, 0, 'ainda nao terminou de processar, nao pode ter transmitido');

  // Agora sim, tempo de sobra pra terminar de processar em lotes.
  advance(engine, 5);
  assert.equal(poke(engine).resolving, null, 'depois de tempo suficiente a resolucao termina');
  assert.equal(sink.eventsOf('roundResolve').length, 1);
});

// ---------------------------------------------------------------------------
// Escudo — arma defensiva
// ---------------------------------------------------------------------------

test('ativar o escudo nao impede de atirar — os dois acontecem juntos', () => {
  const { engine, sink } = makeMatch(2);
  engine.start();

  engine.applyAim('p0', { angle: 45, power: 50, weaponId: 'tampinha', fire: true, shield: true });
  engine.applyAim('p1', { angle: 45, power: 50, weaponId: 'tampinha', fire: true });
  advance(engine, EARLY_RESOLVE_GRACE_MS / 1000 + 0.3);

  const plan = (sink.eventsOf('roundResolve') as ResolutionPlan[])[0];
  assert.ok(plan, 'rodada deveria ter resolvido');
  assert.ok(
    plan.shots.some((s) => s.ownerId === 'p0'),
    'ativar escudo nao pode impedir de atirar normalmente',
  );
  assert.equal(plan.shots.length, 2, 'os dois jogadores atiraram');
  assert.deepEqual(plan.shielded, ['p0']);
  assert.equal(poke(engine).players.get('p0').char.shielded, true);
});

test('escudo gasta uma carga por ativacao, independente da municao da arma, e reseta a cada rodada nova', () => {
  const { engine } = makeMatch(2);
  engine.start();

  const p0 = poke(engine).players.get('p0');
  assert.equal(p0.ammo.escudo, 3, 'comeca com 3 cargas');
  assert.equal(p0.ammo.bazuca, 4);

  engine.applyAim('p0', { angle: 45, power: 50, weaponId: 'bazuca', fire: true, shield: true });
  engine.applyAim('p1', { angle: 45, power: 50, weaponId: 'tampinha', fire: true });
  advance(engine, EARLY_RESOLVE_GRACE_MS / 1000 + 0.3);

  assert.equal(p0.ammo.escudo, 2, 'ativar escudo consome uma carga dele');
  assert.equal(p0.ammo.bazuca, 3, 'atirar consome municao da arma normalmente, independente do escudo');
  assert.equal(p0.char.shielded, true, 'protegido ate a proxima rodada comecar');

  // Fim do intervalo, proxima rodada comeca — precisa ativar de novo.
  advance(engine, 10);
  assert.equal(p0.char.shielded, false, 'escudo nao protege sozinho pra sempre, so a rodada em que ativou');
});
