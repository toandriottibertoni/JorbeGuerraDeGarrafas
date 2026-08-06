# Guerra de Garrafas — Plano de Projeto

Jogo de artilharia online no navegador, estilo **Gunbound + Worms**, com resolução de
turnos **simultânea**, terreno destrutível pixel-perfect e o **Jorbe Guarna** como único
personagem jogável. Tom cômico, estética cartoon anos 30 (rubber hose / Cuphead),
herdada de `C:\Projeto\games\game_02`.

---

## 1. Decisões fechadas

| Tema | Decisão |
|---|---|
| Combate | Híbrido com **rodada simultânea**: 30s todo mundo se move e mira, no fim **todos os tiros saem juntos** |
| Terreno | Destrutível **pixel-perfect** (bitmask) |
| Partida | **Todos contra todos**, até **15 jogadores**. Quem morre vira espectador. Vence o último vivo |
| Armas | **Arsenal estilo Worms**: escolhe a arma a cada rodada, munição limitada (exceto a básica) |
| Poderes | **Engradados de paraquedas** caem entre rodadas, coletados andando por cima |
| Autoridade | **Servidor calcula tudo** (física, terreno, dano). Cliente só manda intenção |
| Stack | **TypeScript**, monorepo com `shared/` rodando nos dois lados |
| Render | **Canvas 2D escrito à mão** (sem engine) |
| Arte | **Vetorial em código**, estilo `game_02` |
| Plataforma | **Desktop + mobile responsivo** |
| Login | E-mail + senha (bcrypt/JWT) **+ modo convidado** (não pontua) |
| Ranking | **MMR estilo Elo** adaptado a FFA + patentes cômicas + leaderboard |
| Economia | **Nenhuma por enquanto** (sem moedas/skins) |
| Salas | **Lobby com lista de salas** (criar, entrar, senha, dono dá start) |
| Bots | **Sim**, preenchem sala. Não valem MMR |
| Social | **Chat no lobby e na sala** (mortos falam entre si), com anti-flood |
| Conteúdo v1 | **6 armas / 3 mapas** |
| Mira | **Ângulo + barra de força** (setas + segurar espaço) |
| Mapa | **Largo (~3x tela)**, câmera livre + minimapa, replay cinematográfico na resolução |
| Dano | Projéteis colidem entre si · knockback · dano de queda · morte ao cair do mapa |
| Banco | **MongoDB Atlas free (M0)** |
| Hosting | Local agora; Dockerfile + env prontos pra deploy free depois |

---

## 2. Loop de jogo

Uma **partida** é uma sequência de **rodadas**. Cada rodada tem 3 fases:

### Fase PREPARO — 30s (todos ao mesmo tempo)
- Anda para esquerda/direita e pula, gastando uma **barra de combustível** (~400px por rodada).
- Escolhe a arma do arsenal (munição limitada).
- Ajusta **ângulo** (setas ou dial no toque) e segura **espaço** para carregar a **força** (0–100).
- Câmera livre (arrastar / bordas / minimapa) para observar o mapa.
- **A mira dos outros é secreta** — você vê onde eles estão, não pra onde apontam.
- Quem não confirmar tiro até o fim do timer, dispara com os últimos valores (ou não atira).

### Fase RESOLUÇÃO — ~5 a 15s (cinematográfica)
- Todos os projéteis nascem **no mesmo instante**.
- Física roda em passo fixo: gravidade + vento + colisão com terreno **e entre projéteis**.
- Explosões abrem cratera real, aplicam dano em raio e **knockback**.
- Terreno solto desaba; quem cai de muito alto toma **dano de queda**; quem sai do mapa **morre na hora**.
- Câmera segue automaticamente o projétil/explosão mais relevante.

### Fase INTERVALO — ~6s
- Caem os **engradados** de paraquedas em pontos aleatórios (munição, kit médico, poder).
- A partir da rodada N, o **mar de refrigerante** começa a subir e corrói as bordas do mapa.
- Placar rápido, novo vento sorteado, próxima rodada.

