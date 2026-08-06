/**
 * Deve ser o PRIMEIRO import de qualquer arquivo de teste que precise de
 * banco. `env.ts` le `process.env` uma unica vez, na carga do modulo — entao
 * isso so funciona por chegar primeiro no grafo de imports do arquivo de
 * teste, antes de `gateway.ts`/`auth.ts` puxarem `env.ts` para dentro.
 *
 * Usa o MESMO cluster Atlas do .env (nunca uma URI separada), so que um
 * banco diferente dentro dele — dropado no fim da suite. Zero custo extra
 * no free tier, zero risco de sujar os dados de desenvolvimento.
 */
process.env.MONGODB_DB = process.env.MONGODB_DB_TEST ?? 'guerra_de_garrafas_test';
