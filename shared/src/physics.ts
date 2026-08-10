import {
  CRATE_WIDTH,
  FALL_DAMAGE_MIN_SPEED,
  FALL_DAMAGE_PER_SPEED,
  GRAVITY,
  JORBE_HEIGHT,
  JORBE_WIDTH,
  JUMP_SPEED,
  KNOCKBACK_DRAG,
  MAP_HEIGHT,
  MAP_WIDTH,
  MAX_STEP_UP,
  WALK_SPEED,
} from './constants.js';
import { Mat, Terrain } from './terrain.js';
import { getWeapon } from './weapons.js';

/**
 * Fisica com passo fixo, escrita para rodar identica nos dois lados.
 *
 * Cuidado com determinismo: aqui so entram +, -, *, / e Math.sqrt, que o
 * IEEE 754 define bit-a-bit. Nada de Math.sin/cos/pow — o angulo de tiro e
 * convertido em (vx, vy) UMA vez no servidor e viaja pronto na rede, para
 * que a integracao seja puramente aritmetica.
 */

export interface CharState {
  id: string;
  /** x = centro do corpo, y = pes (parte de baixo da caixa de colisao). */
  x: number;
  y: number;
  /** Velocidade externa: knockback e queda. Nao inclui o andar. */
  vx: number;
  vy: number;
  onGround: boolean;
  facing: 1 | -1;
  hp: number;
  alive: boolean;
  fuel: number;
  /** Ativou o escudo nesta rodada: bloqueia dano e empurrao de qualquer explosao ate a proxima rodada resetar. */
  shielded: boolean;
}

export interface MoveInput {
  left: boolean;
  right: boolean;
  jump: boolean;
}

export const NO_INPUT: MoveInput = { left: false, right: false, jump: false };

export interface Projectile {
  id: number;
  ownerId: string;
  weaponId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Segundos de vida, para o pavio. */
  age: number;
  dead: boolean;
  /**
   * Multiplicador de dano pelo angulo de lancamento (calculado uma vez no
   * servidor, onde e o unico lugar que ja usa Math.sin — aqui so multiplica,
   * o que continua determinista). Tiros mais verticais causam mais dano.
   */
  angleBonus: number;
}

export type DamageCause = 'blast' | 'fall' | 'void' | 'water';

/**
 * Eventos produzidos pela simulacao autoritativa do servidor.
 *
 * Sao desenhados para que o CLIENTE NAO PRECISE DETECTAR COLISAO NENHUMA
 * durante a reproducao da rodada: ele integra os projeteis de forma puramente
 * balistica e, a cada tick, aplica os eventos daquele tick. `bounce` e
 * `knockback` carregam a velocidade ja resolvida, entao nao ha como o cliente
 * chegar num resultado diferente do servidor.
 */
export type SimEvent =
  | {
      kind: 'explosion';
      tick: number;
      shotId: number;
      x: number;
      y: number;
      weaponId: string;
      radius: number;
    }
  | { kind: 'bounce'; tick: number; shotId: number; x: number; y: number; vx: number; vy: number }
  | { kind: 'knockback'; tick: number; playerId: string; vx: number; vy: number }
  | {
      kind: 'damage';
      tick: number;
      playerId: string;
      amount: number;
      hp: number;
      cause: DamageCause;
      /** So presente pra dano de explosao -- liga o dano de volta ao tiro que causou, pra achar "tiro fantastico". */
      shotId?: number;
    }
  | { kind: 'death'; tick: number; playerId: string; cause: DamageCause }
  | { kind: 'blocked'; tick: number; playerId: string }
  | {
      kind: 'crateHit';
      tick: number;
      crateId: number;
      x: number;
      y: number;
      crateKind: 'health' | 'ammo';
      playerId: string;
    };

// ---------------------------------------------------------------------------
// Colisao do personagem
// ---------------------------------------------------------------------------

