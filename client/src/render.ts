import {
  CRATE_WIDTH,
  JORBE_HEIGHT,
  JORBE_WIDTH,
  MAP_HEIGHT,
  MAP_WIDTH,
  Mat,
  type Terrain,
} from '@jorbe/shared';

/** Paleta anos 30, herdada do Jorbe original: tinta preta e tons ambar/creme. */
export const INK = '#1a0a00';
export const PALETTE = {
  sky0: '#2b1a3d',
  sky1: '#7a4a3a',
  sky2: '#d99a4e',
  rock: '#2e1c10',
  dirt: '#8a5a34',
  crust: '#d9a441',
  crustDeep: '#b8792f',
  bottle: '#4a9d4f',
  bottleDark: '#2f6b33',
  cream: '#f4e4c1',
  red: '#b23a2f',
  smoke: '#9a8a76',
};

function easeOutCubic(t: number): number {
  const p = 1 - t;
  return 1 - p * p * p;
}

// ---------------------------------------------------------------------------
// Mola critica-amortecida — motor de toda a plasticidade (squash, recuo...)
// ---------------------------------------------------------------------------

/**
 * Oscilador harmonico amortecido. Da o "boing" organico do rubber hose sem
 * precisar de curvas de animaçao desenhadas a mao: chuta a velocidade e a
 * mola faz o resto, incluindo o leve overshoot que vende a sensacao de peso.
 */
export class Spring {
  velocity = 0;

  constructor(
    public value: number,
    private readonly stiffness = 260,
    private readonly damping = 16,
  ) {}

  /** Empurra a mola (ex: impacto de pouso, coice de tiro). */
  kick(amount: number): void {
    this.velocity += amount;
  }

  snap(value: number): void {
    this.value = value;
    this.velocity = 0;
  }

