# Deploy no Render

O repositorio ja tem `render.yaml` — o Render le esse arquivo sozinho ao
criar o servico via "New > Blueprint".

## Passo a passo

1. **New > Blueprint** no dashboard do Render, aponte pro repositorio
   `JorbeGuerraDeGarrafas`. Ele detecta o `render.yaml` automaticamente.
2. Preencha as variaveis marcadas como "generate/enter" no dashboard:
   - `MONGODB_URI` — connection string do cluster free do Atlas
     (`mongodb+srv://usuario:senha@cluster.../?retryWrites=true&w=majority`).
   - `JWT_SECRET` — gere com:
     ```bash
     node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
     ```
3. Deploy. O Render builda com `npm install && npm run build` (typecheck
   completo + build do client) e sobe com `npm start`, que roda o servidor
   via `tsx` direto do TypeScript (mesmo motor do modo dev — evita o
   problema classico de resolucao de pacote interno num monorepo com
   workspaces, sem precisar de um passo de build separado pro server).
   Ele serve o front estatico (`client/dist`) pela mesma porta.
4. Depois do primeiro deploy, copie a URL que o Render deu
   (`https://algo.onrender.com`), va em Environment e preencha
   `CLIENT_ORIGIN` com ela. Redeploy pra aplicar.

## Atlas — rede

O projeto ja usa `0.0.0.0/0` na whitelist do MongoDB Atlas (necessario
porque o Render free nao tem IP fixo). A autenticacao continua exigindo
usuario/senha do banco — nao ha acesso aberto de verdade.

## Limitacoes do free tier do Render

- O servico hiberna apos ~15 min sem trafego. A primeira requisicao depois
  disso demora ate ~50s pra acordar, e a conexao WebSocket ativa cai nesse
  meio-tempo — o cliente reconecta sozinho, mas o jogador ve uma tela de
  "conexao perdida" por alguns segundos.
- Sem armazenamento persistente em disco: tudo bem, o projeto nao grava
  nada em disco (salas ficam em memoria, dados de conta vao pro Atlas).

## Variaveis de ambiente usadas

| Variavel | Origem | Observacao |
|---|---|---|
| `PORT` | Render define sozinho | Nao precisa configurar |
| `NODE_ENV` | `render.yaml` | Fixo em `production` |
| `MONGODB_URI` | Preencher no dashboard | Cluster free do Atlas |
| `MONGODB_DB` | `render.yaml` | `guerra_de_garrafas` |
| `JWT_SECRET` | Preencher no dashboard | Gerar um valor novo, nao reusar o do `.env` local |
| `CLIENT_ORIGIN` | Preencher apos o 1o deploy | URL publica do proprio servico |
