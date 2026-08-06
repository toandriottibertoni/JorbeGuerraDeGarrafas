/**
 * Limitador simples em memoria, por IP. Suficiente para um unico processo;
 * se um dia isso rodar atras de varias instancias, precisa virar Redis.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Zera o orcamento de uma chave, ou de todas se nenhuma for passada. */
  reset(key?: string): void {
    if (key) this.hits.delete(key);
    else this.hits.clear();
  }

  /** true = pode passar. Cada chamada ja consome uma tentativa. */
  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || now > entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (entry.count >= this.max) return false;
    entry.count += 1;
    return true;
  }
}

export const authLimiter = new RateLimiter(10, 15 * 60 * 1000);
