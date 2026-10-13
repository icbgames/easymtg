import { describe, expect, it } from 'vitest';
import { type CardDefinition, UserIdSchema } from '@easymtg/shared';
import { DeckService, DeckServiceError } from './deck-service.js';

const userId = UserIdSchema.parse('user-1');
const definition: CardDefinition = {
  id: 'ABC123', status: 'ENABLED', currentVersion: 2,
  versions: [
    { cardDefinitionId: 'ABC123', version: 1, englishName: 'Old Name', frontImageUrl: 'https://cards.example/old.png', hasBack: false, rulesData: {}, createdAt: '2026-01-01T00:00:00.000Z' },
    { cardDefinitionId: 'ABC123', version: 2, englishName: 'Lightning Bolt', japaneseName: '稲妻', frontImageUrl: 'https://cards.example/new.png', hasBack: false, rulesData: {}, createdAt: '2026-02-01T00:00:00.000Z' },
  ],
};
const mainboard = Array.from({ length: 60 }, () => 'ABC123');

describe('DeckService', () => {
  it('explicitly saves, isolates by owner, and validates a deck against enabled definitions', () => {
    const service = new DeckService(() => [definition], () => '2026-10-09T00:00:00.000Z', () => 'deck-1');
    const deck = service.save(userId, { name: '  Test Deck ', mainboard, sideboard: [] });
    expect(deck.name).toBe('Test Deck');
    expect(service.validateForUse(userId, deck.id)).toEqual(deck);
    expect(service.list(UserIdSchema.parse('another-user'))).toEqual([]);
    expect(() => service.get(UserIdSchema.parse('another-user'), deck.id)).toThrow(DeckServiceError);
  });

  it('does not persist invalid saves or permit unavailable definitions for use', () => {
    const service = new DeckService(() => [{ ...definition, status: 'DISABLED' }]);
    expect(() => service.save(userId, { name: 'Short', mainboard: ['ABC123'], sideboard: [] })).toThrow(DeckServiceError);
    const saved = service.save(userId, { name: 'Saved', mainboard, sideboard: [] });
    expect(() => service.validateForUse(userId, saved.id)).toThrow(DeckServiceError);
  });

  it('searches latest enabled definitions with normalized AND terms and stable default ordering', () => {
    const other: CardDefinition = {
      id: 'XYZ009', status: 'DISABLED', currentVersion: 1,
      versions: [{ cardDefinitionId: 'XYZ009', version: 1, englishName: 'Lightning Other', frontImageUrl: 'https://cards.example/other.png', hasBack: false, rulesData: {}, createdAt: '2026-01-01T00:00:00.000Z' }],
    };
    const service = new DeckService(() => [other, definition]);
    const result = service.search('ＬＩＧＨＴＮＩＮＧ　稲妻');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.version).toBe(2);
    expect(result.totalPages).toBe(1);
    expect(service.search('', 2).items).toEqual([]);
    expect(() => service.search('', 0)).toThrow(DeckServiceError);
  });

  it('sorts by Japanese name and uses cardDefinitionId as a deterministic tie-breaker', () => {
    const makeDefinition = (id: string, japaneseName?: string): CardDefinition => ({
      id, status: 'ENABLED', currentVersion: 1,
      versions: [{
        cardDefinitionId: id, version: 1, englishName: 'Card',
        ...(japaneseName === undefined ? {} : { japaneseName }),
        frontImageUrl: `https://cards.example/${id}.png`, hasBack: false, rulesData: {}, createdAt: '2026-01-01T00:00:00.000Z',
      }],
    });
    const service = new DeckService(() => [
      makeDefinition('DDD004', 'い'), makeDefinition('BBB002'), makeDefinition('CCC003', 'あ'), makeDefinition('AAA001'),
    ]);

    const result = service.search('', 1, ['japaneseName']);
    expect(result.items.map(({ cardDefinitionId }) => cardDefinitionId)).toEqual(['AAA001', 'BBB002', 'CCC003', 'DDD004']);
  });
});
