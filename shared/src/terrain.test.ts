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

test('ponte: deck solido no meio, agua embaixo, rocha no fundo', () => {
  const t = Terrain.generate('ponte', 21);
  const midX = Math.floor(MAP_WIDTH / 2);

  // No centro do mapa (vao mais alto), o topo do deck precisa ser solido.
  const deckY = t.groundBelow(midX, 0);
  assert.ok(deckY < MAP_HEIGHT - 24, 'precisa achar o deck antes do piso de rocha');
  assert.equal(t.isSolid(midX, deckY), true, 'topo do deck deve ser solido');

  // Bem abaixo do deck (fora do alcance normal de queda), tem que haver rio.
  let foundWater = false;
  for (let y = deckY + 40; y < MAP_HEIGHT - 24; y++) {
    if (t.at(midX, y) === Mat.LIQUID) {
      foundWater = true;
      break;
    }
  }
  assert.ok(foundWater, 'precisa haver agua entre o deck e o piso de rocha');

  // O fundo continua indestrutivel feito nos outros mapas.
  assert.equal(t.at(midX, MAP_HEIGHT - 5), Mat.ROCK, 'fundo deve ser rocha');
});

test('ponte: os jogadores nascem sobre o deck, nao dentro da agua', () => {
  const t = Terrain.generate('ponte', 21);
  const spawns = pickSpawns(t, 8, 21);
  assert.equal(spawns.length, 8);
  const half = Math.floor(JORBE_WIDTH / 2);
  for (const s of spawns) {
    assert.notEqual(t.at(s.x, s.y + 2), Mat.LIQUID, 'nao pode nascer em cima da agua');
    // Perto do limite do vao central o deck tem uma leve quebra de inclinacao
    // (a parabola do arco encontra o trecho reto) -- por isso o teste aceita
    // qualquer coluna dentro da largura do corpo, igual ao teste de spawn dos
    // outros mapas, em vez de exigir solido exatamente no centro.
    let foundGroundNearby = false;
    for (let dx = -half; dx <= half; dx++) {
      const x = Math.max(0, Math.min(MAP_WIDTH - 1, s.x + dx));
      if (t.isSolid(x, s.y + 2)) foundGroundNearby = true;
    }
    assert.ok(foundGroundNearby, `deveria haver deck proximo sob o spawn em x=${s.x}`);
  }
});

test('pao de acucar: dois morros distintos com mar aberto entre eles', () => {
  const t = Terrain.generate('sugarloaf', 21);
  const midX = Math.floor(MAP_WIDTH / 2);

  // Entre os dois morros (perto do centro do mapa) o topo tem que ser mar
  // aberto, nao terra -- senao seria um unico morro largo, nao duas ilhas.
  let foundWater = false;
  for (let y = 0; y < MAP_HEIGHT - 24; y++) {
    if (t.at(midX, y) === Mat.LIQUID) {
      foundWater = true;
      break;
    }
  }
  assert.ok(foundWater, 'precisa haver mar aberto entre os dois morros');

  // O fundo continua indestrutivel feito nos outros mapas.
  assert.equal(t.at(midX, MAP_HEIGHT - 5), Mat.ROCK, 'fundo deve ser rocha');
});

test('pao de acucar: os jogadores nascem em alturas bem diferentes (terracos)', () => {
  const t = Terrain.generate('sugarloaf', 21);
  const spawns = pickSpawns(t, 12, 21);
  assert.ok(spawns.length >= 8, 'precisa caber varios jogadores nos dois morros');

  const ys = spawns.map((s) => s.y);
  const spread = Math.max(...ys) - Math.min(...ys);
  assert.ok(
    spread > 150,
    `terracos deveriam espalhar spawns em alturas bem diferentes, veio spread=${spread}`,
  );

  const half = Math.floor(JORBE_WIDTH / 2);
  for (const s of spawns) {
    assert.notEqual(t.at(s.x, s.y + 2), Mat.LIQUID, 'nao pode nascer em cima do mar');
    let foundGroundNearby = false;
    for (let dx = -half; dx <= half; dx++) {
      const x = Math.max(0, Math.min(MAP_WIDTH - 1, s.x + dx));
      if (t.isSolid(x, s.y + 2)) foundGroundNearby = true;
    }
    assert.ok(foundGroundNearby, `deveria haver chao proximo sob o spawn em x=${s.x}`);
  }
});

test('carve na ponte nao apaga o rio (agua nao vira ar)', () => {
  const t = Terrain.generate('ponte', 21);
  const midX = Math.floor(MAP_WIDTH / 2);
  let waterY = -1;
  for (let y = 0; y < MAP_HEIGHT; y++) {
    if (t.at(midX, y) === Mat.LIQUID) {
      waterY = y;
      break;
    }
  }
  assert.ok(waterY >= 0, 'precisa existir agua nessa coluna pro teste fazer sentido');

  t.carve({ x: midX, y: waterY, r: 40 });

  assert.equal(t.at(midX, waterY), Mat.LIQUID, 'estourar um tiro no rio nao pode transformar agua em ar');
});
