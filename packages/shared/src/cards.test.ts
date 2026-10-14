import { describe, expect, it } from 'vitest';
import { CardDefinitionSearchResponseSchema, RulesDataSchema } from './cards.js';

describe('Card Definition search response', () => {
  it('enforces the fixed page size and nonnegative result totals', () => {
    expect(CardDefinitionSearchResponseSchema.safeParse({ items: [], page: 1, pageSize: 50, totalCount: 0, totalPages: 0 }).success).toBe(true);
    expect(CardDefinitionSearchResponseSchema.safeParse({ items: [], page: 1, pageSize: 25, totalCount: 0, totalPages: 0 }).success).toBe(false);
    expect(CardDefinitionSearchResponseSchema.safeParse({ items: [], page: 1, pageSize: 50, totalCount: -1, totalPages: 0 }).success).toBe(false);
  });
});

describe('rulesData limits', () => {
  it('accepts ordinary JSON data and rejects payloads above 64 KiB', () => {
    expect(RulesDataSchema.safeParse({ abilities: ['Flying'] }).success).toBe(true);
    expect(RulesDataSchema.safeParse({ text: 'x'.repeat(64 * 1024) }).success).toBe(false);
  });

  it('limits nested object and array structures to depth 16', () => {
    let within: unknown = 'leaf';
    let tooDeep: unknown = 'leaf';
    for (let level = 0; level < 14; level += 1) within = { child: within };
    for (let level = 0; level < 15; level += 1) tooDeep = { child: tooDeep };
    expect(RulesDataSchema.safeParse({ value: within }).success).toBe(true);
    expect(RulesDataSchema.safeParse({ value: tooDeep }).success).toBe(false);
  });
});
