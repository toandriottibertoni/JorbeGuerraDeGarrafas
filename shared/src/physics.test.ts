import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Terrain } from './terrain.js';
import {
  type CharState,
  type Projectile,
  type SimEvent,
  NO_INPUT,
  boxHits,
  explode,
  stepCharacter,
  stepProjectiles,
} from './physics.js';
import { JORBE_FUEL_PER_ROUND, JORBE_MAX_HP, MAP_HEIGHT, TICK_DT } from './constants.js';

function makeChar(id: string, x: number, y: number): CharState {
  return {
    id,
    x,
    y,
    vx: 0,
    vy: 0,
    onGround: true,
    facing: 1,
    hp: JORBE_MAX_HP,
    alive: true,
    fuel: JORBE_FUEL_PER_ROUND,
    shielded: false,
  };
}

/** Deixa o personagem assentar no chao antes do teste comecar. */
function settle(t: Terrain, c: CharState, ticks = 120): void {
  const ev: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) stepCharacter(t, c, NO_INPUT, TICK_DT, i, ev);
}

test('Jorbe cai e para no chao', () => {
  const t = Terrain.generate('praia', 5);
  const x = 900;
  const ground = t.groundBelow(x, 0);
  const c = makeChar('a', x, ground - 300);
  c.onGround = false;

  settle(t, c, 300);

  assert.ok(c.onGround, 'deveria ter pousado');
  assert.ok(Math.abs(c.y - (ground - 1)) < 3, `parou em y=${c.y}, esperado ~${ground - 1}`);
  assert.equal(boxHits(t, c.x, c.y), false, 'nao pode terminar dentro do terreno');
});

test('andar gasta combustivel e para quando acaba', () => {
  const t = Terrain.generate('praia', 5);
  const c = makeChar('a', 900, t.groundBelow(900, 0) - 1);
  settle(t, c);
  c.fuel = 40;
  const startX = c.x;

  const ev: SimEvent[] = [];
  for (let i = 0; i < 600; i++) {
    stepCharacter(t, c, { left: false, right: true, jump: false }, TICK_DT, i, ev);
  }

  assert.equal(c.fuel, 0, 'combustivel deveria zerar');
  const walked = Math.abs(c.x - startX);
  assert.ok(walked <= 41, `andou ${walked}px com 40 de combustivel`);
  assert.ok(walked > 30, `andou pouco demais: ${walked}px`);
});

test('sem combustivel o Jorbe nao anda', () => {
  const t = Terrain.generate('praia', 5);
  const c = makeChar('a', 900, t.groundBelow(900, 0) - 1);
  settle(t, c);
  c.fuel = 0;
  const startX = c.x;

  const ev: SimEvent[] = [];
  for (let i = 0; i < 120; i++) {
    stepCharacter(t, c, { left: false, right: true, jump: false }, TICK_DT, i, ev);
  }

  assert.equal(c.x, startX);
});

test('queda de muito alto machuca; queda curta nao', () => {
  const t = Terrain.generate('praia', 5);
  const x = 900;
  const ground = t.groundBelow(x, 0);

  const curta = makeChar('curta', x, ground - 30);
  curta.onGround = false;
  settle(t, curta, 300);
  assert.equal(curta.hp, JORBE_MAX_HP, 'queda curta nao pode machucar');

  const longa = makeChar('longa', x, ground - 700);
  longa.onGround = false;
  const ev: SimEvent[] = [];
  for (let i = 0; i < 400; i++) stepCharacter(t, longa, NO_INPUT, TICK_DT, i, ev);
  assert.ok(longa.hp < JORBE_MAX_HP, `queda longa deveria machucar, hp=${longa.hp}`);
  assert.ok(
    ev.some((e) => e.kind === 'damage' && e.cause === 'fall'),
    'deveria emitir evento de dano de queda',
  );
});

test('cair para fora do mapa mata na hora', () => {
  const t = Terrain.generate('praia', 5);
  const c = makeChar('a', 900, MAP_HEIGHT + 10);
  c.onGround = false;

  const ev: SimEvent[] = [];
  stepCharacter(t, c, NO_INPUT, TICK_DT, 0, ev);

  assert.equal(c.alive, false);
  assert.ok(ev.some((e) => e.kind === 'death' && e.cause === 'void'));
});

test('explosao causa mais dano no epicentro que na borda', () => {
  const t = Terrain.generate('praia', 5);
  const perto = makeChar('perto', 1000, 500);
  const longe = makeChar('longe', 1000 + 40, 500);
  const chars = [perto, longe];

  const p: Projectile = {
    id: 1,
    ownerId: 'x',
    weaponId: 'bazuca',
    x: 1000,
    y: 500 - 15,
    vx: 0,
    vy: 0,
    age: 0,
    dead: false, angleBonus: 1,
  };

  const ev: SimEvent[] = [];
  explode(t, p, chars, 0, ev);

  assert.ok(perto.hp < longe.hp, `epicentro ${perto.hp} deveria doer mais que borda ${longe.hp}`);
  assert.ok(longe.hp < JORBE_MAX_HP, 'quem esta no raio tambem toma dano');
  assert.ok(ev.some((e) => e.kind === 'explosion'));
});