/** A caixa do Jorbe encosta em terreno solido nesta posicao? */
export function boxHits(t: Terrain, x: number, y: number): boolean {
  const half = JORBE_WIDTH / 2;
  const x0 = Math.round(x - half);
  const x1 = x0 + JORBE_WIDTH - 1;
  const y1 = Math.round(y);
  const y0 = y1 - JORBE_HEIGHT + 1;

  // Amostragem pixel a pixel: crateras que se sobrepoem deixam pontas finas
  // de terra que uma amostragem com passo 2 podia pular, deixando o jogo
  // assentar o Jorbe num pé de terra que a renderizacao mostra solido —
  // ele fica "preso" visualmente dentro do chao. A caixa e pequena (22x30),
  // entao o custo do scan completo e desprezivel.
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      if (t.isSolid(xx, yy)) return true;
    }
  }
  return false;
}

/** Os pes do Jorbe encostaram na agua? No mapa da ponte, cair no rio mata na hora. */
export function feetInLiquid(t: Terrain, c: CharState): boolean {
  const half = JORBE_WIDTH / 2;
  const y = Math.round(c.y);
  const x0 = Math.round(c.x - half);
  const x1 = x0 + JORBE_WIDTH - 1;
  for (let xx = x0; xx <= x1; xx++) {
    if (t.at(xx, y) === Mat.LIQUID) return true;
  }
  return false;
}

/** Um ponto esta dentro da caixa do Jorbe? */
export function pointInChar(c: CharState, px: number, py: number): boolean {
  const half = JORBE_WIDTH / 2;
  return px >= c.x - half && px <= c.x + half && py >= c.y - JORBE_HEIGHT && py <= c.y;
}

/**
 * Um ponto esta dentro da caixa de um engradado? `cr.y` e o pe (onde encosta
 * no chao), e o render desenha a caixa centrada em `cr.y - CRATE_WIDTH` —
 * mesma referencia usada aqui, senao o hitbox real ficaria deslocado do que
 * o jogador ve na tela.
 */
export function pointInCrate(cr: { x: number; y: number }, px: number, py: number): boolean {
  const half = CRATE_WIDTH / 2;
  const cy = cr.y - CRATE_WIDTH;
  return px >= cr.x - half && px <= cr.x + half && py >= cy - half && py <= cy + half;
}

/** Move no eixo X em passos de 1px, subindo degraus. Retorna o quanto andou. */
function moveX(t: Terrain, c: CharState, dx: number): number {
  if (dx === 0) return 0;
  const dir = dx > 0 ? 1 : -1;
  let remaining = Math.abs(dx);
  let moved = 0;

  while (remaining > 0) {
    const step = remaining < 1 ? remaining : 1;
    const nx = c.x + dir * step;

    if (!boxHits(t, nx, c.y)) {
      c.x = nx;
      moved += step;
      remaining -= step;
      continue;
    }

    let climbed = false;
    for (let up = 1; up <= MAX_STEP_UP; up++) {
      if (!boxHits(t, nx, c.y - up)) {
        c.x = nx;
        c.y -= up;
        moved += step;
        remaining -= step;
        climbed = true;
        break;
      }
    }
    if (!climbed) {
      c.vx = 0;
      break;
    }
  }

  return moved;
}

/** Move no eixo Y em passos de 1px. Retorna 1 se bateu no chao, -1 no teto, 0 livre. */
function moveY(t: Terrain, c: CharState, dy: number): number {
  if (dy === 0) return 0;
  const dir = dy > 0 ? 1 : -1;
  let remaining = Math.abs(dy);

  while (remaining > 0) {
    const step = remaining < 1 ? remaining : 1;
    const ny = c.y + dir * step;
    if (boxHits(t, c.x, ny)) return dir;
    c.y = ny;
    remaining -= step;
  }
  return 0;
}

/**
 * Avanca um Jorbe um passo. Aplica dano de queda e morte por sair do mapa,
 * empurrando os eventos correspondentes em `events`.
 */