**Fim de partida:** sobra 1 vivo (ou timeout de rodadas → vence quem tem mais HP).
Mortos entram em modo espectador com câmera livre e chat próprio.

---

## 3. Arquitetura

```
Navegador (Canvas 2D + TS)
  │  HTTP  → auth, perfil, leaderboard, arquivos estáticos do front
  │  WS    → lobby, chat, sala, partida (Socket.IO, payload binário nos snapshots)
  ▼
Node.js (Express + Socket.IO)
  ├── auth        bcrypt + JWT (cookie httpOnly) + convidado
  ├── lobby       salas EM MEMÓRIA (não vão pro Mongo)
  ├── match       motor autoritativo: terreno, física, armas, dano, bots
  └── persist     MongoDB Atlas — só usuários e resultado de partidas
```

**Ponto-chave:** as salas e o estado de partida vivem **só em memória**. O Atlas free
(M0) só é tocado no cadastro/login e ao **encerrar** uma partida — mantém o uso de
operações baixíssimo e cabe folgado nos 512 MB.

### Monorepo

```
guerra-de-garrafas/
├─ package.json            (npm workspaces)
├─ shared/                 código idêntico nos dois lados
│   ├─ protocol.ts         tipos de todas as mensagens WS
│   ├─ constants.ts        gravidade, timers, tamanhos, versão do protocolo
│   ├─ rng.ts              PRNG determinístico por seed (xorshift/mulberry32)
│   ├─ terrain.ts          geração por seed, bitmask, destruição, desabamento
│   ├─ physics.ts          passo fixo: projéteis, personagem, colisão
│   ├─ weapons.ts          catálogo de armas (dados + comportamento)
│   └─ elo.ts              MMR de free-for-all
├─ server/
│   ├─ index.ts            Express + Socket.IO + serve o build do client
│   ├─ http/               rotas REST (auth, perfil, leaderboard)
│   ├─ db/                 conexão Atlas, modelos, índices
│   ├─ lobby/              salas, chat, matchmaking
│   ├─ match/              MatchEngine (fases, autoridade, replay), bots
│   └─ security/           rate-limit, validação (zod), sanitização de chat
├─ client/
│   ├─ index.html          shell + Vite
│   ├─ scenes/             login · lobby · sala · partida · resultado · perfil
│   ├─ render/             câmera, terreno, jorbe, projéteis, partículas, HUD, minimapa
│   ├─ art/                desenhos vetoriais (Jorbe, armas, cenários) — porta do game_02
│   ├─ input/              teclado/mouse + touch (joystick + dial de ângulo)
│   ├─ net/                cliente Socket.IO, predição e reconciliação
│   └─ audio/              Web Audio (ragtime, pop de tampinha, vidro quebrando)
└─ docs/
```

O Express serve o build do Vite (`client/dist`) — **o front é hospedado pela própria
aplicação Node**, como pedido. Um processo só, uma porta só.

---

## 4. Terreno pixel-perfect

- **Estrutura:** `Uint8Array` de `W × H` (v1: 3840 × 1080 ≈ 4 MB por partida no servidor).
  0 = ar, 1 = terra, 2 = rocha (indestrutível), 3 = líquido.
- **Geração:** 100% determinística a partir de uma **seed inteira** — ruído de valor por
  hash inteiro (sem `Math.random`, sem depender de float da plataforma) + cavernas +
  plataformas. Cliente e servidor geram o **mesmo mapa** só recebendo `{mapId, seed}`.
- **Destruição:** cada explosão vira uma operação `{x, y, r, tipo}`. O histórico de
  operações é minúsculo (dezenas de bytes por explosão) — é isso que trafega, nunca a
  bitmask inteira.
- **Espectador entrando no meio:** recebe `seed` + lista de ops e reconstrói tudo.
- **Desabamento:** flood-fill dos blocos que perderam suporte, virando "queda" que causa
  dano de queda em quem estiver embaixo/em cima.

## 5. Física e determinismo

