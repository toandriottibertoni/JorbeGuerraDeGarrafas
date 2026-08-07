/**
 * Catalogo de armas. Puro dado — quem interpreta esses campos e a fisica em
 * `physics.ts`. Balancear o jogo deve ser mexer aqui, nunca em logica.
 *
 * F3 traz o sistema de armas com tres delas; a F4 completa as seis do plano.
 */

export interface Weapon {
  id: string;
  name: string;
  /** Municao inicial por partida. `null` = infinita. */
  ammo: number | null;
  damage: number;
  /** Raio da cratera e do dano, em pixels. */
  radius: number;
  /** Multiplicador do vento sobre este projetil. */
  windFactor: number;
  /** Quanto a explosao empurra (px/s no epicentro). */
  knockback: number;
  /** Se quica no terreno em vez de explodir ao tocar. */
  bounces: boolean;
  /** Perda de energia por quique (0..1). So usado se `bounces`. */
  restitution: number;
  /** Segundos ate detonar sozinho. `null` = so explode ao colidir. */
  fuse: number | null;
  /** Cor do projetil no render. */
  color: string;
  /** Raio visual/de colisao do projetil. */
  size: number;
}

export const WEAPONS: readonly Weapon[] = [
  {
    id: 'tampinha',
    name: 'Tampinha',
    ammo: null,
    damage: 22,
    radius: 26,
    windFactor: 1.0,
    knockback: 150,
    bounces: false,
    restitution: 0,
    fuse: null,
    color: '#4a9d4f',
    size: 4,
  },
  {
    id: 'bazuca',
    name: 'Bazuca de Gas',
    ammo: 4,
    damage: 38,
    radius: 85,
    windFactor: 1.7,
    knockback: 260,
    bounces: false,
    restitution: 0,
    fuse: null,
    color: '#d98f2b',
    size: 5,
  },
  {
    id: 'granada',
    name: 'Granada de Espuma',
    ammo: 3,
    damage: 34,
    radius: 70,
    windFactor: 0.5,
    knockback: 300,
    bounces: true,
    restitution: 0.45,
    fuse: 3,
    color: '#c9d6c0',
    size: 5,
  },
];

const BY_ID = new Map(WEAPONS.map((w) => [w.id, w]));

export function getWeapon(id: string): Weapon {
  return BY_ID.get(id) ?? WEAPONS[0];
}

/** Inventario inicial de um Jorbe. `null` representa municao infinita. */
export function startingAmmo(): Record<string, number | null> {
  const inv: Record<string, number | null> = {};
  for (const w of WEAPONS) inv[w.id] = w.ammo;
  return inv;
}