export function stepCharacter(
  t: Terrain,
  c: CharState,
  input: MoveInput,
  dt: number,
  tick: number,
  events: SimEvent[],
): void {
  if (!c.alive) return;

  // Rede de seguranca: se por algum motivo o corpo ja nasceu ou ficou dentro
  // do terreno, moveX/moveY nunca vao perceber sozinhos (so validam o PROXIMO
  // passo, nao a posicao atual) — com vx=0 o personagem ficaria preso pra
  // sempre. Sobe ate desencravar antes de processar o resto do tick.
  if (boxHits(t, c.x, c.y)) {
    for (let up = 1; up <= 60; up++) {
      if (!boxHits(t, c.x, c.y - up)) {
        c.y -= up;
        break;
      }
    }
  }

  const wantDir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (wantDir !== 0) c.facing = wantDir > 0 ? 1 : -1;

  if (c.onGround && input.jump) {
    c.vy = -JUMP_SPEED;
    c.vx += wantDir * 45;
    c.onGround = false;
  }

  c.vy += GRAVITY * dt;
  c.vx -= c.vx * KNOCKBACK_DRAG * dt;

  // 1) Deslocamento externo (knockback). Nao gasta combustivel.
  moveX(t, c, c.vx * dt);

  // 2) Caminhada intencional. Gasta combustivel pelo que ANDOU de fato,
  //    para nao punir quem ficou preso numa parede.
  if (c.onGround && wantDir !== 0 && c.fuel > 0) {
    const want = wantDir * WALK_SPEED * dt;
    const budget = Math.min(Math.abs(want), c.fuel);
    const walked = moveX(t, c, wantDir * budget);
    c.fuel = Math.max(0, c.fuel - walked);
  }

  const hit = moveY(t, c, c.vy * dt);
  if (hit > 0) {
    const impact = c.vy;
    c.onGround = true;
    c.vy = 0;
    if (impact > FALL_DAMAGE_MIN_SPEED) {
      const dmg = Math.round((impact - FALL_DAMAGE_MIN_SPEED) * FALL_DAMAGE_PER_SPEED);
      if (dmg > 0) applyDamage(c, dmg, 'fall', tick, events);
    }
  } else if (hit < 0) {
    c.vy = 0;
  } else {
    // Sem contato: so deixa de estar no chao se realmente nao ha piso colado.
    if (c.onGround && !boxHits(t, c.x, c.y + 1)) c.onGround = false;
  }

  // O fundo do mapa e rocha indestrutivel, entao estar abaixo dele so acontece
  // depois de cair pela lateral: e morte certa, sem margem de tolerancia.
  if (c.y > MAP_HEIGHT || c.x < -60 || c.x > MAP_WIDTH + 60) {
    c.hp = 0;
    c.alive = false;
    events.push({ kind: 'death', tick, playerId: c.id, cause: 'void' });
  } else if (feetInLiquid(t, c)) {
    // Cair no rio (mapa da ponte) mata igual ao vazio -- e a estrategia
    // central desse mapa: derrubar o adversario na agua em vez de estourar.
    c.hp = 0;
    c.alive = false;
    events.push({ kind: 'death', tick, playerId: c.id, cause: 'water' });
  }
}

export function applyDamage(
  c: CharState,
  amount: number,
  cause: DamageCause,
  tick: number,
  events: SimEvent[],
  shotId?: number,
): void {
  if (!c.alive || amount <= 0) return;
  c.hp = Math.max(0, c.hp - amount);
  events.push({ kind: 'damage', tick, playerId: c.id, amount, hp: c.hp, cause, shotId });
  if (c.hp === 0) {
    c.alive = false;
    events.push({ kind: 'death', tick, playerId: c.id, cause });
  }
}

// ---------------------------------------------------------------------------
// Projeteis
// ---------------------------------------------------------------------------

/**
 * Detona um projetil: abre cratera, causa dano em raio e empurra quem esta
 * perto. Racimo (`cluster`) reusa este mesmo estouro em varios pontos ao
 * redor do impacto — cada um e um evento 'explosion' normal, entao o cliente
 * ja desenha particula/onda/som pra cada um sem precisar de nenhum caso novo.
 */
