/**
 * Trilha e jingles de arquivo (mp3), separados do SFX sintetico de audio.ts.
 * Usa <audio> em vez de Web Audio API — mais simples pra faixas longas (nao
 * precisa decodificar o arquivo inteiro na memoria antes de tocar).
 *
 * Volume e mudo sao persistidos separado do SFX: o jogador pode querer ouvir
 * so os efeitos sonoros, so a musica, os dois ou nenhum.
 *
 * Os jingles de destaque (tiro fantastico, double/triple/quadra/legendary
 * kill) NAO sao musica de fundo -- sao reacao a uma jogada, no mesmo espirito
 * do SFX. Por isso obedecem ao mudo de EFEITOS (audio.ts), nao ao de musica:
 * desligar a musica de fundo nao pode calar o "TRIPLE KILL!".
 */
import { isMuted as sfxMuted } from './audio';

const VOLUME_KEY = 'jorbe_music_volume';
const MUTED_KEY = 'jorbe_music_muted';

function readVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw === null) return 0.4;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.4;
  } catch {
    return 0.4;
  }
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

let volume = readVolume();
let muted = readMuted();

/** Faixa de fundo tocando agora (loop), null quando nenhuma. */
let bgAudio: HTMLAudioElement | null = null;
let bgTracks: string[] = [];
let bgIndex = 0;

function applyBgVolume(): void {
  if (bgAudio) bgAudio.volume = muted ? 0 : volume;
}

/** Toca a proxima faixa da playlist atual quando a corrente termina, pra variar em vez de repetir a mesma. */
function playNextBgTrack(): void {
  if (bgTracks.length === 0) return;
  bgIndex = (bgIndex + 1) % bgTracks.length;
  startTrack(bgTracks[bgIndex]!);
}

function startTrack(src: string): void {
  if (bgAudio) {
    bgAudio.pause();
    bgAudio.removeEventListener('ended', playNextBgTrack);
  }
  bgAudio = new Audio(src);
  bgAudio.volume = muted ? 0 : volume;
  bgAudio.addEventListener('ended', playNextBgTrack);
  // Autoplay pode ser bloqueado sem gesto do usuario ainda — silencioso, tenta de novo no proximo start*().
  void bgAudio.play().catch(() => {});
}

function startPlaylist(tracks: string[]): void {
  bgTracks = tracks;
  bgIndex = 0;
  startTrack(tracks[0]!);
}

/** Trilha da sala/lobby — alterna entre as duas faixas disponiveis. */
export function startLobbyMusic(): void {
  startPlaylist(['/audio/lobby-1.mp3', '/audio/lobby-2.mp3']);
}

/** Trilha da partida em si — arena, mais energica. */
export function startMatchMusic(): void {
  startPlaylist(['/audio/match-1.mp3', '/audio/match-2.mp3']);
}

export function stopMusic(): void {
  if (bgAudio) {
    bgAudio.pause();
    bgAudio.removeEventListener('ended', playNextBgTrack);
    bgAudio = null;
  }
  bgTracks = [];
}

/** Volume fixo dos jingles de reacao -- nao usa o slider de musica, ja que agora sao SFX. */
const JINGLE_VOLUME = 0.8;

function playJingle(src: string): void {
  if (sfxMuted()) return;
  const a = new Audio(src);
  a.volume = JINGLE_VOLUME;
  void a.play().catch(() => {});
}

/** Jingle de "prontos!" — toca uma vez quando a primeira rodada da partida comeca. */
export function playReady(): void {
  playJingle('/audio/ready.mp3');
}

/** Jingle de tiro fantastico — toca uma vez quando alguem acerta um tiro digno de destaque. */
export function playFantastic(): void {
  playJingle('/audio/fantastic.mp3');
}

/** Jingles de multi-kill -- toca uma vez quando alguem derruba varios adversarios na mesma rodada. */
export function playDoubleKill(): void {
  playJingle('/audio/double-kill.mp3');
}

export function playTripleKill(): void {
  playJingle('/audio/triple-kill.mp3');
}

export function playQuadraKill(): void {
  playJingle('/audio/quadra-kill.mp3');
}

export function playLegendaryKill(): void {
  playJingle('/audio/legendary-kill.mp3');
}

export function setVolume(v: number): void {
  volume = Math.min(1, Math.max(0, v));
  applyBgVolume();
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    // Sem storage disponivel (modo privado etc) -- sem problema, so nao persiste.
  }
}

export function getVolume(): number {
  return volume;
}

export function setMusicMuted(value: boolean): void {
  muted = value;
  applyBgVolume();
  try {
    localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
  } catch {
    // Idem.
  }
}

export function isMusicMuted(): boolean {
  return muted;
}

/** Autoplay pode ter sido bloqueado antes do primeiro gesto do usuario -- tenta retomar. */
export function resumeIfNeeded(): void {
  if (bgAudio && bgAudio.paused) void bgAudio.play().catch(() => {});
}
