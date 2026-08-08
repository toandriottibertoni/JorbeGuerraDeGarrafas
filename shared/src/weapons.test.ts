import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEAPONS, getWeapon, startingAmmo } from './weapons.js';

test('cada arma tem um id unico', () => {
  const ids = WEAPONS.map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length, 'ids duplicados quebram getWeapon e o inventario');
});

test('getWeapon acha todas as armas do catalogo pelo id', () => {
  for (const w of WEAPONS) {
    assert.equal(getWeapon(w.id), w);
  }
});

test('arma de drop comeca com 0 municao, nunca null nem um valor positivo', () => {
  const dropOnly = WEAPONS.filter((w) => w.dropOnly);
  assert.ok(dropOnly.length >= 10, `esperava pelo menos 10 armas de drop, achei ${dropOnly.length}`);
  for (const w of dropOnly) {
    assert.equal(w.ammo, 0, `${w.id}: arma de drop precisa comecar zerada, nao disponivel de cara`);
  }
});

test('inventario inicial nunca da carga de uma arma de drop de graca', () => {
  const inv = startingAmmo();
  for (const w of WEAPONS) {
    if (w.dropOnly) assert.equal(inv[w.id], 0);
  }
});