  update(dt: number, target: number): number {
    const accel = (target - this.value) * this.stiffness - this.velocity * this.damping;
    this.velocity += accel * dt;
    this.value += this.velocity * dt;
    return this.value;
  }
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export class Camera {
  /** Coordenada de mundo do canto superior esquerdo da tela — nao muda de significado com o zoom. */
  x = 0;
  y = 0;
  viewW = 0;
  viewH = 0;
  /** 1 = normal, >1 aproxima (mira mais precisa), <1 afasta (ve mais mapa). */
  zoom = 1;
  private static readonly MIN_ZOOM = 0.55;
  private static readonly MAX_ZOOM = 2.4;

  /** "Trauma" de screen shake — decai sozinho, quadratico pra sumir suave. */
  private trauma = 0;
  private shakeX = 0;
  private shakeY = 0;

  setViewport(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
    this.clamp();
  }

  /** Centraliza em um ponto do mundo, sem deixar a camera sair do mapa. */
  centerOn(wx: number, wy: number): void {
    this.x = wx - this.viewW / this.zoom / 2;
    this.y = wy - this.viewH / this.zoom / 2;
    this.clamp();
  }

  /** Recebe delta em pixels de TELA (do mouse) — converte pra mundo conforme o zoom atual. */
  pan(dxScreen: number, dyScreen: number): void {
    this.x += dxScreen / this.zoom;
    this.y += dyScreen / this.zoom;
    this.clamp();
  }

  /** Aproxima suavemente de um alvo — usado no replay pra seguir a acao. */
  glideTo(wx: number, wy: number, factor: number): void {
    const tx = wx - this.viewW / this.zoom / 2;
    const ty = wy - this.viewH / this.zoom / 2;
    this.x += (tx - this.x) * factor;
    this.y += (ty - this.y) * factor;
    this.clamp();
  }

  /** Multiplica o zoom mantendo fixo o ponto do mundo no centro da tela. */
  zoomBy(factor: number): void {
    const cx = this.x + this.viewW / this.zoom / 2;
    const cy = this.y + this.viewH / this.zoom / 2;
    this.zoom = Math.min(Camera.MAX_ZOOM, Math.max(Camera.MIN_ZOOM, this.zoom * factor));
    this.x = cx - this.viewW / this.zoom / 2;
    this.y = cy - this.viewH / this.zoom / 2;
    this.clamp();
  }

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  updateShake(dt: number): void {
    this.trauma = Math.max(0, this.trauma - dt * 2.4);
    const power = this.trauma * this.trauma;
    const maxOffset = 16;
    this.shakeX = (Math.random() * 2 - 1) * maxOffset * power;
    this.shakeY = (Math.random() * 2 - 1) * maxOffset * power;
  }

  /** Posicao efetiva pra renderizar, ja com o tremor somado. */
  get renderX(): number {
    return this.x + this.shakeX;
  }
  get renderY(): number {
    return this.y + this.shakeY;
  }

  private clamp(): void {
    if (this.viewW <= 0 || this.viewH <= 0) return;
    const spanX = this.viewW / this.zoom;
    const spanY = this.viewH / this.zoom;
    const maxX = Math.max(0, MAP_WIDTH - spanX);
    const maxY = Math.max(0, MAP_HEIGHT - spanY);
    this.x = Math.min(maxX, Math.max(0, this.x));
    this.y = Math.min(maxY, Math.max(0, this.y));
  }
}

// ---------------------------------------------------------------------------
// Terreno
// ---------------------------------------------------------------------------

/**
 * Pinta o terreno uma vez num canvas do tamanho do mapa e depois so remenda
 * os retangulos sujos. Repintar 3840x1080 a cada quadro seria inviavel; com
 * remendo, uma cratera custa alguns milhares de pixels.
 */
export class TerrainRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly terrain: Terrain) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = MAP_WIDTH;
    this.canvas.height = MAP_HEIGHT;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D indisponivel neste navegador.');
    this.ctx = ctx;
    this.paintRect(0, 0, MAP_WIDTH - 1, MAP_HEIGHT - 1);
  }

  /** Aplica no desenho todas as crateras abertas desde a ultima chamada. */
  syncDirty(): void {
    for (const r of this.terrain.consumeDirty()) {
      this.paintRect(r.x0, r.y0, r.x1, r.y1);
    }
  }

  private paintRect(x0: number, y0: number, x1: number, y1: number): void {
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (w <= 0 || h <= 0) return;

    const img = this.ctx.createImageData(w, h);
    const px = img.data;
    const { data } = this.terrain;

    const rock = hexToRgb(PALETTE.rock);
    const dirt = hexToRgb(PALETTE.dirt);
    const crust = hexToRgb(PALETTE.crust);
    const crustDeep = hexToRgb(PALETTE.crustDeep);

    for (let x = 0; x < w; x++) {
      const wx = x0 + x;
      // Profundidade real desde a superficie: precisa varrer desde o topo do
      // retangulo pra crosta continuar certa quando so remendamos um pedaco.
      let depth = 0;
      for (let sy = Math.max(0, y0 - 8); sy < y0; sy++) {
        depth = data[sy * MAP_WIDTH + wx] === Mat.AIR ? 0 : depth + 1;
      }

      for (let y = 0; y < h; y++) {
        const wy = y0 + y;
        const m = data[wy * MAP_WIDTH + wx];
        const o = (y * w + x) * 4;

        if (m === Mat.AIR) {
          depth = 0;
          px[o + 3] = 0;
          continue;
        }

        depth++;
        const c = m === Mat.ROCK ? rock : depth <= 3 ? crust : depth <= 8 ? crustDeep : dirt;
        px[o] = c[0];
        px[o + 1] = c[1];
        px[o + 2] = c[2];
        px[o + 3] = 255;
      }
    }

    this.ctx.putImageData(img, x0, y0);
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------------------------------------------------------------------------
// Cenario
// ---------------------------------------------------------------------------

export function drawSky(ctx: CanvasRenderingContext2D, cam: Camera): void {
  const g = ctx.createLinearGradient(0, 0, 0, cam.viewH);
  g.addColorStop(0, PALETTE.sky0);
  g.addColorStop(0.55, PALETTE.sky1);
  g.addColorStop(1, PALETTE.sky2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cam.viewW, cam.viewH);

  // Silhueta art deco ao fundo, com parallax lento — ancorada no CHAO do
  // mapa, nao na borda da tela: se o mapa for mais baixo que a janela (mapas
  // pequenos, camera bem afastada), o horizonte falso nao pode flutuar longe
  // de onde o terreno de verdade acaba.
  const off = -cam.x * 0.25;
  const groundScreenY = (MAP_HEIGHT - cam.renderY) * cam.zoom;
  ctx.fillStyle = 'rgba(26,10,0,0.45)';
  for (let i = 0; i < 40; i++) {
    const bx = ((i * 260 + off) % (MAP_WIDTH * 0.5)) - 200;
    const bw = 90 + ((i * 37) % 70);
    const bh = 120 + ((i * 53) % 190);
    ctx.fillRect(bx, groundScreenY - bh, bw, bh);
    // Chamine
    ctx.fillRect(bx + bw * 0.3, groundScreenY - bh - 40 - ((i * 17) % 40), 14, 50);
  }
}

/** Grain de pelicula + vinheta, no espirito Fleischer/Cuphead do universo do Jorbe. */
export function drawFilmOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
  const vin = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.85);
  vin.addColorStop(0, 'rgba(0,0,0,0)');
  vin.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = vin;
  ctx.fillRect(0, 0, w, h);

  // Grao sutil: poucos pontos por quadro, trocando de posicao a cada frame.
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = '#ffffff';
  const seed = Math.floor(t * 30);
  for (let i = 0; i < 60; i++) {
    const gx = (i * 977 + seed * 233) % w;
    const gy = (i * 613 + seed * 71) % h;
    ctx.fillRect(gx, gy, 1, 1);
  }
  ctx.globalAlpha = 1;
}

