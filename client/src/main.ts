import './ui.css';
import { MAPS, ROOM_MAX_PLAYERS, type RoomState, type RoomSummary } from '@jorbe/shared';
import { Net } from './net.js';
import { MatchScene } from './match.js';
import { login, logout, playGuest, register, resumeSession, type AuthUser } from './auth.js';
import * as sfx from './audio.js';
import * as music from './music.js';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <canvas id="game"></canvas>
  <div id="overlay"><div class="panel" id="panel"></div></div>
  <button id="muteBtn" class="ghost" title="Ligar/desligar som">🔊</button>
  <button id="musicMenuBtn" class="ghost" title="Volume da musica">🎵</button>
  <div id="volumePanel" class="hidden">
    <div class="label"><span>Musica</span><span id="musicVolumeValue"></span></div>
    <input type="range" id="musicVolume" min="0" max="100" />
    <button id="musicMuteToggle" class="ghost"></button>
  </div>
  <div id="connBanner" class="hidden">Conexao instavel — reconectando...</div>
  <div id="versionTag">v${__APP_VERSION__}</div>
`;

const overlay = document.querySelector<HTMLDivElement>('#overlay')!;
const panel = document.querySelector<HTMLDivElement>('#panel')!;
const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const connBanner = document.querySelector<HTMLDivElement>('#connBanner')!;
const muteBtn = document.querySelector<HTMLButtonElement>('#muteBtn')!;
const musicMenuBtn = document.querySelector<HTMLButtonElement>('#musicMenuBtn')!;
const volumePanel = document.querySelector<HTMLDivElement>('#volumePanel')!;
const musicVolumeInput = document.querySelector<HTMLInputElement>('#musicVolume')!;
const musicVolumeValue = document.querySelector<HTMLSpanElement>('#musicVolumeValue')!;
const musicMuteToggle = document.querySelector<HTMLButtonElement>('#musicMuteToggle')!;

const net = new Net();
const scene = new MatchScene(canvas, net);
scene.attachControls();

// O AudioContext so pode nascer apos um gesto real do usuario.
const unlockOnce = (): void => {
  sfx.unlock();
  music.resumeIfNeeded();
  window.removeEventListener('pointerdown', unlockOnce);
  window.removeEventListener('keydown', unlockOnce);
};
window.addEventListener('pointerdown', unlockOnce);
window.addEventListener('keydown', unlockOnce);

muteBtn.onclick = () => {
  sfx.setMuted(!sfx.isMuted());
  muteBtn.textContent = sfx.isMuted() ? '🔇' : '🔊';
};

// ---------------------------------------------------------------------------
// Menu de volume da musica — funciona igual na sala e na partida, por isso
// fica fora do #overlay (nunca escondido, feito o muteBtn).
// ---------------------------------------------------------------------------

function syncVolumeUi(): void {
  musicVolumeInput.value = String(Math.round(music.getVolume() * 100));
  musicVolumeValue.textContent = `${Math.round(music.getVolume() * 100)}%`;
  musicMuteToggle.textContent = music.isMusicMuted() ? '🔇 Musica desligada' : '🔊 Musica ligada';
}
syncVolumeUi();

musicMenuBtn.onclick = () => {
  volumePanel.classList.toggle('hidden');
};
document.addEventListener('pointerdown', (e) => {
  const target = e.target as Node;
  if (volumePanel.classList.contains('hidden')) return;
  if (volumePanel.contains(target) || musicMenuBtn.contains(target)) return;
  volumePanel.classList.add('hidden');
});
musicVolumeInput.oninput = () => {
  music.setVolume(Number(musicVolumeInput.value) / 100);
  syncVolumeUi();
};
musicMuteToggle.onclick = () => {
  music.setMusicMuted(!music.isMusicMuted());
  syncVolumeUi();
};

/** Toca a trilha certa pra cada zona do jogo — so troca quando a zona muda de verdade, senao reiniciaria a faixa a cada refreshUi(). */
let currentMusicZone: 'lobby' | 'match' | null = null;
function syncMusicZone(matchActive: boolean): void {
  const zone: 'lobby' | 'match' = matchActive ? 'match' : 'lobby';
  if (zone === currentMusicZone) return;
  currentMusicZone = zone;
  if (zone === 'match') music.startMatchMusic();
  else music.startLobbyMusic();
}

/** Some/hover em todo botao da tela atual — dar aquele "clique" de jogo de verdade. */
function wireButtonSfx(): void {
  panel.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.addEventListener('mouseenter', () => sfx.sfxUiHover());
    b.addEventListener('click', () => {
      if (!b.disabled) sfx.sfxUiClick();
    });
  });
}

let rooms: RoomSummary[] = [];
let room: RoomState | null = null;
let lastError = '';
/** Enquanto true, o lobby fica escondido mesmo que chegue roomState/chat. */
let inMatch = false;
/** null = ainda nao autenticado nesta aba. */
let user: AuthUser | null = null;
let authMode: 'login' | 'register' | 'guest' = 'login';
const chatLines: { from: string; text: string }[] = [];

// ---------------------------------------------------------------------------
// Telas
// ---------------------------------------------------------------------------

function showOverlay(show: boolean): void {
  overlay.classList.toggle('hidden', !show);
}

/**
 * Unico lugar que decide qual tela aparece. Centralizar isso evita o bug de
 * uma mensagem tardia do servidor (roomState, chat) reabrir o lobby por cima
 * de uma partida ja em andamento.
 */
function refreshUi(): void {
  if (!user) {
    showOverlay(true);
    renderAuth();
    return;
  }
  syncMusicZone(inMatch);
  if (inMatch) {
    showOverlay(false);
    return;
  }
  showOverlay(true);
  if (room) renderRoom();
  else renderLobby();
}

/** Depois de qualquer login/cadastro/convidado com sucesso: liga o socket e entra. */
async function enterAsAuthenticated(u: AuthUser): Promise<void> {
  user = u;
  net.socket.connect();
  const res = await net.connect();
  if (!res.ok) {
    user = null;
    lastError = res.reason ?? 'Nao foi possivel entrar no servidor.';
    refreshUi();
    return;
  }
  lastError = '';
  refreshUi();
}

function renderAuth(): void {
  const tabs = `
    <div class="row" style="margin-bottom:16px">
      <button class="${authMode === 'login' ? '' : 'ghost'}" id="tabLogin">Entrar</button>
      <button class="${authMode === 'register' ? '' : 'ghost'}" id="tabRegister">Criar conta</button>
      <button class="${authMode === 'guest' ? '' : 'ghost'}" id="tabGuest">Convidado</button>
    </div>
  `;

  const form =
    authMode === 'login'
      ? `
        <input id="email" type="email" placeholder="E-mail" autocomplete="username" />
        <input id="password" type="password" placeholder="Senha" autocomplete="current-password" />
        <button id="go">Entrar</button>
      `
      : authMode === 'register'
        ? `
        <input id="nick" maxlength="16" placeholder="Apelido (2-16)" autocomplete="off" />
        <input id="email" type="email" placeholder="E-mail" autocomplete="username" />
        <input id="password" type="password" placeholder="Senha (8+)" autocomplete="new-password" />
        <button id="go">Criar conta</button>
      `
        : `
        <input id="nick" maxlength="16" placeholder="Seu apelido (2-16)" autocomplete="off" />
        <button id="go">Jogar como convidado</button>
      `;

  panel.innerHTML = `
    <h1>GUERRA <span>DE GARRAFAS</span></h1>
    <p class="sub">
      <b>Multiplayer online de verdade</b> — ate ${ROOM_MAX_PLAYERS} Jorbes, todos contra
      todos, jogando ao vivo pela internet. Todo mundo mira ao mesmo tempo e os tiros
      saem juntos. Mire e atire com o <b>mouse</b> (clique e arraste, estilo estilingue)
      ou no teclado.
    </p>
    ${tabs}
    <div class="row" style="flex-direction:column;align-items:stretch">${form}</div>
    <p class="error" id="err">${escapeHtml(lastError)}</p>
    <div class="hint">
      ${
        authMode === 'guest'
          ? 'Convidado joga na hora, sem cadastro — mas nao entra no ranking nem guarda progresso.'
          : 'Com conta seu progresso fica salvo e voce entra pro ranking quando ele chegar.'
      }
    </div>
  `;
  lastError = '';

  panel.querySelector<HTMLButtonElement>('#tabLogin')!.onclick = () => {
    authMode = 'login';
    renderAuth();
  };
  panel.querySelector<HTMLButtonElement>('#tabRegister')!.onclick = () => {
    authMode = 'register';
    renderAuth();
  };
  panel.querySelector<HTMLButtonElement>('#tabGuest')!.onclick = () => {
    authMode = 'guest';
    renderAuth();
  };

  const go = panel.querySelector<HTMLButtonElement>('#go')!;
  const err = panel.querySelector<HTMLParagraphElement>('#err')!;
  const firstInput = panel.querySelector<HTMLInputElement>('input');
  firstInput?.focus();

  const submit = async (): Promise<void> => {
    go.disabled = true;
    err.textContent = '';

    const result =
      authMode === 'login'
        ? await login(
            panel.querySelector<HTMLInputElement>('#email')!.value.trim(),
            panel.querySelector<HTMLInputElement>('#password')!.value,
          )
        : authMode === 'register'
          ? await register(
              panel.querySelector<HTMLInputElement>('#email')!.value.trim(),
              panel.querySelector<HTMLInputElement>('#password')!.value,
              panel.querySelector<HTMLInputElement>('#nick')!.value.trim(),
            )
          : await playGuest(panel.querySelector<HTMLInputElement>('#nick')!.value.trim());

    if (!result.ok || !result.data) {
      err.textContent = result.error ?? 'Nao foi possivel entrar.';
      go.disabled = false;
      sfx.sfxUiError();
      return;
    }

    await enterAsAuthenticated(result.data);
  };

  go.onclick = () => void submit();
  panel.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
    input.onkeydown = (e) => {
      if (e.key === 'Enter') void submit();
    };
  });
  wireButtonSfx();
}

function renderLobby(): void {
  const list = rooms.length
    ? rooms
        .map(
          (r) => `
      <div class="item">
        <div>
          <div>${escapeHtml(r.name)}</div>
          <div class="meta">${r.players}/${r.maxPlayers} jogadores ${r.inMatch ? '· em partida' : ''}</div>
        </div>
        <button data-join="${r.id}" ${r.inMatch ? 'disabled' : ''}>Entrar</button>
      </div>`,
        )
        .join('')
    : '<div class="empty">Nenhuma sala aberta. Crie a primeira!</div>';

  panel.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <h1 style="margin:0">GUERRA <span>DE GARRAFAS</span></h1>
      <button class="ghost" id="logout" style="flex:0 0 auto">Sair</button>
    </div>
    <p class="sub">Ola, <b>${escapeHtml(net.nick)}</b>${user?.guest ? ' (convidado)' : ''}. Entre numa sala ou crie a sua.</p>
    <h2>Salas abertas</h2>
    <div class="list">${list}</div>
    <h2>Criar sala</h2>
    <div class="row">
      <input id="roomName" maxlength="28" placeholder="Nome da sala" autocomplete="off" />
      <select id="mapId">${MAPS.map((m) => `<option value="${m.id}">${m.name}</option>`).join('')}</select>
      <button id="create">Criar</button>
    </div>
    <p class="error" id="err">${escapeHtml(lastError)}</p>
  `;

  panel.querySelectorAll<HTMLButtonElement>('[data-join]').forEach((b) => {
    b.onclick = () => net.socket.emit('roomJoin', { roomId: b.dataset.join! });
  });

  const create = panel.querySelector<HTMLButtonElement>('#create')!;
  create.onclick = () => {
    const name = panel.querySelector<HTMLInputElement>('#roomName')!.value;
    const mapId = panel.querySelector<HTMLSelectElement>('#mapId')!.value;
    net.socket.emit('roomCreate', { name, mapId });
  };

  panel.querySelector<HTMLButtonElement>('#logout')!.onclick = () => void doLogout();
  lastError = '';
  wireButtonSfx();
}

