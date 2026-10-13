import { randomUUID } from 'node:crypto';
import {
  CardDefinitionIdSchema, DeckIdSchema, DeckSchema,
  type CardDefinition, type CardDefinitionVersion, type Deck, type DeckId, type UserId,
} from '@easymtg/shared';

export type DeckInput = { id?: string; name: string; mainboard: string[]; sideboard: string[] };
export type CardSearchSort = 'englishName' | 'japaneseName' | 'cardDefinitionId';
export type CardSearchResult = {
  items: Array<CardDefinitionVersion & { status: 'ENABLED' | 'DISABLED' }>;
  page: number;
  pageSize: 50;
  totalCount: number;
  totalPages: number;
};

export class DeckServiceError extends Error {
  constructor(readonly code: 'DECK_NOT_FOUND' | 'INVALID_DECK' | 'CARD_DEFINITION_NOT_FOUND' | 'CARD_UNAVAILABLE' | 'INVALID_SEARCH' | 'INVALID_PAGE') {
    super(code);
    this.name = 'DeckServiceError';
  }
}

/** In-memory domain service; persistence and HTTP endpoints belong to Phase 7. */
export class DeckService {
  private readonly decks = new Map<DeckId, Deck>();

  constructor(
    private readonly definitions: () => readonly CardDefinition[],
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = randomUUID,
  ) {}

  /** Saving is explicit. Invalid drafts remain a client concern and are never stored. */
  save(userId: UserId, input: DeckInput): Deck {
    const idResult = DeckIdSchema.safeParse(input.id ?? this.createId());
    if (!idResult.success) throw new DeckServiceError('INVALID_DECK');
    const id = idResult.data;
    const previous = this.decks.get(id);
    if (previous && previous.ownerUserId !== userId) throw new DeckServiceError('DECK_NOT_FOUND');
    const parsed = DeckSchema.safeParse({
      id, ownerUserId: userId, name: input.name, mainboard: input.mainboard,
      sideboard: input.sideboard, updatedAt: this.now(),
    });
    if (!parsed.success) throw new DeckServiceError('INVALID_DECK');
    const deck = structuredClone(parsed.data);
    this.decks.set(id, deck);
    return structuredClone(deck);
  }

  get(userId: UserId, deckId: string): Deck {
    const id = DeckIdSchema.parse(deckId);
    const deck = this.decks.get(id);
    if (!deck || deck.ownerUserId !== userId) throw new DeckServiceError('DECK_NOT_FOUND');
    return structuredClone(deck);
  }

  list(userId: UserId): Deck[] {
    return [...this.decks.values()].filter((deck) => deck.ownerUserId === userId).map((deck) => structuredClone(deck));
  }

  validateForUse(userId: UserId, deckId: string): Deck {
    const deck = this.get(userId, deckId);
    const definitions = new Map(this.definitions().map((definition) => [definition.id, definition]));
    for (const rawId of [...deck.mainboard, ...deck.sideboard]) {
      const id = CardDefinitionIdSchema.parse(rawId);
      const definition = definitions.get(id);
      if (!definition) throw new DeckServiceError('CARD_DEFINITION_NOT_FOUND');
      if (definition.status !== 'ENABLED') throw new DeckServiceError('CARD_UNAVAILABLE');
    }
    return deck;
  }

  search(query: string, page = 1, sort: CardSearchSort[] = ['englishName', 'cardDefinitionId'], order: Array<'asc' | 'desc'> = sort.map(() => 'asc')): CardSearchResult {
    const normalized = query.normalize('NFKC').trim();
    if (normalized.length > 100 || sort.length === 0 || sort.length !== order.length || new Set(sort).size !== sort.length) {
      throw new DeckServiceError('INVALID_SEARCH');
    }
    if (!Number.isInteger(page) || page < 1) throw new DeckServiceError('INVALID_PAGE');
    const terms = normalized.split(/[\s\u3000]+/u).filter(Boolean).map((term) => term.toLocaleLowerCase());
    const records = this.definitions().flatMap((definition) => {
      const version = definition.versions.find(({ version: number }) => number === definition.currentVersion);
      return version ? [{ ...version, status: definition.status }] : [];
    }).filter((record) => record.status === 'ENABLED' && terms.every((term) =>
      [record.cardDefinitionId, record.englishName, record.japaneseName ?? ''].some((field) => field.normalize('NFKC').toLocaleLowerCase().includes(term)),
    ));
    records.sort((a, b) => {
      for (let index = 0; index < sort.length; index += 1) {
        const field = sort[index]!;
        const left = field === 'englishName' ? a.englishName : field === 'japaneseName' ? a.japaneseName ?? '' : a.cardDefinitionId;
        const right = field === 'englishName' ? b.englishName : field === 'japaneseName' ? b.japaneseName ?? '' : b.cardDefinitionId;
        const comparison = left.localeCompare(right, 'en');
        if (comparison !== 0) return order[index] === 'desc' ? -comparison : comparison;
      }
      return sort.includes('cardDefinitionId') ? 0 : a.cardDefinitionId.localeCompare(b.cardDefinitionId, 'en');
    });
    const pageSize = 50 as const;
    return { items: records.slice((page - 1) * pageSize, page * pageSize), page, pageSize, totalCount: records.length, totalPages: Math.ceil(records.length / pageSize) };
  }
}
