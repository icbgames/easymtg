import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDatabase } from './client.js';
import { CardDefinitionRepository } from './card-definition-repository.js';
import { cardDefinitionVersions, cardDefinitions } from './schema.js';

const enabled = Boolean(process.env.DATABASE_URL);
const database = enabled ? createDatabase() : undefined;
const suite = describe.skipIf(!enabled);

suite('CardDefinitionRepository PostgreSQL integration', () => {
  afterAll(async () => { await database?.pool.end(); });

  it('searches current enabled versions, normalizes terms, sorts, and excludes disabled cards', async () => {
    const db = database!.db;
    const repository = new CardDefinitionRepository(db);
    const ids = Array.from({ length: 4 }, () => newCardId());
    const marker = randomBytes(4).toString('hex');
    const definitions = [
      { id: ids[0]!, status: 'ENABLED', englishName: `easymtg-${marker} Alpha`, japaneseName: '青眼の白龍' },
      { id: ids[1]!, status: 'ENABLED', englishName: `easymtg-${marker} Beta`, japaneseName: null },
      { id: ids[2]!, status: 'ENABLED', englishName: `easymtg-${marker} Red`, japaneseName: '赤眼竜' },
      { id: ids[3]!, status: 'DISABLED', englishName: `easymtg-${marker} Disabled`, japaneseName: null },
    ] as const;
    try {
      await db.transaction(async (tx) => {
        await tx.insert(cardDefinitions).values(definitions.map(({ id, status }) => ({ id, status, currentVersion: 1 })));
        await tx.insert(cardDefinitionVersions).values(definitions.map(({ id, englishName, japaneseName }) => ({
          cardDefinitionId: id, version: 1, englishName, japaneseName, hasBack: false,
          frontImageUrl: `https://cards.example.test/${id}.jpg`, rulesData: {},
        })));
      });
      const normalized = await repository.search({ query: `easymtg-${marker}\u3000alpha`, page: 1, sort: ['englishName', 'cardDefinitionId'], order: ['asc', 'asc'] });
      expect(normalized.items.map(({ cardDefinitionId }) => cardDefinitionId)).toEqual([ids[0]]);

      const enabledOnly = await repository.search({ query: `easymtg-${marker}`, page: 1, sort: ['japaneseName'], order: ['desc'] });
      expect(enabledOnly.totalCount).toBe(3);
      expect(enabledOnly.items.map(({ cardDefinitionId }) => cardDefinitionId)).toEqual([ids[0], ids[2], ids[1]]);
      expect(enabledOnly.items.every(({ status }) => status === 'ENABLED')).toBe(true);
    } finally {
      await db.transaction(async (tx) => {
        await tx.delete(cardDefinitionVersions).where(inArray(cardDefinitionVersions.cardDefinitionId, [...ids]));
        await tx.delete(cardDefinitions).where(inArray(cardDefinitions.id, [...ids]));
      });
    }
  });
});

function newCardId(): string {
  const letters = [...randomBytes(3)].map((value) => String.fromCharCode(65 + value % 26)).join('');
  const digits = String(randomBytes(2).readUInt16BE(0) % 1000).padStart(3, '0');
  return `${letters}${digits}`;
}