test('angleBonus do projetil escala o dano da explosao', () => {
  const mk = (angleBonus: number): Projectile => ({
    id: 1,
    ownerId: 'x',
    weaponId: 'bazuca',
    x: 1000,
    y: 500 - 15,
    vx: 0,
    vy: 0,
    age: 0,
    dead: false,
    angleBonus,
  });

  const t1 = Terrain.generate('praia', 5);
  const alvoBaixo = makeChar('a', 1000, 500);
  explode(t1, mk(0.8), [alvoBaixo], 0, []);

  const t2 = Terrain.generate('praia', 5);
  const alvoAlto = makeChar('a', 1000, 500);
  explode(t2, mk(1.3), [alvoAlto], 0, []);

  const danoBaixo = JORBE_MAX_HP - alvoBaixo.hp;
  const danoAlto = JORBE_MAX_HP - alvoAlto.hp;
  assert.ok(danoAlto > danoBaixo, `angleBonus maior deveria doer mais: ${danoAlto} vs ${danoBaixo}`);
  // 1.3/0.8 = 1.625x — a mesma proporcao tem que aparecer no dano.
  assert.ok(Math.abs(danoAlto / danoBaixo - 1.3 / 0.8) < 0.05, `proporcao errada: ${danoAlto}/${danoBaixo}`);
});

test('explosao empurra o alvo para longe do centro', () => {
  const t = Terrain.generate('praia', 5);
  const c = makeChar('a', 1030, 500);
  const p: Projectile = {
    id: 1,
    ownerId: 'x',
    weaponId: 'bazuca',
    x: 1000,
    y: 500 - 15,
    vx: 0,
    vy: 0,
    age: 0,
    dead: false, angleBonus: 1,
  };

  explode(t, p, [c], 0, []);

  assert.ok(c.vx > 0, `alvo a direita do estouro deveria ser empurrado pra direita, vx=${c.vx}`);
  assert.equal(c.onGround, false, 'explosao tira o Jorbe do chao');
});

test('escudo bloqueia dano e empurrao da explosao por inteiro', () => {
  const t = Terrain.generate('praia', 5);
  const c = makeChar('a', 1030, 500);
  c.shielded = true;
  const p: Projectile = {
    id: 1,
    ownerId: 'x',
    weaponId: 'bazuca',
    x: 1000,
    y: 500 - 15,
    vx: 0,
    vy: 0,
    age: 0,
    dead: false, angleBonus: 1,
  };

  const ev: SimEvent[] = [];
  explode(t, p, [c], 0, ev);

  assert.equal(c.hp, JORBE_MAX_HP, 'escudo bloqueia todo o dano');
  assert.equal(c.vx, 0, 'escudo tambem bloqueia o empurrao');
  assert.equal(c.vy, 0);
  assert.equal(c.onGround, true, 'nem tira do chao');
  assert.ok(ev.some((e) => e.kind === 'blocked' && e.playerId === 'a'), 'precisa avisar que bloqueou');
  assert.ok(!ev.some((e) => e.kind === 'damage' || e.kind === 'knockback'), 'nao pode gerar dano nem empurrao');
});

test('explosao fora do raio nao encosta em ninguem', () => {
  const t = Terrain.generate('praia', 5);
  const c = makeChar('a', 1400, 500);
  const p: Projectile = {
    id: 1,
    ownerId: 'x',
    weaponId: 'tampinha',
    x: 1000,
    y: 500,
    vx: 0,
    vy: 0,
    age: 0,
    dead: false, angleBonus: 1,
  };

  explode(t, p, [c], 0, []);

  assert.equal(c.hp, JORBE_MAX_HP);
  assert.equal(c.vx, 0);
});

test('dano zera vida e emite morte uma unica vez', () => {
  const t = Terrain.generate('praia', 5);
  const c = makeChar('a', 1000, 500);
  c.hp = 5;

  const ev: SimEvent[] = [];
  const mk = (): Projectile => ({
    id: 1,
    ownerId: 'x',
    weaponId: 'bazuca',
    x: 1000,
    y: 485,
    vx: 0,
    vy: 0,
    age: 0,
    dead: false, angleBonus: 1,
  });

  explode(t, mk(), [c], 0, ev);
  explode(t, mk(), [c], 1, ev);

  assert.equal(c.alive, false);
  assert.equal(c.hp, 0);
  assert.equal(ev.filter((e) => e.kind === 'death').length, 1, 'morte nao pode duplicar');
});

test('projetil explode ao bater no terreno e abre cratera', () => {
  const t = Terrain.generate('praia', 5);
  const x = 1200;
  const ground = t.groundBelow(x, 0);
  const p: Projectile = {
    id: 1,
    ownerId: 'x',
    weaponId: 'tampinha',
    x,
    y: ground - 100,
    vx: 0,
    vy: 200,
    age: 0,
    dead: false, angleBonus: 1,
  };

  const ev: SimEvent[] = [];
  for (let i = 0; i < 200 && !p.dead; i++) {
    stepProjectiles(t, [p], [], 0, TICK_DT, i, ev);
  }

  assert.ok(p.dead, 'projetil deveria ter explodido');
  assert.ok(ev.some((e) => e.kind === 'explosion'));
  assert.equal(t.isSolid(x, ground + 2), false, 'deveria ter aberto cratera no chao');
});

