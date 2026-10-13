import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DeckIdSchema, DeckSchema, type Deck, type UserId } from '@easymtg/shared';
import type { Database } from './client.js';
import { decks, roomPlayers } from './schema.js';

export type DeckWriteInput = { id?: string; name: string; mainboard: string[]; sideboard: string[] };

export class PersistedDeckError extends Error {
  constructor(readonly code: 'DECK_NOT_FOUND' | 'INVALID_DECK' | 'DECK_IN_USE', message = code) {
    super(message);
    this.name = 'PersistedDeckError';
  }
}

/** Explicit-save Deck persistence. Drafts are never written implicitly. */
export class DeckRepository {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date(), private readonly createId: () => string = randomUUID) {}

  async save(ownerUserId: UserId, input: DeckWriteInput): Promise<Deck> {
    const parsed = DeckSchema.safeParse({
      id: input.id ?? this.createId(), ownerUserId, name: input.name,
      mainboard: input.mainboard, sideboard: input.sideboard, updatedAt: this.now().toISOString(),
    });
    if (!parsed.success) throw new PersistedDeckError('INVALID_DECK');
    const deck = parsed.data;
    const saved = await this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(decks).where(eq(decks.id, deck.id)).for('update');
      if (existing && existing.ownerUserId !== ownerUserId) throw new PersistedDeckError('DECK_NOT_FOUND');
      if (existing) {
        const [updated] = await tx.update(decks).set({
          name: deck.name, mainboard: deck.mainboard, sideboard: deck.sideboard, updatedAt: new Date(deck.updatedAt),
        }).where(eq(decks.id, deck.id)).returning();
        return updated;
      }
      const [created] = await tx.insert(decks).values({
        id: deck.id, ownerUserId, name: deck.name, mainboard: deck.mainboard, sideboard: deck.sideboard,
        updatedAt: new Date(deck.updatedAt),
      }).returning();
      return created;
    });
    if (!saved) throw new Error('Deck save completed without a returned row.');
    return this.toDomain(saved);
  }

  async get(ownerUserId: UserId, deckId: string): Promise<Deck> {
    const id = DeckIdSchema.safeParse(deckId);
    if (!id.success) throw new PersistedDeckError('DECK_NOT_FOUND');
    const [row] = await this.db.select().from(decks).where(eq(decks.id, id.data));
    if (!row || row.ownerUserId !== ownerUserId) throw new PersistedDeckError('DECK_NOT_FOUND');
    return this.toDomain(row);
  }

  async list(ownerUserId: UserId): Promise<Deck[]> {
    const rows = await this.db.select().from(decks).where(eq(decks.ownerUserId, ownerUserId)).orderBy(decks.updatedAt, decks.id);
    return rows.map((row) => this.toDomain(row));
  }

  async delete(ownerUserId: UserId, deckId: string): Promise<void> {
    const id = DeckIdSchema.safeParse(deckId);
    if (!id.success) throw new PersistedDeckError('DECK_NOT_FOUND');
    await this.db.transaction(async (tx) => {
      const [deck] = await tx.select({ id: decks.id }).from(decks)
        .where(and(eq(decks.id, id.data), eq(decks.ownerUserId, ownerUserId))).for('update');
      if (!deck) throw new PersistedDeckError('DECK_NOT_FOUND');
      const [usage] = await tx.select({ roomId: roomPlayers.roomId }).from(roomPlayers).where(eq(roomPlayers.deckId, id.data)).limit(1);
      if (usage) throw new PersistedDeckError('DECK_IN_USE');
      await tx.delete(decks).where(eq(decks.id, id.data));
    });
  }

  private toDomain(row: typeof decks.$inferSelect): Deck {
    return DeckSchema.parse({ ...row, updatedAt: row.updatedAt.toISOString() });
  }
}