/**
 * Indicador de vento grande, no topo-centro — a rajada que decide a partida.
 * Uma flamula que aponta na direcao do vento, com comprimento proporcional
 * a forca (relativa a `WIND_MAX`).
 */
export function drawWindIndicator(ctx: CanvasRenderingContext2D, viewW: number, wind: number, windMax: number): void {
  const cx = viewW / 2;
  const cy = 34;
  const mag = Math.min(1, Math.abs(wind) / windMax);
  const dir = wind >= 0 ? 1 : -1;
  const len = 26 + mag * 90;
  const calm = mag < 0.04;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = 'bold 12px Georgia, serif';
  ctx.fillStyle = 'rgba(244,228,193,0.7)';
  ctx.fillText('VENTO', cx, cy - 16);

  if (calm) {
    ctx.strokeStyle = PALETTE.cream;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 18, cy);
    ctx.lineTo(cx + 18, cy);
    ctx.stroke();
  } else {
    const color = mag > 0.7 ? PALETTE.red : PALETTE.crust;
    const x0 = cx - (dir * len) / 2;
    const x1 = cx + (dir * len) / 2;

    ctx.strokeStyle = INK;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(x0, cy);
    ctx.lineTo(x1, cy);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x0, cy);
    ctx.lineTo(x1, cy);
    ctx.stroke();

    // Ponta de flecha
    const headSize = 9 + mag * 5;
    ctx.fillStyle = color;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1, cy);
    ctx.lineTo(x1 - dir * headSize, cy - headSize * 0.7);
    ctx.lineTo(x1 - dir * headSize, cy + headSize * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  ctx.font = 'bold 16px Georgia, serif';
  ctx.fillStyle = calm ? PALETTE.cream : mag > 0.7 ? PALETTE.red : PALETTE.crust;
  ctx.fillText(calm ? 'calmo' : `${Math.abs(wind).toFixed(0)}`, cx, cy + 27);
  ctx.textAlign = 'left';
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Jorbe
// ---------------------------------------------------------------------------

export interface JorbeAnim {
  /** Fase continua da caminhada, em radianos — so avanca enquanto anda. */
  walkPhase: number;
  /** 0..1, evita o passo "travar" quando para de repente. */
  walkAmp: number;
  /** 1 = normal; <1 esprimido (pouso), >1 esticado (pulo). */
  squashY: number;
  /** Deslocamento de coice ao atirar, ja em pixels de mundo. */
  recoilX: number;
  recoilY: number;
  /** 0..1, flash branco ao levar dano. */
  hitFlash: number;
}

export const IDLE_ANIM: JorbeAnim = {
  walkPhase: 0,
  walkAmp: 0,
  squashY: 1,
  recoilX: 0,
  recoilY: 0,
  hitFlash: 0,
};

export interface JorbeDrawState {
  x: number;
  y: number;
  facing: 1 | -1;
  hp: number;
  alive: boolean;
  nick: string;
  isSelf: boolean;
  /** Angulo da mira em graus, se deve ser desenhada. */
  aimAngle: number | null;
  /** 0..1 — estica o braco da mira, feedback visual da forca escolhida. */
  aimPower: number;
  /** Texto do balaozinho de angulo/forca acima da cabeca — null esconde. */
  aimLabel: string | null;
  anim: JorbeAnim;
}

/**
 * Desenha o Jorbe Guarna: garrafao verde com rosto, luvas brancas e tenis
 * vermelhos. Tudo em path de canvas, no espirito rubber hose dos anos 30 —
 * incluindo o balanco ao andar, o esprime no pouso e o coice do tiro.
 */
export function drawJorbe(ctx: CanvasRenderingContext2D, s: JorbeDrawState): void {
  const w = JORBE_WIDTH;
  const h = JORBE_HEIGHT;
  const cx = s.x + s.anim.recoilX;
  const feet = s.y + s.anim.recoilY;
  const top = feet - h;

  const scaleY = s.anim.squashY;
  // Preserva "volume": esprime na vertical alarga na horizontal.
  const scaleX = 1 + (1 - scaleY) * 0.55;

  const legL = Math.sin(s.anim.walkPhase) * s.anim.walkAmp;
  const legR = Math.sin(s.anim.walkPhase + Math.PI) * s.anim.walkAmp;

  ctx.save();
  ctx.translate(cx, feet);
  ctx.scale(s.facing * scaleX, scaleY);

  if (!s.alive) ctx.globalAlpha = 0.35;

  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.lineJoin = 'round';

  // Corpo de garrafa
  ctx.fillStyle = PALETTE.bottle;
  ctx.beginPath();
  ctx.moveTo(-w / 2 + 2, -5);
  ctx.bezierCurveTo(-w / 2 - 1, -h * 0.45, -w / 2 + 2, -h * 0.62, -4, -h * 0.72);
  ctx.lineTo(-4, -h + 4);
  ctx.quadraticCurveTo(0, -h + 1, 4, -h + 4);
  ctx.lineTo(4, -h * 0.72);
  ctx.bezierCurveTo(w / 2 - 2, -h * 0.62, w / 2 + 1, -h * 0.45, w / 2 - 2, -5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Tenis — desenhados POR CIMA do corpo (senao o pe levantado no passo fica
  // parcialmente coberto pela garrafa). Balancam fora de fase, levantando
  // levemente quando avancam.
  ctx.fillStyle = PALETTE.red;
  ctx.beginPath();
  ctx.ellipse(-4 + legL * 4, -2 - Math.max(0, legL) * 2.5, 6, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(5 + legR * 4, -2 - Math.max(0, legR) * 2.5, 6, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Tampa
  ctx.fillStyle = PALETTE.bottleDark;
  ctx.beginPath();
  ctx.rect(-5, -h + 1, 10, 4);
  ctx.fill();
  ctx.stroke();

  // Rotulo "BRASIL"
  ctx.fillStyle = PALETTE.cream;
  ctx.beginPath();
  ctx.rect(-w / 2 + 3, -h * 0.42, w - 6, 8);
  ctx.fill();
  ctx.stroke();

  // Rosto: oculos redondos
  ctx.fillStyle = PALETTE.cream;
  ctx.beginPath();
  ctx.arc(-3, -h * 0.63, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(3.4, -h * 0.63, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(-2.6, -h * 0.63, 1.2, 0, Math.PI * 2);
  ctx.arc(3.8, -h * 0.63, 1.2, 0, Math.PI * 2);
  ctx.fill();

  // Bigode
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(-3.5, -h * 0.53);
  ctx.quadraticCurveTo(0, -h * 0.5, 3.5, -h * 0.53);
  ctx.stroke();

  // Flash de dano: aditivo, sem precisar de mascara — so clareia o que ja
  // esta desenhado nessa area, ao inves de tampar com um retangulo opaco.
  if (s.anim.hitFlash > 0.001) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,255,${0.75 * s.anim.hitFlash})`;
    ctx.beginPath();
    ctx.rect(-w / 2 - 2, -h - 2, w + 4, h + 6);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.restore();

  // Mira: braco esticado apontando pro angulo escolhido — o comprimento
  // cresce com a forca, dando pista visual de o quao longe vai o tiro.
  if (s.aimAngle !== null && s.alive) {
    const rad = (s.aimAngle * Math.PI) / 180;
    const ox = cx;
    const oy = feet - h * 0.55;
    const armLen = 14 + Math.max(0, Math.min(1, s.aimPower)) * 16;
    ctx.save();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + Math.cos(rad) * armLen, oy - Math.sin(rad) * armLen);
    ctx.stroke();
    // Luva branca na ponta
    ctx.fillStyle = PALETTE.cream;
    ctx.beginPath();
    ctx.arc(ox + Math.cos(rad) * (armLen + 2), oy - Math.sin(rad) * (armLen + 2), 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Barra de vida e nome
  const barW = 32;
  const barY = top - 14;
  ctx.fillStyle = 'rgba(26,10,0,0.7)';
  ctx.fillRect(cx - barW / 2 - 1, barY - 1, barW + 2, 6);
  ctx.fillStyle = s.isSelf ? PALETTE.bottle : PALETTE.red;
  ctx.fillRect(cx - barW / 2, barY, (barW * Math.max(0, s.hp)) / 100, 4);

  ctx.font = '10px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = s.isSelf ? PALETTE.crust : PALETTE.cream;
  ctx.fillText(s.nick, cx, barY - 4);
  ctx.textAlign = 'left';

  // Balaozinho com angulo/forca — pra mirar sem precisar olhar pro canto da tela.
  if (s.aimLabel) {
    ctx.save();
    ctx.font = 'bold 12px Georgia, serif';
    const textW = ctx.measureText(s.aimLabel).width;
    const bw = textW + 14;
    const bh = 18;
    const nickY = barY - 4;
    const gap = 6;
    const tail = 6;
    const by = nickY - gap - tail - bh;
    const bx = cx - bw / 2;

    ctx.fillStyle = 'rgba(19,8,2,0.82)';
    ctx.strokeStyle = PALETTE.crust;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 6);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx - 5, by + bh - 1);
    ctx.lineTo(cx, by + bh + tail);
    ctx.lineTo(cx + 5, by + bh - 1);
    ctx.closePath();
    ctx.fillStyle = 'rgba(19,8,2,0.82)';
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.fillStyle = PALETTE.cream;
    ctx.fillText(s.aimLabel, cx, by + bh - 5.5);
    ctx.textAlign = 'left';
    ctx.restore();
  }
}

/** Bolha translucida ao redor de quem ativou o escudo — pulsa devagar pra ficar bem visivel. */
export function drawShieldAura(ctx: CanvasRenderingContext2D, x: number, y: number, clock: number): void {
  const cx = x;
  const cy = y - JORBE_HEIGHT / 2;
  const r = JORBE_WIDTH * 1.3 + Math.sin(clock * 3) * 2;

  ctx.save();
  ctx.globalAlpha = 0.28 + Math.sin(clock * 3) * 0.06;
  ctx.fillStyle = '#6fb8d6';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = '#c9eaf6';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Icones de arma — usados no HUD, desenhados em vez de texto puro
// ---------------------------------------------------------------------------

export function drawWeaponIcon(ctx: CanvasRenderingContext2D, weaponId: string, cx: number, cy: number, size: number, color: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1.2, size * 0.08);
  ctx.fillStyle = color;

  if (weaponId === 'tampinha') {
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * size * 0.3, Math.sin(a) * size * 0.3);
      ctx.lineTo(Math.cos(a) * size * 0.44, Math.sin(a) * size * 0.44);
      ctx.stroke();
    }
  } else if (weaponId === 'bazuca') {
    ctx.rotate(-0.5);
    ctx.beginPath();
    ctx.roundRect(-size * 0.5, -size * 0.18, size * 0.85, size * 0.36, size * 0.16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.roundRect(size * 0.32, -size * 0.14, size * 0.16, size * 0.28, size * 0.05);
    ctx.fill();
  } else if (weaponId === 'granada') {
    ctx.beginPath();
    ctx.ellipse(0, size * 0.05, size * 0.34, size * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-size * 0.12, -size * 0.32);
    ctx.lineTo(size * 0.12, -size * 0.32);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -size * 0.4, size * 0.12, 0, Math.PI * 2);
    ctx.stroke();
  } else if (weaponId === 'escudo') {
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.44);
    ctx.bezierCurveTo(size * 0.4, -size * 0.32, size * 0.4, -size * 0.05, size * 0.4, size * 0.05);
    ctx.bezierCurveTo(size * 0.4, size * 0.3, size * 0.2, size * 0.42, 0, size * 0.48);
    ctx.bezierCurveTo(-size * 0.2, size * 0.42, -size * 0.4, size * 0.3, -size * 0.4, size * 0.05);
    ctx.bezierCurveTo(-size * 0.4, -size * 0.05, -size * 0.4, -size * 0.32, 0, -size * 0.44);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(1, size * 0.06);
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.24);
    ctx.lineTo(0, size * 0.26);
    ctx.moveTo(-size * 0.18, -size * 0.02);
    ctx.lineTo(size * 0.18, -size * 0.02);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Engradado de paraquedas — caixa de madeira com o paraquedas ainda preso em
 * cima, balancando devagar. Cruz vermelha pra vida, icone da arma pra municao.
 */
export function drawCrate(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  kind: 'health' | 'ammo',
  weaponId: string | undefined,
  weaponColor: string,
  bobPhase: number,
  showParachute: boolean,
): void {
  const sway = Math.sin(bobPhase) * 4;
  const size = CRATE_WIDTH;

  ctx.save();
  ctx.translate(x, y - size);

  if (showParachute) {
    // Cordas do paraquedas
    ctx.strokeStyle = 'rgba(244,228,193,0.7)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-size * 0.35, -2);
    ctx.lineTo(sway * 0.6, -size * 1.3);
    ctx.moveTo(size * 0.35, -2);
    ctx.lineTo(sway * 0.6, -size * 1.3);
    ctx.stroke();

    // Paraquedas — some pouco depois de pousar.
    ctx.save();
    ctx.translate(sway * 0.6, -size * 1.3);
    ctx.fillStyle = PALETTE.crust;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.6, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Caixa
  ctx.fillStyle = PALETTE.dirt;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(-size / 2, -size / 2, size, size, 3);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(26,10,0,0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-size / 2, 0);
  ctx.lineTo(size / 2, 0);
  ctx.moveTo(0, -size / 2);
  ctx.lineTo(0, size / 2);
  ctx.stroke();

  if (kind === 'health') {
    ctx.fillStyle = PALETTE.red;
    ctx.fillRect(-2, -size * 0.32, 4, size * 0.64);
    ctx.fillRect(-size * 0.32, -2, size * 0.64, 4);
  } else if (weaponId) {
    drawWeaponIcon(ctx, weaponId, 0, 0, size * 0.75, weaponColor);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Particulas
// ---------------------------------------------------------------------------

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  shape: 'square' | 'circle';
  gravityScale: number;
  drag: number;
  bounces: boolean;
  additive: boolean;
}

export class Particles {
  private items: Particle[] = [];
  private terrain: Terrain | null = null;

  setTerrain(t: Terrain | null): void {
    this.terrain = t;
  }

  /** Estilhaco radial da explosao: mistura poeira, brasa e destroco que quica. */
  burst(x: number, y: number, radius: number, color: string): void {
    const count = Math.min(70, Math.floor(radius * 1.3));
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const debris = Math.random() < 0.25;
      const speed = (debris ? 60 : 40) + Math.random() * radius * 5;
      this.items.push({
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 40,
        life: (debris ? 0.9 : 0.5) + Math.random() * 0.5,
        maxLife: 1,
        color: Math.random() < 0.4 ? color : PALETTE.crust,
        size: debris ? 3 + Math.random() * 3 : 1 + Math.random() * 3,
        shape: 'square',
        gravityScale: debris ? 1.3 : 1,
        drag: debris ? 0.3 : 0.6,
        bounces: debris,
        additive: false,
      });
    }
    this.puff(x, y, PALETTE.smoke, Math.min(14, Math.floor(radius / 3)));
  }

  /** Nuvem de poeira que sobe devagar e some — usada por explosao e fumaca de arma. */
  puff(x: number, y: number, color: string, count = 6): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 6 + Math.random() * 18;
      this.items.push({
        x: x + Math.cos(a) * 4,
        y: y + Math.sin(a) * 4,
        vx: Math.cos(a) * speed,
        vy: -10 - Math.random() * 14,
        life: 0.6 + Math.random() * 0.7,
        maxLife: 1,
        color,
        size: 3 + Math.random() * 5,
        shape: 'circle',
        gravityScale: -0.15,
        drag: 1.6,
        bounces: false,
        additive: false,
      });
    }
  }

  /** Estouro de luz no instante da explosao. */
  flash(x: number, y: number, radius: number): void {
    this.items.push({
      x,
      y,
      vx: 0,
      vy: 0,
      life: 0.12,
      maxLife: 0.12,
      color: PALETTE.cream,
      size: radius * 1.6,
      shape: 'circle',
      gravityScale: 0,
      drag: 0,
      bounces: false,
      additive: true,
    });
  }

  update(dt: number): void {
    for (const p of this.items) {
      p.vy += 420 * p.gravityScale * dt;
      const dragF = Math.max(0, 1 - p.drag * dt);
      p.vx *= dragF;
      p.vy *= p.gravityScale < 0 ? dragF : 1;

      const nx = p.x + p.vx * dt;
      const ny = p.y + p.vy * dt;

      if (p.bounces && this.terrain?.isSolid(Math.round(nx), Math.round(ny))) {
        if (this.terrain.isSolid(Math.round(p.x), Math.round(ny))) p.vy = -p.vy * 0.35;
        else p.vx = -p.vx * 0.35;
        p.x += p.vx * dt;
      } else {
        p.x = nx;
        p.y = ny;
      }
      p.life -= dt;
    }
    this.items = this.items.filter((p) => p.life > 0);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const p of this.items) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.globalCompositeOperation = p.additive ? 'lighter' : 'source-over';
      ctx.fillStyle = p.color;
      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  get count(): number {
    return this.items.length;
  }
}

// ---------------------------------------------------------------------------
// Onda de choque
// ---------------------------------------------------------------------------

interface Shock {
  x: number;
  y: number;
  t: number;
  maxT: number;
  maxR: number;
}

export class Shockwaves {
  private items: Shock[] = [];

  spawn(x: number, y: number, maxR: number): void {
    this.items.push({ x, y, t: 0, maxT: 0.4, maxR });
  }

  update(dt: number): void {
    for (const s of this.items) s.t += dt;
    this.items = this.items.filter((s) => s.t < s.maxT);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const s of this.items) {
      const p = s.t / s.maxT;
      const r = s.maxR * (0.3 + easeOutCubic(p) * 0.9);
      ctx.globalAlpha = (1 - p) * 0.7;
      ctx.strokeStyle = PALETTE.cream;
      ctx.lineWidth = Math.max(1, 5 * (1 - p));
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------
// Numeros de dano flutuantes
// ---------------------------------------------------------------------------

interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  t: number;
  maxT: number;
}

/** Numeros de dano que sobem e somem — feedback imediato de quanto rolou no impacto. */
export class FloatingTexts {
  private items: FloatText[] = [];

  spawn(x: number, y: number, text: string, color: string): void {
    this.items.push({ x, y, text, color, t: 0, maxT: 1.1 });
  }

  update(dt: number): void {
    for (const f of this.items) f.t += dt;
    this.items = this.items.filter((f) => f.t < f.maxT);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const f of this.items) {
      const p = f.t / f.maxT;
      const rise = easeOutCubic(p) * 34;
      ctx.save();
      ctx.globalAlpha = p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25;
      ctx.font = 'bold 18px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.strokeText(f.text, f.x, f.y - rise);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y - rise);
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------------------
// Minimapa
// ---------------------------------------------------------------------------

export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  terrainCanvas: HTMLCanvasElement,
  cam: Camera,
  players: { x: number; y: number; alive: boolean; isSelf: boolean }[],
): { x: number; y: number; w: number; h: number } {
  const w = Math.max(120, Math.min(240, cam.viewW * 0.28));
  const h = (w * MAP_HEIGHT) / MAP_WIDTH;
  const x = cam.viewW - w - 16;
  const y = 16;

  ctx.save();
  ctx.fillStyle = 'rgba(26,10,0,0.75)';
  ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
  ctx.strokeStyle = PALETTE.crust;
  ctx.lineWidth = 2;
  ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
  ctx.drawImage(terrainCanvas, x, y, w, h);

  const sx = w / MAP_WIDTH;
  const sy = h / MAP_HEIGHT;

  for (const p of players) {
    if (!p.alive) continue;
    ctx.fillStyle = p.isSelf ? PALETTE.crust : PALETTE.red;
    ctx.fillRect(x + p.x * sx - 2, y + p.y * sy - 2, 4, 4);
  }

  // Retangulo do que a camera esta vendo — encolhe com o zoom.
  ctx.strokeStyle = PALETTE.cream;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + cam.x * sx, y + cam.y * sy, (cam.viewW / cam.zoom) * sx, (cam.viewH / cam.zoom) * sy);
  ctx.restore();

  return { x, y, w, h };
}
