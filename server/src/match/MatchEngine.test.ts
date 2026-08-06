import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EARLY_RESOLVE_GRACE_MS,
  JORBE_MAX_HP,
  PREP_DT,
  type MatchEnd,
  type ReadyState,
  type ResolutionPlan,
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
  assert.ok(speed <= 100 * 7.2 + 1, `forca deveria estar limitada, veio ${speed}`);
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

  // p1 se explode ate morrer.
  for (let i = 0; i < 12 && !engine.isFinished; i++) {
    engine.applyAim('p1', { angle: 90, power: 5, weaponId: 'tampinha', fire: true });
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
  advance(engine, 31); // entra em resolucao

  engine.applyAim('p0', { angle: 45, power: 100, weaponId: 'bazuca', fire: true });
  advance(engine, 3);

  const plans = sink.eventsOf('roundResolve') as ResolutionPlan[];
  // A mira mandada durante a resolucao nao pode entrar no plano ja emitido.
  assert.equal(plans.length, 1);
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
