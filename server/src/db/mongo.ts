import { MongoClient, type Db } from 'mongodb';
import { env } from '../env.js';

let client: MongoClient | null = null;
let db: Db | null = null;

/**
 * Conecta ao Atlas se MONGODB_URI estiver configurado. Sem ele (ou se a
 * conexao falhar — rede ruim, cluster fora do ar, credencial errada) o
 * servidor ainda sobe, so que sem persistencia — cadastro, login e ranking
 * ficam indisponiveis ate o banco voltar. Antes uma falha aqui derrubava o
 * processo inteiro (o `.catch` em `main()` faz `process.exit(1)`), o que
 * tirava o jogo do ar por um problema que nem afeta a partida em si.
 */
export async function connectMongo(): Promise<Db | null> {
  if (!env.mongodbUri) {
    console.warn('[mongo] MONGODB_URI vazio — rodando sem banco (sem cadastro/ranking).');
    return null;
  }
  try {
    const c = new MongoClient(env.mongodbUri);
    await c.connect();
    const d = c.db(env.mongodbDb);
    await d.command({ ping: 1 });
    client = c;
    db = d;
    console.log(`[mongo] conectado ao banco "${env.mongodbDb}"`);
    return db;
  } catch (err) {
    console.error('[mongo] falha ao conectar — rodando sem banco (sem cadastro/ranking):', err);
    client = null;
    db = null;
    return null;
  }
}

export function getDb(): Db | null {
  return db;
}

export async function disconnectMongo(): Promise<void> {
  await client?.close();
  client = null;
  db = null;
}
