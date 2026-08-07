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
  /** Arma defensiva: ao ativar nao cria projetil nenhum, so um efeito (ex: escudo). */
  defensive?: boolean;
  /** So obtida via engradado -- comeca com 0 cargas, nunca na municao inicial. */
  dropOnly?: boolean;
  /** Racimo: numero de sub-estouros alem do principal, num leque ao redor do impacto. */
  cluster?: number;
  /** Alcance horizontal maximo dos sub-estouros em relacao ao impacto, em pixels. */
  clusterSpread?: number;
  /** Atraso entre sub-estouros, em ticks (0 = todos no mesmo instante). */
  clusterTickGap?: number;
  /** Fracao do raio principal usada no raio de cada sub-estouro (0..1). */
  clusterRadiusFactor?: number;
  /** Vortice: raio extra alem de `radius` onde so ha puxao pro centro, sem dano. */
  vortexRadius?: number;
  /** Vortice: forca do puxao no limite interno do halo (px/s), cai ate a borda externa. */
  vortexPull?: number;
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
  {
    id: 'escudo',
    name: 'Escudo',
    ammo: 3,
    damage: 0,
    radius: 0,
    windFactor: 0,
    knockback: 0,
    bounces: false,
    restitution: 0,
    fuse: null,
    color: '#6fb8d6',
    size: 0,
    defensive: true,
  },
  // As tres a seguir so vem de engradado (nunca na municao inicial) — mais
  // raras e mais dramaticas que o trio basico.
  {
    id: 'racimo',
    name: 'Bomba Racimo',
    ammo: 0,
    dropOnly: true,
    damage: 26,
    radius: 60,
    windFactor: 1.0,
    knockback: 200,
    bounces: false,
    restitution: 0,
    fuse: null,
    color: '#e0733a',
    size: 5,
    cluster: 5,
    clusterSpread: 70,
    clusterTickGap: 3,
    clusterRadiusFactor: 0.5,
  },
  {
    id: 'napalm',
    name: 'Chuva de Fogo',
    ammo: 0,
    dropOnly: true,
    damage: 16,
    radius: 50,
    windFactor: 1.2,
    knockback: 130,
    bounces: false,
    restitution: 0,
    fuse: null,
    color: '#ff5a1f',
    size: 5,
    cluster: 8,
    clusterSpread: 160,
    clusterTickGap: 5,
    clusterRadiusFactor: 0.4,
  },
  {
    id: 'vortice',
    name: 'Vortice Gravitacional',
    ammo: 0,
    dropOnly: true,
    damage: 30,
    radius: 45,
    windFactor: 0.3,
    knockback: 80,
    bounces: false,
    restitution: 0,
    fuse: null,
    color: '#8a4fd6',
    size: 6,
    vortexRadius: 130,
    vortexPull: 260,
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