export function explode(
  t: Terrain,
  p: Projectile,
  chars: CharState[],
  tick: number,
  events: SimEvent[],
): void {
  if (p.dead) return;
  p.dead = true;
  const w = getWeapon(p.weaponId);

  const blastAt = (cx: number, cy: number, radius: number, shotId: number, dmgScale: number, evTick: number): void => {
    events.push({ kind: 'explosion', tick: evTick, shotId, x: cx, y: cy, weaponId: w.id, radius });
    t.carve({ x: cx, y: cy, r: radius });

    const pullOuter = w.vortexRadius ?? 0;
    const totalReach = radius + pullOuter;

    for (const c of chars) {
      if (!c.alive) continue;
      // Mede ate o centro do corpo, nao ate os pes.
      const ccx = c.x;
      const ccy = c.y - JORBE_HEIGHT / 2;
      const dx = ccx - cx;
      const dy = ccy - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > totalReach) continue;

      // Escudo ativo bloqueia dano, empurrao E puxao do vortice por inteiro —
      // o jogador fica plantado no lugar, sem perder vida. Excecao: armas
      // "fantasma" (`ignoresShield`) passam direto, como no jogo de referencia.
      if (c.shielded && !w.ignoresShield) {
        events.push({ kind: 'blocked', tick: evTick, playerId: c.id });
        continue;
      }

      if (dist <= radius) {
        const falloff = 1 - dist / radius;
        // Empurrao: direcao radial, forte no epicentro. Se estiver exatamente
        // no centro, joga pra cima em vez de dividir por zero.
        const push = w.knockback * falloff;
        if (dist < 0.0001) {
          c.vy -= push;
        } else {
          c.vx += (dx / dist) * push;
          c.vy += (dy / dist) * push;
        }
        c.onGround = false;
        // Velocidade ABSOLUTA depois do empurrao: o cliente copia esse valor
        // em vez de recalcular o impulso, entao os dois lados nunca divergem.
        events.push({ kind: 'knockback', tick: evTick, playerId: c.id, vx: c.vx, vy: c.vy });
        // `p.id`, nao o `shotId` local do blastAt: sub-estouros de racimo usam
        // um id sintetico (p.id*1000+i) que nunca aparece na lista de tiros
        // originais -- o dano precisa voltar sempre pro tiro de verdade que
        // o jogador disparou, nao pro estouro interno que o causou.
        applyDamage(c, Math.round(w.damage * falloff * p.angleBonus * dmgScale), 'blast', evTick, events, p.id);
      } else {
        // Fora do raio de dano mas dentro do halo do vortice: so puxao pro
        // centro, sem ferir -- e a "sucção" antes do estouro de verdade.
        const pullFalloff = 1 - (dist - radius) / pullOuter;
        const pull = (w.vortexPull ?? 0) * pullFalloff;
        if (dist > 0.0001) {
          c.vx -= (dx / dist) * pull;
          c.vy -= (dy / dist) * pull;
        }
        c.onGround = false;
        events.push({ kind: 'knockback', tick: evTick, playerId: c.id, vx: c.vx, vy: c.vy });
      }
    }
  };

  blastAt(p.x, p.y, w.radius, p.id, 1, tick);

  if (w.cluster) {
    const n = w.cluster;
    const spread = w.clusterSpread ?? 60;
    const subRadius = Math.max(8, Math.round(w.radius * (w.clusterRadiusFactor ?? 0.5)));
    const gap = w.clusterTickGap ?? 0;
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0 : (i / (n - 1)) * 2 - 1; // -1..1, leque simetrico
      const ox = p.x + f * spread;
      const oy = p.y - Math.abs(f) * spread * 0.35;
      blastAt(ox, oy, subRadius, p.id * 1000 + i + 1, 0.6, tick + i * gap);
    }
  }
}

/**
 * Avanca todos os projeteis um passo. Projeteis colidem com terreno, com
 * personagens vivos e — de proposito — entre si: como todo mundo atira junto,
 * dois tiros se encontrarem no ar e parte da graca. Tambem colidem com
 * engradados: sem isso, um tiro certeiro simplesmente atravessava a caixa
 * (ela nao e solida nem personagem) e so "acertava" de fato se por acaso
 * uma explosao gerada por outro motivo terminasse perto o bastante.
 */
