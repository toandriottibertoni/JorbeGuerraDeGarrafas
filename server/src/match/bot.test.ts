import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_POWER, MIN_POWER, Rng } from '@jorbe/shared';
import { pickBotWeapon, solveBotShot } from './bot.js';

test('alvo a direita produz angulo na metade direita (0-90)', () => {
  const shot = solveBotShot(1000, 500, 1400, 500, 0, new Rng(1));
  assert.ok(shot.angle >= 0 && shot.angle <= 100, `esperava angulo pra direita, veio ${shot.angle}`);
});

test('alvo a esquerda produz angulo espelhado (90-180)', () => {
  const shot = solveBotShot(1000, 500, 600, 500, 0, new Rng(1));
  assert.ok(shot.angle >= 80 && shot.angle <= 180, `esperava angulo pra esquerda, veio ${shot.angle}`);
});

test('angulo e forca sempre ficam dentro dos limites validos, em qualquer distancia', () => {
  const rng = new Rng(7);
  const cases: [number, number, number, number, number][] = [
    [0, 0, 10, 0, 0],
    [0, 0, 5000, 0, 30],
    [0, 0, -5000, 0, -30],
    [0, 0, 100, 900, 0],
    [0, 0, 100, -900, 0],
    [0, 0, 0, 0, 0],
  ];
  for (const [fx, fy, tx, ty, wind] of cases) {
    const shot = solveBotShot(fx, fy, tx, ty, wind, rng);
    assert.ok(shot.angle >= 0 && shot.angle <= 180, `angulo fora da faixa: ${shot.angle}`);
    assert.ok(shot.power >= MIN_POWER && shot.power <= MAX_POWER, `forca fora da faixa: ${shot.power}`);
    assert.ok(Number.isFinite(shot.angle) && Number.isFinite(shot.power), 'nao pode dar NaN/Infinity');
  }
});

test('alvo mais alto pede um angulo mais fechado (mais vertical) que o mesmo alvo no nivel', () => {
  const level = solveBotShot(1000, 500, 1400, 500, 0, new Rng(3));
  const higher = solveBotShot(1000, 500, 1400, 200, 0, new Rng(3));
  assert.ok(higher.angle > level.angle, `alvo alto (${higher.angle}) deveria lobar mais que nivel (${level.angle})`);
});

test('mesma seed produz o mesmo tiro (reprodutivel)', () => {
  const a = solveBotShot(500, 400, 900, 380, 12, new Rng(99));
  const b = solveBotShot(500, 400, 900, 380, 12, new Rng(99));
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
