import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { ENGINE_VERSION } from '@jorbe/shared';
import { env } from './env.js';
import { getDb } from './db/mongo.js';
import { authRouter } from './http/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../../client/dist');

/**
 * Monta o Express sozinho, sem escutar porta nenhuma. Separado de `index.ts`
 * para que os testes de HTTP consigam subir o mesmo app real (helmet, cors,
 * cookies, rotas de auth) sem duplicar a configuracao.
 */
export function buildApp(): Express {
  const app = express();
  // Render (e qualquer host atras de load balancer) fica na frente do
  // processo — sem isso, req.ip veria sempre o IP do proxy, e o rate limiter
  // de auth trataria todo mundo como um unico usuario.
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: env.clientOrigin, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: '32kb' }));

  app.use('/api/auth', authRouter);

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      engineVersion: ENGINE_VERSION,
      db: getDb() ? 'connected' : 'offline',
    });
  });

  // Em producao o Express serve o build do client (o front e hospedado pela propria app).
  if (env.isProd) {
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  return app;
}
