import { noise1, noise2, Rng } from './rng.js';
import { JORBE_WIDTH, MAP_HEIGHT, MAP_WIDTH } from './constants.js';

/** Material de cada pixel do mapa. */
export const Mat = {
  AIR: 0,
  DIRT: 1,
  ROCK: 2,
  LIQUID: 3,
} as const;
export type MatValue = (typeof Mat)[keyof typeof Mat];

/** Uma cratera aplicada ao terreno. E a unica coisa que trafega pela rede. */
export interface CarveOp {
  x: number;
  y: number;
  r: number;
}

/** Retangulo sujo, para o renderizador saber o que repintar. */
export interface DirtyRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Definicao de um mapa jogavel. */
export interface MapDef {
  id: string;
  name: string;
  /** Altura media do solo, como fracao da altura do mapa (0 = topo). */
  groundLevel: number;
  /** Amplitude das montanhas, em pixels. */
  relief: number;
  /** Quantidade de cavernas: 0 = macico, 1 = queijo suico. */
  caves: number;
  /** Viaduto fino sobre agua em vez de morro/caverna -- ver `generateBridge`. */
  bridge?: boolean;
}

// `relief` e em pixels absolutos — escalado junto com o corte de MAP_HEIGHT
// pra 60% (era 190/110/260), senao o relevo ficaria proporcionalmente bem
// mais dramatico no mapa menor.
export const MAPS: readonly MapDef[] = [
  { id: 'fabrica', name: 'Fabrica', groundLevel: 0.62, relief: 114, caves: 0.5 },
  { id: 'praia', name: 'Praia', groundLevel: 0.7, relief: 66, caves: 0.2 },
  { id: 'deposito', name: 'Deposito', groundLevel: 0.55, relief: 156, caves: 0.75 },
  // Inspirado na Ponte Rio-Niteroi: vao central mais alto (o de verdade tem
  // 72m de altura e 300m de vao livre pra passagem de navio), deck fino e
  // destrutivel sobre o rio. Estrategia propria: derrubar o adversario na
  // agua mata igual a estourar ele.
  { id: 'ponte', name: 'Ponte Rio-Niteroi', groundLevel: 0.42, relief: 0, caves: 0, bridge: true },
];

export function getMap(id: string): MapDef {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}

/**
 * Terreno destrutivel pixel-perfect.
 *
 * O mapa inteiro e gerado a partir de (mapId, seed) — cliente e servidor
 * chegam ao mesmo bitmask sem trafegar nenhum pixel. Depois disso, so as
 * crateras (CarveOp) precisam ser sincronizadas.
 */
export class Terrain {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  /** Regioes alteradas desde o ultimo `consumeDirty()`. */
  private dirty: DirtyRect[] = [];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height);
  }

  static generate(mapId: string, seed: number): Terrain {
    const def = getMap(mapId);
    const t = new Terrain(MAP_WIDTH, MAP_HEIGHT);
    if (def.bridge) {
      generateBridge(t, def, seed);
      return t;
    }

    const { width, height, data } = t;
    const baseY = height * def.groundLevel;

    for (let x = 0; x < width; x++) {
      // Relevo: tres oitavas de ruido de valor. Sem seno/cosseno de proposito.
      const n =
        noise1(x, 900, seed) * 0.6 + noise1(x, 260, seed + 7) * 0.3 + noise1(x, 70, seed + 13) * 0.1;
      const surface = Math.floor(baseY + (n - 0.5) * 2 * def.relief);

      for (let y = surface; y < height; y++) {
        const idx = y * width + x;
        // Base do mapa e rocha indestrutivel, senao da pra cavar ate o vazio.
        if (y >= height - 24) {
          data[idx] = Mat.ROCK;
          continue;
        }
        if (def.caves > 0) {
          const c = noise2(x, y * 1.6, 150, seed + 101);
          // Cavernas so abaixo de uma casca de terra, pra superficie nao virar renda.
          if (y > surface + 40 && c > 1 - def.caves * 0.35) continue;
        }
        data[idx] = Mat.DIRT;
      }
    }

    return t;
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  at(x: number, y: number): number {
    if (!this.inBounds(x, y)) return Mat.AIR;
    return this.data[this.index(x, y)];
  }

  /** Bloqueia movimento? Liquido nao bloqueia (afoga, tratado na fisica). */
  isSolid(x: number, y: number): boolean {
    const m = this.at(x, y);
    return m === Mat.DIRT || m === Mat.ROCK;
  }

  /**
   * Abre uma cratera circular. Rocha resiste.
   * Determinista: usa so comparacao de quadrados inteiros, sem raiz.
   */
  carve(op: CarveOp): void {
    const cx = Math.round(op.x);
    const cy = Math.round(op.y);
    const r = Math.round(op.r);
    const r2 = r * r;

    const x0 = Math.max(0, cx - r);
    const x1 = Math.min(this.width - 1, cx + r);
    const y0 = Math.max(0, cy - r);
    const y1 = Math.min(this.height - 1, cy + r);
    if (x0 > x1 || y0 > y1) return;

    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const dy2 = dy * dy;
      const row = y * this.width;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy2 > r2) continue;
        const idx = row + x;
        // Rocha resiste, e agua nao vira ar (nao faz sentido "estourar" um rio).
        if (this.data[idx] === Mat.ROCK || this.data[idx] === Mat.LIQUID) continue;
        this.data[idx] = Mat.AIR;
      }
    }

    this.dirty.push({ x0, y0, x1, y1 });
  }

  /** Encontra o chao logo abaixo de (x, yFrom). Retorna height se nao houver. */
  groundBelow(x: number, yFrom: number): number {
    for (let y = Math.max(0, Math.floor(yFrom)); y < this.height; y++) {
      if (this.isSolid(x, y)) return y;
    }
    return this.height;
  }

  /** Marca o mapa inteiro como sujo (usado logo apos gerar). */
  markAllDirty(): void {
    this.dirty = [{ x0: 0, y0: 0, x1: this.width - 1, y1: this.height - 1 }];
  }

  consumeDirty(): DirtyRect[] {
    const d = this.dirty;
    this.dirty = [];
    return d;
  }
}

