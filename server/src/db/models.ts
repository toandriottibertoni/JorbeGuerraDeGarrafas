import { ObjectId, type Db } from 'mongodb';

/**
 * Documentos do Atlas. So duas colecoes por enquanto — salas e partidas em
 * andamento vivem em memoria (RoomManager), nunca aqui. `matches` (resultado
 * de partida, usado pelo ranking) chega na F6.
 */

export interface UserDoc {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  nick: string;
  /** Usado so para unicidade case-insensitive sem precisar de collation em toda query. */
  nickLower: string;
  createdAt: Date;
  lastLoginAt: Date;
  mmr: number;
  peakMmr: number;
  stats: {
    matches: number;
    wins: number;
    top3: number;
    kills: number;
    damage: number;
    roundsPlayed: number;
  };
  banned: boolean;
}

export interface SessionDoc {
  _id: ObjectId;
  userId: ObjectId;
  refreshTokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  userAgent: string;
}

export function usersCol(db: Db) {
  return db.collection<UserDoc>('users');
}

export function sessionsCol(db: Db) {
  return db.collection<SessionDoc>('sessions');
}

/** Chamado uma vez no boot. Indices sao idempotentes — seguro chamar sempre. */
export async function ensureIndexes(db: Db): Promise<void> {
  await usersCol(db).createIndex({ email: 1 }, { unique: true });
  await usersCol(db).createIndex({ nickLower: 1 }, { unique: true });
  await usersCol(db).createIndex({ mmr: -1 });
  await sessionsCol(db).createIndex({ refreshTokenHash: 1 }, { unique: true });
  await sessionsCol(db).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

export function newUserDefaults(): Pick<
  UserDoc,
  'createdAt' | 'lastLoginAt' | 'mmr' | 'peakMmr' | 'stats' | 'banned'
> {
  const now = new Date();
  return {
    createdAt: now,
    lastLoginAt: now,
    mmr: 1000,
    peakMmr: 1000,
    stats: { matches: 0, wins: 0, top3: 0, kills: 0, damage: 0, roundsPlayed: 0 },
    banned: false,
  };
}
