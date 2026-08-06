import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from './rateLimit.js';

test('libera ate o maximo e depois bloqueia', () => {
  const rl = new RateLimiter(3, 60_000);
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), false, 'quarta tentativa deveria estourar o limite');
});

test('chaves diferentes tem orcamentos independentes', () => {
  const rl = new RateLimiter(1, 60_000);
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('b'), true, 'chave "b" nao pode ser afetada pelo consumo de "a"');
  assert.equal(rl.allow('a'), false);
});

test('janela expira e libera de novo', async () => {
  const rl = new RateLimiter(1, 20);
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(rl.allow('a'), true, 'apos a janela passar, deveria liberar de novo');
});