export function stepProjectiles(
  t: Terrain,
  projectiles: Projectile[],
  chars: CharState[],
  wind: number,
  dt: number,
  tick: number,
  events: SimEvent[],
  crates: readonly { x: number; y: number }[] = [],
): void {
  for (const p of projectiles) {
    if (p.dead) continue;
    const w = getWeapon(p.weaponId);

    p.vy += GRAVITY * dt;
    p.vx += wind * w.windFactor * dt;
    p.age += dt;

    // Subpassos de no maximo 2px para nao atravessar parede fina.
    const dist = Math.sqrt(p.vx * p.vx + p.vy * p.vy) * dt;
    const steps = Math.max(1, Math.ceil(dist / 2));
    const sx = (p.vx * dt) / steps;
    const sy = (p.vy * dt) / steps;

    for (let s = 0; s < steps; s++) {
      p.x += sx;
      p.y += sy;

      // Saiu do mapa pelos lados ou por baixo: some sem explodir.
      if (p.x < -80 || p.x > MAP_WIDTH + 80 || p.y > MAP_HEIGHT + 80) {
        p.dead = true;
        break;
      }

      if (t.isSolid(Math.round(p.x), Math.round(p.y))) {
        if (w.bounces) {
          bounce(t, p, w.restitution, sx, sy, tick, events);
        } else {
          explode(t, p, chars, tick, events);
          break;
        }
      }

      let hitChar = false;
      for (const c of chars) {
        if (!c.alive) continue;
        if (!pointInChar(c, p.x, p.y)) continue;
        // Nos primeiros instantes ignora o dono, senao o tiro explode na cara
        // de quem atirou ao sair do cano.
        if (c.id === p.ownerId && p.age < 0.08) continue;
        explode(t, p, chars, tick, events);
        hitChar = true;
        break;
      }
      if (hitChar) break;

      let hitCrate = false;
      for (const cr of crates) {
        if (!pointInCrate(cr, p.x, p.y)) continue;
        explode(t, p, chars, tick, events);
        hitCrate = true;
        break;
      }
      if (hitCrate) break;
    }

    if (!p.dead && w.fuse !== null && p.age >= w.fuse) {
      explode(t, p, chars, tick, events);
    }
  }

  // Tiro contra tiro: pares que se encostam detonam os dois.
  for (let i = 0; i < projectiles.length; i++) {
    const a = projectiles[i];
    if (a.dead) continue;
    const wa = getWeapon(a.weaponId);
    for (let j = i + 1; j < projectiles.length; j++) {
      const b = projectiles[j];
      if (b.dead) continue;
      const wb = getWeapon(b.weaponId);
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const reach = wa.size + wb.size;
      if (dx * dx + dy * dy > reach * reach) continue;
      explode(t, a, chars, tick, events);
      explode(t, b, chars, tick, events);
      break;
    }
  }
}

/** Reflete um projetil que quica, procurando a normal aproximada da superficie. */
function bounce(
  t: Terrain,
  p: Projectile,
  restitution: number,
  sx: number,
  sy: number,
  tick: number,
  events: SimEvent[],
): void {
  // Volta pro ultimo ponto livre.
  p.x -= sx;
  p.y -= sy;

  const solidBelow = t.isSolid(Math.round(p.x), Math.round(p.y + 2));
  const solidSide = t.isSolid(Math.round(p.x + (sx > 0 ? 2 : -2)), Math.round(p.y));

  if (solidSide) p.vx = -p.vx * restitution;
  if (solidBelow) p.vy = -p.vy * restitution;
  if (!solidSide && !solidBelow) {
    p.vx = -p.vx * restitution;
    p.vy = -p.vy * restitution;
  }

  events.push({ kind: 'bounce', tick, shotId: p.id, x: p.x, y: p.y, vx: p.vx, vy: p.vy });
}

/** Ainda ha alguma coisa acontecendo? Usado pra encerrar a fase de resolucao. */
export function simSettled(projectiles: Projectile[], chars: CharState[]): boolean {
  for (const p of projectiles) if (!p.dead) return false;
  for (const c of chars) {
    if (!c.alive) continue;
    if (!c.onGround) return false;
    if (Math.abs(c.vx) > 4) return false;
  }
  return true;
}
