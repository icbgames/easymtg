import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { UserIdSchema } from '@easymtg/shared';
import { eq } from 'drizzle-orm';
import { createDatabase } from './client.js';
import { DeckRepository, PersistedDeckError } from './deck-repository.js';
import { decks, users } from './schema.js';

const enabled = Boolean(process.env.DATABASE_URL);
const database = enabled ? createDatabase() : undefined;
const suite = describe.skipIf(!enabled);

suite('DeckRepository PostgreSQL integration', () => {
  afterAll(async () => { await database?.pool.end(); });

  it('saves explicitly, lists and loads only owner decks, and rejects invalid or foreign updates', async () => {
    const db = database!.db;
    const repository = new DeckRepository(db);
    const owner = randomUUID();
    const otherOwner = randomUUID();
    const deckId = `deck-${randomUUID()}`;
    const cardIds = Array.from({ length: 60 }, () => 'ABC123');
    await db.insert(users).values([owner, otherOwner].map((id) => ({ id, displayName: 'Deck Repository Test' })));
    try {
      const created = await repository.save(UserIdSchema.parse(owner), { id: deckId, name: 'Primary', mainboard: cardIds, sideboard: [] });
      expect(created).toMatchObject({ id: deckId, ownerUserId: owner, mainboard: cardIds });
      expect(await repository.get(UserIdSchema.parse(owner), deckId)).toEqual(created);
      expect(await repository.list(UserIdSchema.parse(owner))).toEqual([created]);
      await expect(repository.get(UserIdSchema.parse(otherOwner), deckId)).rejects.toMatchObject({ code: 'DECK_NOT_FOUND' });
      await expect(repository.save(UserIdSchema.parse(otherOwner), { id: deckId, name: 'Overwrite', mainboard: cardIds, sideboard: [] }))
        .rejects.toBeInstanceOf(PersistedDeckError);
      await expect(repository.save(UserIdSchema.parse(owner), { id: deckId, name: 'Invalid', mainboard: ['ABC123'], sideboard: [] }))
        .rejects.toMatchObject({ code: 'INVALID_DECK' });
      const updated = await repository.save(UserIdSchema.parse(owner), { id: deckId, name: 'Updated', mainboard: cardIds, sideboard: [] });
      expect(updated.name).toBe('Updated');
    } finally {
      await db.delete(decks).where(eq(decks.id, deckId));
      await db.delete(users).where(eq(users.id, owner));
      await db.delete(users).where(eq(users.id, otherOwner));
    }
  });
});
