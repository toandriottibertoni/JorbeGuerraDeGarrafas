/**
 * Aleatoriedade deterministica.
 *
 * REGRA DE OURO DESTE ARQUIVO: nada aqui pode usar Math.random, Math.sin,
 * Math.cos, Math.pow ou qualquer funcao transcendental. A especificacao do
 * ECMAScript NAO garante o mesmo resultado para essas funcoes entre motores
 * diferentes (V8, SpiderMonkey, JavaScriptCore), mas garante bit-a-bit para
 * +, -, *, / e Math.floor (IEEE 754). Como cliente e servidor precisam gerar
 * exatamente o mesmo mapa a partir da mesma seed, so usamos aritmetica exata.
 */

/** Hash inteiro 1D -> uint32. */
export function hash1(x: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(seed | 0, 668265263);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash inteiro 2D -> uint32. */
export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 1103515245) + Math.imul(seed | 0, 668265263);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash 1D normalizado em [0, 1). */
export function hash1f(x: number, seed: number): number {
  return hash1(x, seed) / 4294967296;
}

/** Hash 2D normalizado em [0, 1). */
export function hash2f(x: number, y: number, seed: number): number {
  return hash2(x, y, seed) / 4294967296;
}

/** Curva suave 3t^2 - 2t^3 (so multiplicacao e subtracao — deterministica). */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Ruido de valor 1D com interpolacao suave. `scale` em pixels por celula. */
export function noise1(x: number, scale: number, seed: number): number {
  const p = x / scale;
  const i = Math.floor(p);
  const f = p - i;
  const a = hash1f(i, seed);
  const b = hash1f(i + 1, seed);
  const t = smooth(f);
  return a + (b - a) * t;
}

/** Ruido de valor 2D com interpolacao bilinear suave. */
export function noise2(x: number, y: number, scale: number, seed: number): number {
  const px = x / scale;
  const py = y / scale;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = smooth(px - ix);
  const fy = smooth(py - iy);
  const a = hash2f(ix, iy, seed);
  const b = hash2f(ix + 1, iy, seed);
  const c = hash2f(ix, iy + 1, seed);
  const d = hash2f(ix + 1, iy + 1, seed);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}

/**
 * Gerador sequencial deterministico (mulberry32). Usado onde a ordem importa:
 * sorteio de vento, posicao de spawn, queda de engradados.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Proximo float em [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Inteiro em [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Float em [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Escolhe um item do array. */
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
}
