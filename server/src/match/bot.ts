import { GRAVITY, JORBE_HEIGHT, MAX_POWER, MIN_POWER, POWER_TO_SPEED, Rng, TICK_DT, WEAPONS, type Terrain, type Weapon } from '@jorbe/shared';

/**
 * IA do Jorbot: nada de perfeicao absoluta, mas agora testa tiros de verdade
 * contra o terreno real antes de decidir — nao so uma formula de alcance no
 * vacuo. O objetivo e dar trabalho pra jogar contra, nao ser imbativel, entao
 * ainda erra um pouco de proposito no final.
 */

/**
 * Simula (sem alterar nada — nem cavar terreno, nem causar dano) onde um tiro
 * com este angulo/forca vai colidir, seguindo a mesma integracao usada de
 * verdade em `stepProjectiles`. So termina em terreno solido, fora do mapa
 * ou apos um teto de tempo de voo bem generoso.
 */
function simulateLanding(
  terrain: Terrain,
  fromX: number,
  fromY: number,
  angleDeg: number,
  power: number,
  wind: number,
  windFactor: number,
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  const speed = power * POWER_TO_SPEED;
  let x = fromX;
  let y = fromY;
  let vx = Math.cos(rad) * speed;
  let vy = -Math.sin(rad) * speed;
  const dt = TICK_DT;
  const maxTicks = 600; // ~10s de voo, mais que suficiente pra qualquer mapa

  for (let i = 0; i < maxTicks; i++) {
    vy += GRAVITY * dt;
    vx += wind * windFactor * dt;

    // Passo grosso (so estimando pouso, nao precisa da precisao sub-pixel
    // usada na colisao real de verdade contra personagens).
    const dist = Math.sqrt(vx * vx + vy * vy) * dt;
    const steps = Math.max(1, Math.ceil(dist / 4));
    const sx = (vx * dt) / steps;
    const sy = (vy * dt) / steps;

    for (let s = 0; s < steps; s++) {
      x += sx;
      y += sy;
      if (x < 0 || x > terrain.width || y > terrain.height) return { x, y };
      if (terrain.isSolid(Math.round(x), Math.round(y))) return { x, y };
    }
  }
  return { x, y };
}

/**
 * Acha angulo/forca mirando de verdade: sorteia uma grade de candidatos ao
 * redor de um chute inicial (formula classica de alcance) e simula cada um
 * contra o terreno real, escolhendo o que cai mais perto do alvo. Assim o bot
 * automaticamente lida com morro no meio do caminho, vento, e diferenca de
 * altura, em vez de confiar cegamente numa formula de terreno plano.
 */
export function solveBotShot(
  terrain: Terrain,
  fromX: number,
  fromY: number,
  targetX: number,
  targetY: number,
  wind: number,
  windFactor: number,
  rng: Rng,
): { angle: number; power: number } {
  const dx = targetX - fromX;
  const dist = Math.max(20, Math.abs(dx));
  const dir = dx >= 0 ? 1 : -1;
  const dy = fromY - targetY; // positivo = alvo mais alto que o atirador

  // Mira no centro do corpo, nao nos pes -- e o ponto que o calculo de dano
  // de verdade usa (`ccy = c.y - JORBE_HEIGHT/2` em physics.ts).
  const aimX = targetX;
  const aimY = targetY - JORBE_HEIGHT / 2;

  // Chute inicial pela formula classica de alcance, so pra semear a busca.
  let baseAngle = dist < 250 ? 68 : dist < 600 ? 52 : 42;
  if (dy > 40) baseAngle += Math.min(15, dy / 12);
  if (dy < -40) baseAngle -= Math.min(12, -dy / 15);
  baseAngle = Math.max(15, Math.min(85, baseAngle));

  let best: { angle: number; power: number; error: number } | null = null;

  for (const angleDelta of [-24, -12, 0, 12, 24]) {
    const sideAngle = Math.max(12, Math.min(88, baseAngle + angleDelta));
    const finalAngle = dir >= 0 ? sideAngle : 180 - sideAngle;

    const angleRad = (sideAngle * Math.PI) / 180;
    const sin2 = Math.sin(2 * angleRad);
    const vNeeded = sin2 > 0.05 ? Math.sqrt((dist * GRAVITY) / sin2) : MAX_POWER * POWER_TO_SPEED;
    const baseGuessPower = vNeeded / POWER_TO_SPEED - wind * dir * windFactor * 0.4;

    for (const powerDelta of [-22, -11, 0, 11, 22]) {
      const power = Math.max(MIN_POWER, Math.min(MAX_POWER, baseGuessPower + powerDelta));
      const landing = simulateLanding(terrain, fromX, fromY, finalAngle, power, wind, windFactor);
      const errDx = landing.x - aimX;
      const errDy = landing.y - aimY;
      const error = errDx * errDx + errDy * errDy;
      if (!best || error < best.error) best = { angle: finalAngle, power, error };
    }
  }

  const chosen = best ?? { angle: dir >= 0 ? baseAngle : 180 - baseAngle, power: 60 };

  // Erro humano pequeno -- o bot mira bem (testou o tiro de verdade contra o
  // terreno), mas nao com precisao de laser.
  const angle = chosen.angle + rng.range(-3, 3);
  const power = chosen.power + rng.range(-4, 4);

  return {
    angle: Math.max(5, Math.min(175, angle)),
    power: Math.max(MIN_POWER, Math.min(MAX_POWER, power)),
  };
}

/**
 * Escolhe uma arma entre as que ainda tem municao, com peso pra tampinha
 * (infinita). Armas defensivas (escudo) ficam de fora -- quem decide usar
 * escudo e a logica de tiro em `MatchEngine`, separada da escolha de arma.
 */
export function pickBotWeapon(ammo: Record<string, number | null>, rng: Rng): Weapon {
  const usable = WEAPONS.filter((w) => {
    if (w.defensive) return false;
    const a = ammo[w.id];
    // null = infinita de proposito (tampinha). undefined so acontece se a
    // arma nunca foi seedada no inventario -- trata como sem municao, nunca
    // como infinita (senao um buraco no seed vira "arma infinita de graca").
    return a === null || (a !== undefined && a > 0);
  });
  if (usable.length === 0) return WEAPONS[0];

  // Tampinha (infinita) pesa mais, pra nao esgotar municao limitada rapido demais.
  const weighted: Weapon[] = [];
  for (const w of usable) {
    const weight = w.ammo === null ? 3 : 1;
    for (let i = 0; i < weight; i++) weighted.push(w);
  }
  return rng.pick(weighted);
}

/**
 * Decide se vale a pena levantar o escudo neste turno: machucado (ja levou
 * dano de verdade, nao so por precaucao) ou, mais raramente, por prevencao
 * mesmo saudavel -- pra nao ficar 100% previsivel ("bot so defende quando
 * ta quase morrendo").
 */
export function shouldRaiseShield(hp: number, maxHp: number, rng: Rng): boolean {
  if (hp <= maxHp * 0.4) return true;
  return rng.next() < 0.15;
}