- Passo fixo `dt = 1/60`, sub-stepping nos projéteis rápidos para não atravessar parede fina.
- **Modelo de sincronia — "simulação guiada por eventos":** o servidor é a verdade. Ele
  simula a resolução inteira e envia um **log de eventos** compacto (nascimento de cada
  projétil com condições iniciais exatas, explosões com posição e frame, ops de terreno,
  dano, knockback, mortes). O cliente roda a **mesma** simulação de `shared/` para desenhar
  movimento suave, mas **encaixa à força** em cada evento do servidor. Cada explosão é um
  ponto de sincronização rígido, então qualquer divergência numérica morre em milissegundos
  e nunca vira erro de gameplay.
- **Movimento na fase de preparo:** servidor simula a 30 Hz e transmite snapshots a 15 Hz
  (delta-comprimido, binário). Cliente faz predição local + reconciliação — andar responde
  na hora mesmo com 150ms de ping. Só posição/estado é público; **mira é privada**.
- Banda estimada: ~2–4 KB/s por jogador com sala cheia. Irrelevante.

## 6. Armas (v1)

| Arma | Munição | Comportamento |
|---|---|---|
| **Tampinha** | ∞ | Tiro básico giratório, cratera pequena, dano baixo |
| **Bazuca de Gás** | 4 | Dano e cratera médios, muito afetada pelo vento |
| **Granada de Espuma** | 3 | Quica no terreno, explode em 3s, espalha espuma escorregadia |
| **Chuva de Tampinhas** | 2 | Cluster: estoura no ar e cospe 6 tampinhas |
| **Broca de Abridor** | 3 | Perfura fundo em vez de explodir — cava túnel / derruba o chão do inimigo |
| **Dinamitão** | 1 | Cratera enorme, knockback brutal, arco curto (arma de finalizar) |

Regras: cada arma tem `dano`, `raio`, `massa`, `arrasto`, `sensibilidade ao vento` e
`delay de detonação` — tudo em `shared/weapons.ts`, um objeto de dados por arma, para
balancear sem mexer em lógica.

Engradados de paraquedas: **Munição** (2 usos de uma arma aleatória), **Kit Médico**
(+30 HP) e **Poder** (dano dobrado na próxima rodada / escudo / combustível extra).

## 7. Contas, ranking e banco

### Coleções (MongoDB Atlas M0)

```
users     { _id, email↑unique, passwordHash, nick↑unique, createdAt, lastLoginAt,
            mmr, peakMmr, stats{ matches, wins, top3, kills, damage, roundsPlayed },
            banned }
matches   { _id, mapId, seed, startedAt, endedAt, rounds, engineVersion,
            players:[{ userId, nick, isBot, placement, kills, damage, mmrBefore, mmrAfter }] }
sessions  { _id, userId, refreshTokenHash, expiresAt, ua }   (TTL index)
```

Índices: `email` unique, `nick` unique (collation case-insensitive), `mmr` desc
(leaderboard), `matches.endedAt` desc, `matches.players.userId`, TTL em `sessions`.

### Autenticação
- Cadastro/login com **bcrypt** (cost 11), validação com **zod**, rate-limit por IP.
- **Access token JWT** (15 min) em cookie `httpOnly` + `SameSite=Lax`; **refresh token**
  rotativo (30 dias) guardado com hash em `sessions`.
- **Convidado:** token efêmero assinado, nick `Convidado#1234`, **não** vai pro Mongo,
  **não** pontua MMR, não aparece no leaderboard.

### MMR (Elo adaptado a free-for-all)
Cada partida vira `n×(n−1)/2` confrontos par a par: para cada dupla, quem terminou em
colocação melhor "venceu". Ganho total = `K/(n−1) × Σ(resultado − esperado)`, com
`K = 40` nas 10 primeiras partidas e `K = 24` depois. Bots são ignorados no cálculo.

**Patentes:** Tampinha Amassada → Lata Zero → Long Neck → Garrafa 600 → Litrão →
Garrafão de Ouro → **Jorbe Supremo**.

