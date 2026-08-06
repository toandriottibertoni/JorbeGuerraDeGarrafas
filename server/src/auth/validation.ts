import { z } from 'zod';

/** Sem HTML, sem espaco sobrando, tamanho controlado. Usado em nick, sala e chat. */
export function stripDangerousChars(raw: string): string {
  return raw.replace(/[<>&"'`]/g, '').trim();
}

export const nickSchema = z
  .string()
  .transform(stripDangerousChars)
  .pipe(z.string().min(2, 'Apelido muito curto.').max(16, 'Apelido muito longo.'));

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().email('E-mail invalido.'))
  .pipe(z.string().max(254));

export const passwordSchema = z
  .string()
  .min(8, 'Senha precisa de pelo menos 8 caracteres.')
  .max(200);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  nick: nickSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Senha obrigatoria.').max(200),
});

export const guestSchema = z.object({
  nick: nickSchema,
});

/** Extrai a primeira mensagem de erro do zod, pronta pra mostrar ao usuario. */
export function firstIssue(err: z.ZodError): string {
  return err.issues[0]?.message ?? 'Dados invalidos.';
}