test('dois projeteis que se cruzam no ar explodem juntos', () => {
  const t = Terrain.generate('praia', 5);
  const a: Projectile = {
    id: 1, ownerId: 'a', weaponId: 'tampinha',
    x: 1000, y: 300, vx: 120, vy: 0, age: 0, dead: false, angleBonus: 1,
  };
  const b: Projectile = {
    id: 2, ownerId: 'b', weaponId: 'tampinha',
    x: 1060, y: 300, vx: -120, vy: 0, age: 0, dead: false, angleBonus: 1,
  };

  const ev: SimEvent[] = [];
  for (let i = 0; i < 60 && !(a.dead && b.dead); i++) {
    stepProjectiles(t, [a, b], [], 0, TICK_DT, i, ev);
  }

  assert.ok(a.dead && b.dead, 'os dois tiros deveriam detonar no encontro');
  assert.equal(ev.filter((e) => e.kind === 'explosion').length, 2);
});

test('projetil nao explode no dono ao sair do cano', () => {
  const t = Terrain.generate('praia', 5);
  const dono = makeChar('dono', 1000, 400);
  const p: Projectile = {
    id: 1, ownerId: 'dono', weaponId: 'tampinha',
    x: 1000, y: 400 - 15, vx: 300, vy: -100, age: 0, dead: false, angleBonus: 1,
  };

  const ev: SimEvent[] = [];
  stepProjectiles(t, [p], [dono], 0, TICK_DT, 0, ev);

  assert.equal(p.dead, false, 'tiro nao pode detonar na cara de quem atirou');
  assert.equal(dono.hp, JORBE_MAX_HP);
});

test('vento empurra o projetil para o lado', () => {
  const t = Terrain.generate('praia', 5);
  const base = (wind: number): number => {
    const p: Projectile = {
      id: 1, ownerId: 'x', weaponId: 'bazuca',
      x: 1000, y: 200, vx: 0, vy: -50, age: 0, dead: false, angleBonus: 1,
    };
    for (let i = 0; i < 30; i++) stepProjectiles(t, [p], [], wind, TICK_DT, i, []);
    return p.x;
  };

  assert.ok(base(30) > base(0), 'vento positivo deveria levar o tiro pra direita');
  assert.ok(base(-30) < base(0), 'vento negativo deveria levar pra esquerda');
});

test('granada quica em vez de explodir no primeiro toque', () => {
  const t = Terrain.generate('praia', 5);
  const x = 1500;
  const ground = t.groundBelow(x, 0);
  const p: Projectile = {
    id: 1, ownerId: 'x', weaponId: 'granada',
    x, y: ground - 60, vx: 0, vy: 260, age: 0, dead: false, angleBonus: 1,
  };

  const ev: SimEvent[] = [];
  let bounced = false;
  for (let i = 0; i < 30; i++) {
    stepProjectiles(t, [p], [], 0, TICK_DT, i, ev);
    if (!p.dead && p.vy < 0) bounced = true;
  }

  assert.ok(bounced, 'granada deveria ter quicado (velocidade vertical invertida)');
  assert.equal(ev.filter((e) => e.kind === 'explosion').length, 0, 'nao explode ao tocar o chao');
});

test('granada detona sozinha quando o pavio acaba', () => {
  const t = Terrain.generate('praia', 5);
  const p: Projectile = {
    id: 1, ownerId: 'x', weaponId: 'granada',
    x: 1500, y: 200, vx: 0, vy: 0, age: 0, dead: false, angleBonus: 1,
  };

  const ev: SimEvent[] = [];
  for (let i = 0; i < 60 * 5 && !p.dead; i++) {
    stepProjectiles(t, [p], [], 0, TICK_DT, i, ev);
  }

  assert.ok(p.dead, 'pavio de 3s deveria detonar a granada');
  assert.ok(ev.some((e) => e.kind === 'explosion'));
});

test('simulacao inteira e reprodutivel a partir das mesmas condicoes', () => {
  const run = (): { x: number; y: number; hp: number } => {
    const t = Terrain.generate('fabrica', 777);
    const alvo = makeChar('alvo', 1200, t.groundBelow(1200, 0) - 1);
    const p: Projectile = {
      id: 1, ownerId: 'x', weaponId: 'bazuca',
      x: 1000, y: 300, vx: 180, vy: -120, age: 0, dead: false, angleBonus: 1,
    };
    const ev: SimEvent[] = [];
    for (let i = 0; i < 400; i++) {
      stepProjectiles(t, [p], [alvo], 12, TICK_DT, i, ev);
      stepCharacter(t, alvo, NO_INPUT, TICK_DT, i, ev);
    }
    return { x: alvo.x, y: alvo.y, hp: alvo.hp };
  };

  assert.deepEqual(run(), run(), 'mesma entrada precisa dar exatamente o mesmo resultado');
});
