import { z } from 'zod';
import { CardDefinitionIdSchema, DeckIdSchema, UserIdSchema } from './ids.js';

export const CardDefinitionStatusSchema = z.enum(['ENABLED', 'DISABLED']);
type JsonData = null | string | number | boolean | JsonData[] | { [key: string]: JsonData };

function jsonDepth(value: JsonData, depth: number): number {
  if (Array.isArray(value)) return value.reduce<number>((maximum, item) => Math.max(maximum, jsonDepth(item, depth + 1)), depth);
  if (value !== null && typeof value === 'object') return Object.values(value).reduce<number>((maximum, item) => Math.max(maximum, jsonDepth(item, depth + 1)), depth);
  return depth;
}

export const RulesDataSchema = z.record(z.string(), z.json()).default({}).superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1024) {
    context.addIssue({ code: 'custom', message: 'rulesData must be at most 64 KiB when encoded as UTF-8 JSON.' });
  }
  if (jsonDepth(value, 1) > 16) {
    context.addIssue({ code: 'custom', message: 'rulesData JSON nesting depth must not exceed 16.' });
  }
});

export const CardDefinitionVersionSchema = z.object({
  cardDefinitionId: CardDefinitionIdSchema,
  version: z.number().int().positive(),
  englishName: z.string().trim().min(1),
  japaneseName: z.string().trim().min(1).optional(),
  backName: z.string().trim().min(1).nullable().optional(),
  frontImageUrl: z.string().url().refine((url) => url.startsWith('https://'), 'Image URL must use HTTPS.'),
  backImageUrl: z.string().url().refine((url) => url.startsWith('https://'), 'Image URL must use HTTPS.').nullable().optional(),
  hasBack: z.boolean(),
  changeDescription: z.string().optional(),
  rulesData: RulesDataSchema,
  createdAt: z.string().datetime({ offset: true }),
}).superRefine((version, context) => {
  if (version.hasBack && !version.backImageUrl) {
    context.addIssue({ code: 'custom', path: ['backImageUrl'], message: 'backImageUrl is required when hasBack is true.' });
  }
  if (!version.hasBack && version.backImageUrl != null) {
    context.addIssue({ code: 'custom', path: ['backImageUrl'], message: 'backImageUrl must be omitted or null when hasBack is false.' });
  }
  if (!version.hasBack && version.backName != null) {
    context.addIssue({ code: 'custom', path: ['backName'], message: 'backName must be omitted or null when hasBack is false.' });
  }
});

export const CardDefinitionSchema = z.object({
  id: CardDefinitionIdSchema,
  status: CardDefinitionStatusSchema,
  currentVersion: z.number().int().positive(),
  versions: z.array(CardDefinitionVersionSchema).min(1),
}).superRefine((definition, context) => {
  if (!definition.versions.some(({ version }) => version === definition.currentVersion)) {
    context.addIssue({ code: 'custom', path: ['currentVersion'], message: 'currentVersion must reference a stored version.' });
  }
  const versionNumbers = definition.versions.map(({ version }) => version);
  if (new Set(versionNumbers).size !== versionNumbers.length) {
    context.addIssue({ code: 'custom', path: ['versions'], message: 'Card definition versions must be unique.' });
  }
});

export const CardDefinitionVersionWithStatusSchema = CardDefinitionVersionSchema.extend({ status: CardDefinitionStatusSchema });
export const CardDefinitionSearchResponseSchema = z.object({
  items: z.array(CardDefinitionVersionWithStatusSchema),
  page: z.number().int().positive(),
  pageSize: z.literal(50),
  totalCount: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
}).strict();

export const DeckEntrySchema = z.object({ cardDefinitionId: CardDefinitionIdSchema, quantity: z.number().int().positive() });

export const DeckSchema = z.object({
  id: DeckIdSchema,
  ownerUserId: UserIdSchema,
  name: z.string().trim().min(1).max(100),
  mainboard: z.array(CardDefinitionIdSchema).min(60),
  sideboard: z.array(CardDefinitionIdSchema).max(15),
  updatedAt: z.string().datetime({ offset: true }),
});

export const DeckSummarySchema = z.object({
  id: DeckIdSchema,
  name: z.string().trim().min(1).max(100),
  mainboardCount: z.number().int().nonnegative(),
  sideboardCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const DeckSnapshotSchema = z.object({
  deckId: DeckIdSchema,
  deckName: z.string().trim().min(1),
  mainboard: z.array(CardDefinitionIdSchema).min(60),
  sideboard: z.array(CardDefinitionIdSchema).max(15),
});

export type CardDefinitionStatus = z.infer<typeof CardDefinitionStatusSchema>;
export type CardDefinitionVersion = z.infer<typeof CardDefinitionVersionSchema>;
export type CardDefinition = z.infer<typeof CardDefinitionSchema>;
export type CardDefinitionVersionWithStatus = z.infer<typeof CardDefinitionVersionWithStatusSchema>;
export type CardDefinitionSearchResponse = z.infer<typeof CardDefinitionSearchResponseSchema>;
export type DeckEntry = z.infer<typeof DeckEntrySchema>;
export type Deck = z.infer<typeof DeckSchema>;
export type DeckSummary = z.infer<typeof DeckSummarySchema>;
export type DeckSnapshot = z.infer<typeof DeckSnapshotSchema>;
