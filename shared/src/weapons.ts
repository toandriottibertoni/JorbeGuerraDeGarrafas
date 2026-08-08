/**
 * Catalogo de armas. Puro dado — quem interpreta esses campos e a fisica em
 * `physics.ts`. Balancear o jogo deve ser mexer aqui, nunca em logica.
 *
 * F3 traz o sistema de armas com tres delas; a F4 completa as seis do plano.
 */

export interface Weapon {
  id: string;
  name: string;
  /** Frase curta pra HUD: o que esse tiro faz, em texto simples pro jogador. */
  description: string;
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
  /** Passa direto pelo escudo — o bloqueio de `c.shielded` nao se aplica a esta arma. */
  ignoresShield?: boolean;
}

export const WEAPONS: readonly Weapon[] = [
  {
    id: 'tampinha',
    name: 'Tampinha',
    description: 'Tiro simples e infinito. Dano baixo, mas nunca acaba.',
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
    description: 'Dano alto e cratera grande. O vento mexe bastante nele.',
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
    description: 'Quica no chao e so estoura depois de 3s — passa por cima de obstaculos.',
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
    description: 'Bloqueia todo dano e empurrao da rodada. Nao impede de atirar tambem.',
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
    description: 'Se abre em 5 sub-explosoes ao redor do impacto.',
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
    description: 'Chuva de 8 estilhacos cobrindo uma area bem larga.',
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
    description: 'Suga quem esta por perto antes do estouro final.',
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
  // Inspiradas no arsenal do Shellshock Live (shellshocklive.com) — mais sete
  // pra completar o time de raridades, todas so de engradado.
  {
    id: 'nuke',
    name: 'Bomba Nuclear',
    description: 'Explosao gigante — o maior dano e raio do jogo.',
    ammo: 0,
    dropOnly: true,
    damage: 60,
    radius: 150,
    windFactor: 1.0,
    knockback: 420,
    bounces: false,
    restitution: 0,
    fuse: null,
    color: '#f5e642',
    size: 8,
  },
  {
    id: 'mirv',
    name: 'MIRV Aereo',
    description: 'Estoura no ar antes de cair, espalhando 6 estilhacos.',
    ammo: 0,
    dropOnly: true,
    damage: 20,
    radius: 55,
    windFactor: 0.9,
    knockback: 170,
    bounces: false,
    restitution: 0,
    // Estoura no ar antes de cair (ou ao tocar o chao, o que vier primeiro) —
    // pavio curto pra rebentar em pleno voo na maioria dos arcos de tiro.
    fuse: 1.8,
    color: '#7a8a99',
    size: 5,
    cluster: 6,
    clusterSpread: 90,
    clusterTickGap: 2,
    clusterRadiusFactor: 0.45,
  },
  {
    id: 'vespas',
    name: 'Enxame de Vespas',
    description: '10 estilhacos rapidos e fracos, cobrindo uma area ampla.',
    ammo: 0,
    dropOnly: true,
    damage: 14,
    radius: 40,
    windFactor: 1.4,
    knockback: 90,
    bounces: false,
    restitution: 0,
    fuse: null,
    color: '#e8c93a',
    size: 4,
    cluster: 10,
    clusterSpread: 200,
    clusterTickGap: 2,
    clusterRadiusFactor: 0.3,
  },
  {
    id: 'terremoto',
    name: 'Terremoto',
    description: 'Raio enorme e dano baixo, mas empurrao violento.',
    ammo: 0,
    dropOnly: true,
    damage: 12,
    radius: 220,
    windFactor: 0.2,
    knockback: 340,
    bounces: false,
    restitution: 0,
    fuse: null,
    color: '#8a5a34',
    size: 7,
  },
  {
    id: 'fuzil',
    name: 'Fuzil de Precisao',
    description: 'Area minuscula, dano altissimo — so premia mira certeira.',
    ammo: 0,
    dropOnly: true,
    damage: 65,
    radius: 18,
    windFactor: 0.15,
    knockback: 140,
    bounces: false,
    restitution: 0,
    fuse: null,
    color: '#d94f4f',
    size: 3,
  },
  {
    id: 'fantasma',
    name: 'Bala Fantasma',
    description: 'Atravessa escudos — ignora bloqueio por completo.',
    ammo: 0,
    dropOnly: true,
    damage: 32,
    radius: 45,
    windFactor: 1.0,
    knockback: 160,
    bounces: false,
    restitution: 0,
    fuse: null,
    color: '#c9e8f0',
    size: 5,
    // Passa direto pelo escudo -- da mesma familia dos "shield ignorers" do
    // Shellshock Live (Earthquake, Shockwave, Laser Beam etc).
    ignoresShield: true,
  },
  {
    id: 'broca',
    name: 'Broca Perfuradora',
    description: 'Pica bastante antes de estourar, com pavio bem longo.',
    ammo: 0,
    dropOnly: true,
    damage: 30,
    radius: 65,
    windFactor: 0.4,
    knockback: 200,
    bounces: true,
    restitution: 0.65,
    fuse: 4.5,
    color: '#6b4a2f',
    size: 6,
  },
  {
    id: 'martelo',
    name: 'Martelo do Impacto',
    description: 'Quase sem dano, mas empurrao brutal. Otimo pra jogar no rio.',
    ammo: 0,
    dropOnly: true,
    damage: 8,
    radius: 55,
    windFactor: 0.8,
    knockback: 480,
    bounces: false,
    restitution: 0,
    fuse: null,
    color: '#b0b0b8',
    size: 6,
  },
  {
    id: 'flor',
    name: 'Flor Explosiva',
    description: '6 petalas simultaneas, bem proximas do centro.',
    ammo: 0,
    dropOnly: true,
    damage: 22,
    radius: 50,
    windFactor: 0.8,
    knockback: 180,
    bounces: false,
    restitution: 0,
    fuse: null,
    color: '#e05fa0',
    size: 5,
    cluster: 6,
    clusterSpread: 45,
    clusterTickGap: 0,
    clusterRadiusFactor: 0.55,
  },
  {
    id: 'vulcao',
    name: 'Erupcao Vulcanica',
    description: 'Explosao forte com succao — puxa antes de estourar.',
    ammo: 0,
    dropOnly: true,
    damage: 40,
    radius: 70,
    windFactor: 0.6,
    knockback: 260,
    bounces: false,
    restitution: 0,
    fuse: null,
    color: '#c94a1f',
    size: 6,
    vortexRadius: 100,
    vortexPull: 180,
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
