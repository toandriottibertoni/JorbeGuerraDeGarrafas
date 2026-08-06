/**
 * Constantes compartilhadas entre cliente e servidor.
 *
 * Regra: qualquer numero que influencie o resultado de uma partida mora aqui ou
 * em `weapons.ts`. Nunca duplique um valor desses no cliente — divergencia entre
 * os dois lados e a principal fonte de bug em jogo com simulacao compartilhada.
 */

/** Versao do protocolo/motor. Cliente com versao diferente e recusado no handshake. */
export const ENGINE_VERSION = 6;

/** Passo fixo da simulacao, em segundos. Nunca use delta de frame real na fisica. */
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

/** Frequencia com que o servidor simula a fase de preparo. */
export const PREP_TICK_RATE = 30;
export const PREP_DT = 1 / PREP_TICK_RATE;
/** Frequencia com que o servidor transmite snapshots de posicao na fase de preparo. */
export const SNAPSHOT_RATE = 15;

/** Duracao das fases da rodada, em segundos. */
export const PHASE_PREP_SECONDS = 30;
export const PHASE_INTERVAL_SECONDS = 6;
/**
 * Quando todos os jogadores humanos vivos travam o tiro, a rodada nao
 * precisa esperar o resto do timer — resolve com essa folga curta, so pra
 * nao cortar seco. Bots/dummies nao entram nessa conta.
 */
export const EARLY_RESOLVE_GRACE_MS = 600;
/** Teto de seguranca: se a fisica nao assentar, a resolucao e cortada. */
export const PHASE_RESOLVE_MAX_SECONDS = 20;
export const PHASE_RESOLVE_MAX_TICKS = PHASE_RESOLVE_MAX_SECONDS * TICK_RATE;

/**
 * O timer de preparo encurta conforme jogadores morrem, senao o fim de partida
 * com 2 sobreviventes vira uma eternidade.
 */
export function prepSecondsFor(alivePlayers: number): number {
  if (alivePlayers <= 2) return 15;
  if (alivePlayers <= 5) return 20;
  return PHASE_PREP_SECONDS;
}

/** Limites de sala. */
export const ROOM_MAX_PLAYERS = 15;
export const ROOM_MIN_PLAYERS_TO_START = 2;

/** Dimensoes do mapa, em pixels. Largo o bastante pra ter exploracao. */
export const MAP_WIDTH = 3840;
export const MAP_HEIGHT = 1080;

/** Personagem. */
export const JORBE_MAX_HP = 100;
export const JORBE_WIDTH = 22;
export const JORBE_HEIGHT = 30;
/** Deslocamento maximo (px) que um Jorbe pode gastar por rodada. */
export const JORBE_FUEL_PER_ROUND = 400;
export const WALK_SPEED = 78;
export const JUMP_SPEED = 235;
/** Degrau maximo que o Jorbe sobe andando, sem precisar pular. */
export const MAX_STEP_UP = 7;

/** Mundo. */
export const GRAVITY = 520; // px/s^2
export const WIND_MAX = 30; // px/s^2 lateral, sorteado por rodada
/** Atrito do ar aplicado ao knockback do personagem, por segundo. */
export const KNOCKBACK_DRAG = 1.6;

/** Dano de queda: so acima dessa velocidade vertical (px/s). */
export const FALL_DAMAGE_MIN_SPEED = 420;
export const FALL_DAMAGE_PER_SPEED = 0.09;

/** Mira. */
export const MIN_POWER = 5;
export const MAX_POWER = 100;
/** Velocidade inicial do projetil com forca 100. */
export const POWER_TO_SPEED = 9.6;

/**
 * Engradados de paraquedas: caem entre rodadas, somem se ninguem pegar ate
 * o fim do proximo preparo. 0 a 2 por intervalo, metade vida metade municao.
 */
export const CRATE_MIN_PER_INTERVAL = 0;
export const CRATE_MAX_PER_INTERVAL = 2;
export const CRATE_HEAL_AMOUNT = 30;
export const CRATE_AMMO_REFILL = 2;
/** Raio de coleta, em pixels, a partir do centro do Jorbe. */
export const CRATE_PICKUP_RADIUS = 26;

/** Chaves usadas nos cookies de sessao. */
export const ACCESS_COOKIE = 'jb_access';
export const REFRESH_COOKIE = 'jb_refresh';
