import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

// npm workspaces roda este script com cwd = server/, entao o dotenv precisa
// ser apontado explicitamente para o .env na raiz do monorepo.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../../.env') });

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export const env = {
  port: Number(optional('PORT', '3000')),
  mongodbUri: process.env.MONGODB_URI ?? '',
  mongodbDb: optional('MONGODB_DB', 'guerra_de_garrafas'),
  jwtSecret: process.env.JWT_SECRET ?? '',
  clientOrigin: optional('CLIENT_ORIGIN', 'http://localhost:5173'),
  isProd: process.env.NODE_ENV === 'production',
};
