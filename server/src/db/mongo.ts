import { MongoClient, type Db } from 'mongodb';
import { env } from '../env.js';

let client: MongoClient | null = null;
let db: Db | null = null;

/**
 * Conecta ao Atlas se MONGODB_URI estiver configurado. Sem ele o servidor
 * ainda sobe (util no comeco da F0), so que sem persistencia — cadastro,
 * login e ranking ficam indisponiveis ate a URI ser preenchida no .env.
 */
export async function connectMongo(): Promise<Db | null> {
  if (!env.mongodbUri) {
    console.warn('[mongo] MONGODB_URI vazio — rodando sem banco (sem cadastro/ranking).');
    return null;
  }
  client = new MongoClient(env.mongodbUri);
  await client.connect();
  db = client.db(env.mongodbDb);
  await db.command({ ping: 1 });
  console.log(`[mongo] conectado ao banco "${env.mongodbDb}"`);
  return db;
}

export function getDb(): Db | null {
  return db;
}

export async function disconnectMongo(): Promise<void> {
  await client?.close();
  client = null;
  db = null;
}