## 8. Bots

- Rodam no servidor, usando **exatamente a mesma interface de comando** de um jogador
  (mover, escolher arma, ângulo, força) — nada de trapaça interna.
- Mira: busca binária no ângulo simulando a trajetória real contra o alvo escolhido,
  depois aplica **erro gaussiano** proporcional à dificuldade (fácil σ≈8°, difícil σ≈1.5°).
- Comportamento: escolhe alvo por proximidade/HP baixo, anda pra pegar engradado próximo,
  foge da borda quando o mar sobe.
- Nome no formato `Jorbot Silva`, com ícone de robô — sempre identificável.

## 9. Segurança e anti-abuso

- Tudo que importa é validado no servidor: ângulo `0–360`, força `0–100`, arma no
  inventário, munição > 0, combustível gasto, taxa de inputs.
- Chat: limite de tamanho, anti-flood (token bucket), filtro de palavrão básico,
  escapado no render (sem HTML).
- Salas com senha guardam **hash**, não texto plano.
- Helmet, CORS restrito, limite de payload, e `engineVersion` na mensagem de handshake
  pra recusar cliente desatualizado.

## 10. Marcos de entrega

| # | Marco | Entrega verificável | Estado |
|---|---|---|---|
| **F0** | Fundação | Monorepo TS + Vite + Express + Socket.IO no ar; Atlas conectado; `npm run dev` sobe tudo numa porta | ✅ feito |
| **F1** | Conta e lobby | Cadastro/login/convidado funcionando; lobby lista salas; criar/entrar/sair; chat; dono dá start | ✅ feito |
| **F2** | Mundo offline | Gerador de mapa por seed, terreno destrutível, Jorbe andando/pulando, câmera + minimapa, mira ângulo/força | ✅ feito |
| **F3** | Rodada online | As 3 fases sincronizadas, movimento com predição, mira secreta, resolução autoritativa, HP/knockback/queda/morte, fim de partida com 15 slots | ✅ feito |
| **F4** | Conteúdo | As 6 armas, os 3 mapas, engradados de paraquedas, mar de refrigerante subindo | ⏳ 3 armas de 6; 3 mapas prontos |
| **F5** | Bots | Sala enche com Jorbots; 3 dificuldades; partida jogável sozinho | ⏳ existe um Jorbot "manequim" (não anda, não atira) só pra testar |
| **F6** | Ranking | Persistência de partidas, MMR/Elo, patentes, leaderboard, perfil com estatísticas | ⏳ pendente |
| **F7** | Polimento | Áudio (ragtime + pops + vidro), efeitos, controles de toque, responsivo, Dockerfile e deploy | ⏳ efeitos sonoros/visuais e `render.yaml`/`DEPLOY.md` prontos adiantado (ver nota); falta música de fundo e controles de toque |

Cada marco termina com algo jogável ou clicável — nada de fase só de encanamento.

## 11. Riscos e como tratamos

| Risco | Mitigação |
|---|---|
| Divergência cliente/servidor na física | Servidor é a verdade; cada explosão é ponto de sincronização rígido; geração de mapa por aritmética inteira |
| 15 jogadores é difícil de juntar | Bots desde a F5; sala inicia com poucos humanos; mapa se ajusta ao número |
| Free tier hiberna e derruba WebSocket | Desenvolvimento local; no deploy, reconexão automática com retomada de sala e aviso na UI |
| Escopo crescendo sem fim | Economia, skins, times, temporadas e amigos estão **fora** da v1 — anotados como pós-lançamento |
| Mobile atrasando o resto | Input de toque só na F7, mas com canvas e HUD já escaláveis desde a F2 |
| Rodada de 30s ficar lenta com 15 pessoas | Timer encurta automaticamente conforme jogadores morrem (30s → 20s → 15s) |

## 12. Fora do escopo da v1 (backlog)

Times/2v2 · moedas e skins · itens compráveis · temporadas com reset · lista de amigos ·
replays salvos · torneios · clima por mapa · editor de mapa · som por voz.
