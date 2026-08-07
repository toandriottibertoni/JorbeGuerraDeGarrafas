import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { ENGINE_VERSION } from '@jorbe/shared';
import { env } from './env.js';
import { connectMongo } from './db/mongo.js';
import { ensureIndexes } from './db/models.js';
import { createGateway } from './net/gateway.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  if (!env.jwtSecret) {
    console.warn('[auth] JWT_SECRET vazio — login, cadastro e convidado nao vao funcionar.');
  }

  const db = await connectMongo();
  if (db) await ensureIndexes(db);

  const app = buildApp();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: env.clientOrigin, credentials: true },
    // Comprime mensagens WebSocket acima de 1KB — o plano de uma rodada
    // caotica (muitos eventos de explosao/dano) pode passar disso facil, e
    // JSON repetitivo comprime bem. Mensagens pequenas (snapshot de posicao)
    // ficam de fora: o overhead de comprimir supera o que se economiza.
    perMessageDeflate: {
      threshold: 1024,
    },
  });

  createGateway(io);

  httpServer.listen(env.port, () => {
    console.log(`[server] Guerra de Garrafas no ar em http://localhost:${env.port}`);
    console.log(`[server] engine v${ENGINE_VERSION} | modo: ${env.isProd ? 'producao' : 'dev'}`);
  });
}

main().catch((err) => {
  console.error('[server] falha ao iniciar:', err);
  process.exit(1);
});
