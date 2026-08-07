import { GRAVITY, MAX_POWER, MIN_POWER, POWER_TO_SPEED, Rng, WEAPONS, type Weapon } from '@jorbe/shared';

/**
 * IA do Jorbot: nada de perfeicao balistica, so uma estimativa razoavel com
 * erro humano — o objetivo e dar trabalho pra jogar contra, nao ser
 * imbativel. Usa a formula classica de alcance de projetil (sem vento) como
 * ponto de partida, ajusta o angulo pela diferenca de altura, compensa o
 * vento de forma grosseira e por fim erra de proposito um pouco.
 */
export function solveBotShot(
  fromX: number,
  fromY: number,
  targetX: number,
  targetY: number,
  wind: number,
  rng: Rng,
): { angle: number; power: number } {
  const dx = targetX - fromX;
  const dy = fromY - targetY; // positivo = alvo mais alto que o atirador
  const dist = Math.max(20, Math.abs(dx));
  const dir = dx >= 0 ? 1 : -1;

  // Angulo de lance: mais vertical de perto (senao passa raspando), mais
  // raso de longe (senao nunca alcanca). Ajusta pra alvo mais alto/baixo.
  let angle = dist < 250 ? 68 : dist < 600 ? 52 : 42;
  if (dy > 40) angle += Math.min(15, dy / 12);
  if (dy < -40) angle -= Math.min(12, -dy / 15);
  angle = Math.max(20, Math.min(80, angle));

  const angleRad = (angle * Math.PI) / 180;
  const sin2 = Math.sin(2 * angleRad);
  const vNeeded = sin2 > 0.05 ? Math.sqrt((dist * GRAVITY) / sin2) : MAX_POWER * POWER_TO_SPEED;

  let power = vNeeded / POWER_TO_SPEED;
  // Vento contra o tiro pede mais forca; a favor, menos. Compensacao crua,
  // nao precisa (nem deve) ser perfeita.
  power -= wind * dir * 0.4;

  // Erro humano — o bot mira bem, mas nao com precisao de laser.
  power += rng.range(-7, 7);
  angle += rng.range(-5, 5);

  // A formula assume "atirando pra direita" (angulo 0-90); espelha pro lado
  // esquerdo quando o alvo esta atras, mantendo a convencao 0=direita,90=cima,180=esquerda.
  const finalAngle = dir >= 0 ? angle : 180 - angle;

  return {
    angle: Math.max(5, Math.min(175, finalAngle)),
    power: Math.max(MIN_POWER, Math.min(MAX_POWER, power)),
  };
}

/** Escolhe uma arma entre as que ainda tem municao, com peso pra tampinha (infinita). */
export function pickBotWeapon(ammo: Record<string, number | null>, rng: Rng): Weapon {
  const usable = WEAPONS.filter((w) => {
    const a = ammo[w.id];
    return a === null || a === undefined || a > 0;
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
