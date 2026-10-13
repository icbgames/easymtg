import { describe, expect, it } from 'vitest';
import { CardDefinitionSchema, CardDefinitionVersionSchema, DeckSchema, DeckSnapshotSchema, MatchSchema, RoomSchema, z } from './index.js';

describe('shared schema foundation', () => {
  it('exposes Zod for shared schemas', () => {
    expect(z.string().safeParse('ready').success).toBe(true);
  });

  it('validates a room owner and participant membership', () => {
    const room = {
      id: 'room-1', ownerPlayerId: 'player-1', status: 'WAITING',
      participants: [{ playerId: 'player-1', deckId: 'deck-1', connectionState: 'CONNECTED' }],
      createdAt: '2026-10-08T00:00:00.000Z',
    };
    expect(RoomSchema.safeParse(room).success).toBe(true);
    expect(RoomSchema.safeParse({ ...room, ownerPlayerId: 'player-2' }).success).toBe(false);
    expect(RoomSchema.safeParse({ ...room, status: 'IN_MATCH' }).success).toBe(false);
    expect(RoomSchema.safeParse({ ...room, status: 'IN_MATCH', matchId: 'match-1' }).success).toBe(true);
  });

  it('validates card definition versions and HTTPS images', () => {
    const version = {
      cardDefinitionId: 'ABC123', version: 1, englishName: 'Test Card',
      frontImageUrl: 'https://cards.example/front.png', hasBack: false,
      rulesData: {}, createdAt: '2026-10-08T00:00:00.000Z',
    };
    expect(CardDefinitionVersionSchema.safeParse(version).success).toBe(true);
    expect(CardDefinitionVersionSchema.safeParse({ ...version, frontImageUrl: 'http://cards.example/front.png' }).success).toBe(false);
    expect(CardDefinitionVersionSchema.safeParse({ ...version, backName: 'Back' }).success).toBe(false);
    expect(CardDefinitionSchema.safeParse({ id: 'ABC123', status: 'ENABLED', currentVersion: 2, versions: [version] }).success).toBe(false);
  });

  it('uses the specified saved Deck and DeckSnapshot board representation', () => {
    const mainboard = Array.from({ length: 60 }, () => 'ABC123');
    expect(DeckSchema.safeParse({ id: 'deck-1', ownerUserId: 'user-1', name: 'Deck', mainboard, sideboard: [], updatedAt: '2026-10-08T00:00:00.000Z' }).success).toBe(true);
    expect(DeckSchema.safeParse({ id: 'deck-1', ownerUserId: 'user-1', name: 'Deck', mainboard: ['ABC123'], sideboard: [], updatedAt: '2026-10-08T00:00:00.000Z' }).success).toBe(false);
    expect(DeckSchema.safeParse({ id: 'deck-1', ownerUserId: 'user-1', name: 'Deck', mainboard, sideboard: Array.from({ length: 16 }, () => 'ABC123'), updatedAt: '2026-10-08T00:00:00.000Z' }).success).toBe(false);
    expect(DeckSnapshotSchema.safeParse({ deckId: 'deck-1', deckName: 'Deck', mainboard, sideboard: [] }).success).toBe(true);
  });

  it('restricts Match status and validates optional active Game references', () => {
    const match = { id: 'match-1', roomId: 'room-1', playerIds: ['player-1', 'player-2'], status: 'ACTIVE', currentGameNumber: 1, createdAt: '2026-10-08T00:00:00.000Z' };
    expect(MatchSchema.safeParse(match).success).toBe(true);
    expect(MatchSchema.safeParse({ ...match, activeGameId: 'game-1' }).success).toBe(true);
    expect(MatchSchema.safeParse({ ...match, status: 'IN_PROGRESS' }).success).toBe(false);
  });
});