async function doLogout(): Promise<void> {
  await logout();
  net.socket.disconnect();
  user = null;
  room = null;
  rooms = [];
  authMode = 'login';
  refreshUi();
}

function renderRoom(): void {
  if (!room) return;
  const isHost = room.hostId === net.playerId;
  const chips = room.players
    .map((p) => {
      const cls = p.isBot ? 'chip bot' : p.isHost ? 'chip host' : 'chip';
      const tag = p.isHost ? ' (dono)' : p.isGuest ? ' (convidado)' : '';
      const removeBtn =
        p.isBot && isHost
          ? `<button class="chip-remove" data-remove-bot="${escapeHtml(p.id)}" title="Remover Jorbot">×</button>`
          : '';
      return `<span class="${cls}">${escapeHtml(p.nick)}${tag}${removeBtn}</span>`;
    })
    .join('');

  panel.innerHTML = `
    <h2>${escapeHtml(room.name)}</h2>
    <div class="row" style="margin-bottom:12px">
      <label class="sub" style="margin:0;flex:0 0 auto;">Fase:
        <select id="mapSelect" ${isHost ? '' : 'disabled'} style="width:auto;margin-left:6px;">
          ${MAPS.map((m) => `<option value="${m.id}" ${m.id === room!.mapId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
        </select>
      </label>
      <span class="sub" style="margin:0;">${room.players.length}/${room.maxPlayers} jogadores</span>
    </div>
    <div class="players">${chips}</div>
    <div class="row">
      <button id="start" ${isHost ? '' : 'disabled'}>Comecar partida</button>
      <button id="dummy" class="ghost" ${isHost ? '' : 'disabled'}>+ Jorbot de teste</button>
      <button id="leave" class="ghost">Sair da sala</button>
    </div>
    <p class="error" id="err">${escapeHtml(lastError)}</p>
    <h2 style="margin-top:20px">Chat</h2>
    <div id="chatLog">${chatLines.map((c) => `<div><b>${escapeHtml(c.from)}:</b> ${escapeHtml(c.text)}</div>`).join('')}</div>
    <div class="row">
      <input id="chatInput" maxlength="160" placeholder="Falar com a sala..." autocomplete="off" />
      <button id="chatSend">Enviar</button>
    </div>
    <div class="hint">
      <b>Controles:</b> A/D anda · W/S ajusta o angulo · SHIFT pula ·
      SEGURE ESPACO ou clique com o BOTAO DIREITO em qualquer ponto do mapa
      e arraste (estilo estilingue) pra mirar · clique na barra de forca ou
      nas cartas de arma pra ajustar direto · botao OK trava o tiro ·
      1/2/3 troca a arma · 4 ou E arma/desarma o escudo (nao impede de
      atirar) · BOTAO ESQUERDO arrasta a camera · RODA DO MOUSE da zoom ·
      C volta a camera pro seu Jorbe.
      ${isHost ? '' : '<br>Aguardando o dono da sala comecar.'}
    </div>
  `;

  panel.querySelector<HTMLButtonElement>('#start')!.onclick = () => net.socket.emit('roomStart');
  panel.querySelector<HTMLButtonElement>('#dummy')!.onclick = () => net.socket.emit('roomAddDummy');
  panel.querySelector<HTMLButtonElement>('#leave')!.onclick = () => net.socket.emit('roomLeave');
  panel.querySelector<HTMLSelectElement>('#mapSelect')!.onchange = (e) => {
    net.socket.emit('roomSetMap', { mapId: (e.target as HTMLSelectElement).value });
  };
  panel.querySelectorAll<HTMLButtonElement>('[data-remove-bot]').forEach((btn) => {
    btn.onclick = () => net.socket.emit('roomRemoveDummy', { dummyId: btn.dataset.removeBot! });
  });

  const chatInput = panel.querySelector<HTMLInputElement>('#chatInput')!;
  const send = (): void => {
    const text = chatInput.value.trim();
    if (!text) return;
    net.socket.emit('chat', { text });
    chatInput.value = '';
  };
  panel.querySelector<HTMLButtonElement>('#chatSend')!.onclick = send;
  chatInput.onkeydown = (e) => {
    if (e.key === 'Enter') send();
  };

  const log = panel.querySelector<HTMLDivElement>('#chatLog')!;
  log.scrollTop = log.scrollHeight;
  lastError = '';
  wireButtonSfx();
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

// ---------------------------------------------------------------------------
// Eventos do servidor
// ---------------------------------------------------------------------------

net.socket.on('rooms', (list) => {
  rooms = list;
  if (!room && user) refreshUi();
});

net.socket.on('roomState', (state) => {
  room = state;
  // Sair da sala tambem encerra qualquer partida em andamento — seja saindo
  // pelo lobby, seja pelo botao "Sair da partida" durante o jogo.
  if (!state) inMatch = false;
  refreshUi();
});

net.socket.on('chat', (msg) => {
  chatLines.push({ from: msg.from, text: msg.text });
  if (chatLines.length > 60) chatLines.shift();
  refreshUi();
});

net.socket.on('errorMsg', (msg) => {
  lastError = msg;
  const err = panel.querySelector<HTMLParagraphElement>('#err');
  if (err) err.textContent = msg;
  sfx.sfxUiError();
});

net.socket.on('matchStart', () => {
  inMatch = true;
  refreshUi();
});

net.socket.on('matchEnd', () => {
  // A tela de resultado e desenhada no canvas; o lobby so volta no ESC.
  inMatch = false;
});

net.socket.on('disconnect', () => {
  if (!user) return; // desconexao deliberada do logout — ja tratada la.
  // NAO mexe em `inMatch`/`room`/`showOverlay` aqui — o socket.io tenta
  // reconectar sozinho por baixo dos panos (config padrao), e o servidor da
  // uma janela pra essa mesma identidade voltar pro lugar exato de onde
  // saiu (ver RoomManager.scheduleDisconnect). So mostra um aviso discreto
  // em cima do jogo/tela atual em vez de um beco sem saida — se realmente
  // nao voltar, o "conectando" continua ate o usuario decidir recarregar.
  connBanner.classList.remove('hidden');
});

net.onReconnected = () => {
  connBanner.classList.add('hidden');
  // O servidor ja reenviou `roomState`/`matchStart` de catch-up junto do
  // hello de reconexao — os listeners deles cuidam de resincronizar sala e
  // partida sozinhos, nao precisa fazer mais nada aqui.
};

// ESC volta ao lobby quando a partida acabou.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !scene.isOver) return;
  inMatch = false;
  refreshUi();
});

// ---------------------------------------------------------------------------
// Boot: tenta retomar sessao antes de pedir login de novo.
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  const existing = await resumeSession();
  if (existing) {
    await enterAsAuthenticated(existing);
  } else {
    refreshUi();
  }
}

void boot();
