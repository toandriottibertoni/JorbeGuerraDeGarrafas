import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Terrain, Mat, pickSpawns } from './terrain.js';
import { JORBE_WIDTH, MAP_HEIGHT, MAP_WIDTH } from './constants.js';

test('mesma seed gera terreno identico bit a bit', () => {
  const a = Terrain.generate('fabrica', 12345);
  const b = Terrain.generate('fabrica', 12345);
  assert.deepEqual(a.data, b.data, 'geracao precisa ser deterministica');
});

test('seeds diferentes geram terrenos diferentes', () => {
  const a = Terrain.generate('fabrica', 1);
  const b = Terrain.generate('fabrica', 2);
  assert.notDeepEqual(a.data, b.data);
});

test('mapas diferentes geram terrenos diferentes com a mesma seed', () => {
  const a = Terrain.generate('fabrica', 99);
  const b = Terrain.generate('deposito', 99);
  assert.notDeepEqual(a.data, b.data);
});

test('terreno tem ar em cima e solido embaixo', () => {
  const t = Terrain.generate('praia', 7);
  assert.equal(t.at(MAP_WIDTH / 2, 5), Mat.AIR, 'topo do mapa deve ser ceu');
  assert.equal(t.at(MAP_WIDTH / 2, MAP_HEIGHT - 5), Mat.ROCK, 'fundo deve ser rocha');
});

test('carve abre cratera e respeita o raio', () => {
  const t = Terrain.generate('fabrica', 3);
  const x = 1000;
  const y = t.groundBelow(x, 0) + 30;
  assert.ok(t.isSolid(x, y), 'ponto de teste deveria comecar solido');

  t.carve({ x, y, r: 40 });

  assert.equal(t.isSolid(x, y), false, 'centro da cratera deve virar ar');
  assert.equal(t.isSolid(x, y - 39), false, 'dentro do raio deve virar ar');
  // Bem fora do raio nao pode ter sido tocado.
  assert.ok(t.at(x, y - 80) !== Mat.AIR || t.at(x, y + 80) !== Mat.AIR);
});

test('rocha do fundo resiste a explosao', () => {
  const t = Terrain.generate('fabrica', 3);
  const y = MAP_HEIGHT - 5;
  t.carve({ x: 500, y, r: 60 });
  assert.equal(t.at(500, y), Mat.ROCK, 'rocha nao pode ser destruida');
});

test('carve marca retangulo sujo para o renderizador', () => {
  const t = Terrain.generate('fabrica', 3);
  t.consumeDirty();
  t.carve({ x: 300, y: Math.floor(MAP_HEIGHT * 0.74), r: 20 });
  const dirty = t.consumeDirty();
  assert.equal(dirty.length, 1);
  assert.equal(dirty[0].x0, 280);
  assert.equal(dirty[0].x1, 320);
  assert.equal(t.consumeDirty().length, 0, 'consumir deve limpar a lista');
});

test('spawns ficam sobre o solo, dentro do mapa e sem empilhar', () => {
  const t = Terrain.generate('fabrica', 42);
  const spawns = pickSpawns(t, 15, 42);

  assert.equal(spawns.length, 15, 'precisa caber 15 jogadores');
  const half = Math.floor(JORBE_WIDTH / 2);
  for (const s of spawns) {
    assert.ok(s.x > 0 && s.x < MAP_WIDTH, 'spawn dentro do mapa');

    let foundGroundNearby = false;
    for (let dx = -half; dx <= half; dx++) {
      const x = Math.max(0, Math.min(MAP_WIDTH - 1, s.x + dx));
      // Corpo inteiro tem que nascer livre — nao so a coluna central — senao
      // ladeiras deixam parte do Jorbe sobrepondo terreno solido.
      assert.equal(t.isSolid(x, s.y), false, `corpo do spawn deveria estar livre em x=${x}`);
      if (t.isSolid(x, s.y + 2)) foundGroundNearby = true;
    }
    assert.ok(foundGroundNearby, `deveria haver chao proximo sob o spawn em x=${s.x}`);
  }

  const sorted = [...spawns].sort((a, b) => a.x - b.x);
  for (let i = 1; i < sorted.length; i++) {
    assert.notEqual(sorted[i].x, sorted[i - 1].x, 'dois Jorbes nao nascem no mesmo x');
  }
});

test('mesma seed gera os mesmos spawns', () => {
  const t = Terrain.generate('fabrica', 8);
  assert.deepEqual(pickSpawns(t, 8, 8), pickSpawns(t, 8, 8));
});
