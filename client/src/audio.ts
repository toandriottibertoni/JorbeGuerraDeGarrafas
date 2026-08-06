/**
 * Audio sintetico via Web Audio API — zero arquivos externos, tudo osciladores
 * e ruido gerados na hora. Segue a linguagem sonora ja estabelecida no
 * universo do Jorbe (game_02/CLAUDE.md): pop de tampinha, vidro quebrando,
 * borbulha de liquido.
 *
 * O AudioContext so pode nascer depois de um gesto do usuario (clique/tecla),
 * entao `unlock()` e chamado no primeiro clique da tela de auth.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  return ctx;
}

export function unlock(): void {
  const c = ensureCtx();
  if (c && c.state === 'suspended') void c.resume();
}

export function setMuted(value: boolean): void {
  muted = value;
}

export function isMuted(): boolean {
  return muted;
}

function now(): number {
  return ctx?.currentTime ?? 0;
}

/** Ruido branco de N segundos, pronto pra plugar num filtro. */
function noiseBuffer(c: AudioContext, seconds: number): AudioBuffer {
  const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * seconds)), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

interface Tone {
  freqFrom: number;
  freqTo?: number;
  duration: number;
  type?: OscillatorType;
  gain?: number;
  delay?: number;
}

function tone(t: Tone): void {
  const c = ensureCtx();
  if (!c || !master || muted) return;
  const t0 = now() + (t.delay ?? 0);
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = t.type ?? 'square';
  osc.frequency.setValueAtTime(t.freqFrom, t0);
  if (t.freqTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, t.freqTo), t0 + t.duration);
  }
  const peak = t.gain ?? 0.2;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + t.duration);
  osc.connect(gain);
  gain.connect(master);
  osc.start(t0);
  osc.stop(t0 + t.duration + 0.02);
}

function burst(seconds: number, opts: { highpass?: number; lowpass?: number; gain?: number; delay?: number } = {}): void {
  const c = ensureCtx();
  if (!c || !master || muted) return;
  const t0 = now() + (opts.delay ?? 0);
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, seconds);
  let node: AudioNode = src;
  if (opts.highpass) {
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = opts.highpass;
    node.connect(hp);
    node = hp;
  }
  if (opts.lowpass) {
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = opts.lowpass;
    node.connect(lp);
    node = lp;
  }
  const gain = c.createGain();
  const peak = opts.gain ?? 0.3;
  gain.gain.setValueAtTime(peak, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + seconds);
  node.connect(gain);
  gain.connect(master);
  src.start(t0);
  src.stop(t0 + seconds + 0.02);
}

// ---------------------------------------------------------------------------
// Efeitos do jogo
// ---------------------------------------------------------------------------

/** Passo: toque seco e curto, tampinha batendo no chao de fabrica. Alterna grave/agudo. */
let stepToggle = false;
export function sfxStep(): void {
  stepToggle = !stepToggle;
  tone({ freqFrom: stepToggle ? 180 : 150, freqTo: 90, duration: 0.06, type: 'square', gain: 0.09 });
}

export function sfxJump(): void {
  tone({ freqFrom: 220, freqTo: 440, duration: 0.12, type: 'triangle', gain: 0.15 });
}

export function sfxLand(): void {
  burst(0.08, { lowpass: 800, gain: 0.18 });
}

/** Pop de tampinha saindo da garrafa — mais grave e mais longo pra armas maiores. */
export function sfxShot(weightHint: 'light' | 'medium' | 'heavy'): void {
  const base = weightHint === 'heavy' ? 260 : weightHint === 'medium' ? 340 : 460;
  tone({ freqFrom: base, freqTo: base * 0.35, duration: weightHint === 'heavy' ? 0.16 : 0.1, type: 'square', gain: 0.22 });
  burst(0.05, { highpass: 2000, gain: 0.08 });
}

/** Zumbido crescente enquanto segura ESPACO carregando a forca. */
export function sfxChargeTick(power: number): void {
  const f = 220 + power * 4;
  tone({ freqFrom: f, freqTo: f * 1.1, duration: 0.05, type: 'sine', gain: 0.05 });
}

/** Vidro quebrando + baque, escalado pelo raio da explosao. */
export function sfxExplosion(radius: number): void {
  const scale = Math.min(2, Math.max(0.5, radius / 40));
  burst(0.35 * scale, { highpass: 1200, gain: 0.28 });
  tone({ freqFrom: 140 / scale, freqTo: 40, duration: 0.3 * scale, type: 'sawtooth', gain: 0.22 });
  burst(0.5 * scale, { lowpass: 300, gain: 0.16, delay: 0.03 });
}

/** Borbulha liquida — acerto sem matar. */
export function sfxHit(): void {
  tone({ freqFrom: 500, freqTo: 200, duration: 0.15, type: 'sine', gain: 0.12 });
}

/** Vidro quebrando + "blub" — morte. */
export function sfxDeath(): void {
  burst(0.25, { highpass: 1500, gain: 0.2 });
  tone({ freqFrom: 300, freqTo: 60, duration: 0.4, type: 'sine', gain: 0.15, delay: 0.05 });
}

/** Sino de alarme — fabrica atingida (vida perdida). */
export function sfxAlarm(): void {
  tone({ freqFrom: 900, duration: 0.15, type: 'sawtooth', gain: 0.15 });
  tone({ freqFrom: 700, duration: 0.15, type: 'sawtooth', gain: 0.15, delay: 0.16 });
}

/** Fanfarra curta — nova rodada. */
export function sfxRoundStart(): void {
  [440, 550, 660].forEach((f, i) => tone({ freqFrom: f, duration: 0.12, type: 'triangle', gain: 0.14, delay: i * 0.09 }));
}

export function sfxUiHover(): void {
  tone({ freqFrom: 700, freqTo: 900, duration: 0.04, type: 'sine', gain: 0.05 });
}

export function sfxUiClick(): void {
  tone({ freqFrom: 500, freqTo: 300, duration: 0.06, type: 'square', gain: 0.1 });
}

export function sfxUiError(): void {
  tone({ freqFrom: 200, freqTo: 100, duration: 0.18, type: 'sawtooth', gain: 0.12 });
}

/** Tique-taque de relogio nos ultimos segundos da rodada. Alterna tick/tock. */
let tickToggle = false;
export function sfxTick(): void {
  tickToggle = !tickToggle;
  tone({ freqFrom: tickToggle ? 1500 : 1150, duration: 0.045, type: 'square', gain: 0.16 });
}

/** Rajada de vento — toca quando a rodada sorteia um vento novo. Direcao vira pan estereo. */
export function sfxWindChange(wind: number): void {
  const c = ensureCtx();
  if (!c || !master || muted) return;
  const t0 = now();

  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 0.6);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 0.7;
  bp.frequency.setValueAtTime(260, t0);
  bp.frequency.exponentialRampToValueAtTime(820, t0 + 0.35);
  bp.frequency.exponentialRampToValueAtTime(300, t0 + 0.6);

  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.1);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);

  src.connect(bp);
  if (c.createStereoPanner) {
    const pan = c.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, wind / 30));
    bp.connect(pan);
    pan.connect(gain);
  } else {
    bp.connect(gain);
  }
  gain.connect(master);
  src.start(t0);
  src.stop(t0 + 0.62);
}