/**
 * Ponte Rio-Niteroi: em vez de morro/caverna, um deck fino e destrutivel
 * suspenso sobre o rio. O vao central sobe (parabola, sem seno/cosseno —
 * fisica compartilhada nunca usa trig) feito o vao livre de verdade, mais
 * alto pra passagem de navio. Cair no rio mata igual ao vazio: a estrategia
 * do mapa e derrubar o adversario na agua, nao so estourar ele no lugar.
 */
function generateBridge(t: Terrain, def: MapDef, seed: number): void {
  const { width, height, data } = t;
  const deckBaseY = height * def.groundLevel;
  const deckThickness = 30;
  const archHalfWidth = width * 0.22;
  const archHeight = 46;
  const waterY = height * 0.86;
  const floorY = height - 24;

  const archAt = (x: number): number => {
    const dCenter = Math.abs(x - width / 2);
    if (dCenter >= archHalfWidth) return 0;
    return archHeight * (1 - (dCenter / archHalfWidth) ** 2);
  };

  for (let x = 0; x < width; x++) {
    // Textura leve na superficie do deck, pra nao ficar reta demais.
    const n = noise1(x, 140, seed) - 0.5;
    const surface = Math.floor(deckBaseY - archAt(x) + n * 4);
    const deckBottom = surface + deckThickness;

    for (let y = Math.max(0, surface); y < height; y++) {
      const idx = y * width + x;
      if (y >= floorY) {
        data[idx] = Mat.ROCK;
      } else if (y < deckBottom) {
        data[idx] = Mat.DIRT;
      } else if (y >= waterY) {
        data[idx] = Mat.LIQUID;
      }
      // Entre o fundo do deck e a agua: ar de proposito (queda livre ate o rio).
    }
  }

  // Pilares indestrutiveis descendo do deck ate o rio — apoio estrutural (feito
  // os pilares de verdade) e cobertura tatica no meio do vao.
  const pillarWidth = 16;
  const pillarSpots = 5;
  for (let i = 1; i < pillarSpots; i++) {
    const px = Math.floor((width / pillarSpots) * i);
    const topY = Math.max(0, Math.floor(deckBaseY - archAt(px)));
    const half = pillarWidth / 2;
    for (let y = topY; y < floorY; y++) {
      for (let dx = -half; dx < half; dx++) {
        const x = Math.floor(px + dx);
        if (x < 0 || x >= width) continue;
        data[y * width + x] = Mat.ROCK;
      }
    }
  }
}

/**
 * Altura do chao considerando a LARGURA inteira de algo (Jorbe, engradado),
 * nao so uma coluna. `groundBelow` de coluna unica bastava num terreno
 * chapado, mas numa ladeira o ponto mais alto (menor y) dentro da largura do
 * corpo pode ficar bem acima do que a coluna central sozinha acusaria —
 * resultado: o objeto nasce sobrepondo terreno solido de um lado. Usa o
 * ponto mais restritivo (menor y) amostrado ao longo da largura, garantindo
 * que nenhuma coluna fique embaixo da superficie.
 */
export function groundBelowSpan(terrain: Terrain, centerX: number, width: number): number {
  const half = Math.floor(width / 2);
  let minY = terrain.height;
  // Passo 1: um pico estreito de 1-2px entre amostras espacadas escaparia
  // (a mesma armadilha de aliasing que ja pegou o boxHits) — a largura e so
  // ~22px, entao varrer coluna a coluna e barato mesmo assim.
  for (let dx = -half; dx <= half; dx++) {
    const x = Math.max(0, Math.min(terrain.width - 1, centerX + dx));
    const y = terrain.groundBelow(x, 0);
    if (y < minY) minY = y;
  }
  return minY;
}

/**
 * Sorteia pontos de nascimento espalhados pelo mapa, um por jogador, sempre
 * sobre solo firme e com distancia minima entre si.
 */
export function pickSpawns(terrain: Terrain, count: number, seed: number): { x: number; y: number }[] {
  const rng = new Rng(seed ^ 0x5f3a);
  const spawns: { x: number; y: number }[] = [];
  const margin = 120;
  const minGap = Math.max(90, Math.floor((terrain.width - margin * 2) / Math.max(count, 1)) - 40);

  let guard = 0;
  while (spawns.length < count && guard < count * 400) {
    guard++;
    const x = rng.int(margin, terrain.width - margin);
    if (spawns.some((s) => Math.abs(s.x - x) < minGap)) continue;
    const y = groundBelowSpan(terrain, x, JORBE_WIDTH);
    // Fora do mapa ou dentro da faixa de rocha do fundo: descarta.
    if (y >= terrain.height - 30) continue;
    spawns.push({ x, y: y - 1 });
  }

  // Se o mapa for apertado demais, relaxa a distancia minima e completa.
  let fallbackX = margin;
  while (spawns.length < count) {
    const y = groundBelowSpan(terrain, fallbackX, JORBE_WIDTH);
    if (y < terrain.height - 30) spawns.push({ x: fallbackX, y: y - 1 });
    fallbackX += 60;
    if (fallbackX > terrain.width - margin) break;
  }

  return spawns;
}
