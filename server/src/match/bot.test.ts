import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAP_HEIGHT, MAP_WIDTH, Mat, MAX_POWER, MIN_POWER, Rng, Terrain } from '@jorbe/shared';
import { pickBotWeapon, solveBotShot } from './bot.js';

/** Terreno plano o bastante pra testar mira sem depender de um mapa especifico. */
function flatTerrain(): Terrain {
  return Terrain.generate('fabrica', 1);
}

/** Terreno com dois niveis de chao bem definidos, pra testar mira em alvo elevado de verdade. */
function steppedTerrain(): Terrain {
  const t = new Terrain(MAP_WIDTH, MAP_HEIGHT);
  for (let x = 0; x < MAP_WIDTH; x++) {
    const groundY = x >= 1300 ? 300 : 550; // patamar elevado a partir de x=1300
    for (let y = groundY; y < MAP_HEIGHT; y++) t.data[t.index(x, y)] = Mat.DIRT;
  }
  return t;
}

test('alvo a direita produz angulo na metade direita (0-90)', () => {
  const t = flatTerrain();
  const shot = solveBotShot(t, 1000, 500, 1400, 500, 0, 1, new Rng(1));
  assert.ok(shot.angle >= 0 && shot.angle <= 100, `esperava angulo pra direita, veio ${shot.angle}`);
});

test('alvo a esquerda produz angulo espelhado (90-180)', () => {
  const t = flatTerrain();
  const shot = solveBotShot(t, 1000, 500, 600, 500, 0, 1, new Rng(1));
  assert.ok(shot.angle >= 80 && shot.angle <= 180, `esperava angulo pra esquerda, veio ${shot.angle}`);
});

test('angulo e forca sempre ficam dentro dos limites validos, em qualquer distancia', () => {
  const t = flatTerrain();
  const rng = new Rng(7);
  const cases: [number, number, number, number, number][] = [
    [0, 0, 10, 0, 0],
    [0, 0, MAP_WIDTH, 0, 30],
    [MAP_WIDTH, 0, 0, 0, -30],
    [0, 0, 100, MAP_HEIGHT - 100, 0],
    [0, MAP_HEIGHT - 100, 100, 0, 0],
    [0, 0, 0, 0, 0],
  ];
  for (const [fx, fy, tx, ty, wind] of cases) {
    const shot = solveBotShot(t, fx, fy, tx, ty, wind, 1, rng);
    assert.ok(shot.angle >= 0 && shot.angle <= 180, `angulo fora da faixa: ${shot.angle}`);
    assert.ok(shot.power >= MIN_POWER && shot.power <= MAX_POWER, `forca fora da faixa: ${shot.power}`);
    assert.ok(Number.isFinite(shot.angle) && Number.isFinite(shot.power), 'nao pode dar NaN/Infinity');
  }
});

test('alvo num patamar elevado de verdade pede um angulo mais fechado (mais vertical) que o mesmo alvo no nivel', () => {
  const t = steppedTerrain();
  // Mesma origem e mesma distancia horizontal (400px) pros dois casos -- so a
  // altura real do chao no alvo muda (nivel baixo vs patamar elevado de fato).
  const level = solveBotShot(t, 900, 545, 1300 - 1, 545, 0, 1, new Rng(3));
  const higher = solveBotShot(t, 900, 545, 900 + 400, 295, 0, 1, new Rng(3));
  assert.ok(higher.angle > level.angle, `alvo alto (${higher.angle}) deveria lobar mais que nivel (${level.angle})`);
});

test('mesma seed e mesmo terreno produzem o mesmo tiro (reprodutivel)', () => {
  const t = flatTerrain();
  const a = solveBotShot(t, 500, 400, 900, 380, 12, 1, new Rng(99));
  const b = solveBotShot(t, 500, 400, 900, 380, 12, 1, new Rng(99));
  assert.deepEqual(a, b);
});

test('bot so escolhe arma com municao disponivel', () => {
  const rng = new Rng(5);
  for (let i = 0; i < 20; i++) {
    const w = pickBotWeapon({ tampinha: null, bazuca: 0, granada: 0 }, rng);
    assert.equal(w.id, 'tampinha', 'com as outras zeradas, so pode escolher a infinita');
  }
});

test('bot tende a escolher a arma infinita com mais frequencia', () => {
  const rng = new Rng(11);
  let tampinhaCount = 0;
  const trials = 200;
  for (let i = 0; i < trials; i++) {
    const w = pickBotWeapon({ tampinha: null, bazuca: 4, granada: 3 }, rng);
    if (w.id === 'tampinha') tampinhaCount++;
  }
  assert.ok(tampinhaCount > trials * 0.3, `tampinha deveria aparecer com frequencia, veio ${tampinhaCount}/${trials}`);
});
