import { z } from 'zod';

/**
 * Validacao dos payloads que chegam por socket. Antes disso a checagem era
 * ad-hoc (`String(x ?? '')`, coercao manual) — o suficiente pra nao quebrar
 * com `undefined`, mas nao pra barrar um formato de verdade inesperado (ex:
 * array em vez de string, numero fora de faixa) antes de chegar na logica.
 * `.safeParse()` nunca lanca, entao um payload malformado de um cliente com
 * bug (ou rede corrompendo o frame) vira uma recusa tratada, nunca uma
 * excecao solta dentro do handler do socket.
 */

export const helloSchema = z.object({
  engineVersion: z.number(),
});

export const roomCreateSchema = z.object({
  name: z.string().max(200).optional().default(''),
  mapId: z.string().max(64).optional().default('fabrica'),
});

export const roomJoinSchema = z.object({
  roomId: z.string().min(1).max(64),
});

export const roomRemoveDummySchema = z.object({
  dummyId: z.string().min(1).max(64),
});

export const roomSetMapSchema = z.object({
  mapId: z.string().min(1).max(64),
});

export const chatSchema = z.object({
  text: z.string().max(500),
});

export const inputSchema = z.object({
  seq: z.number(),
  left: z.boolean(),
  right: z.boolean(),
  jump: z.boolean(),
});

export const aimSchema = z.object({
  angle: z.number(),
  power: z.number(),
  weaponId: z.string().min(1).max(64),
  fire: z.boolean(),
  shield: z.boolean().optional(),
});
