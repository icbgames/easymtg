import { describe, expect, it } from 'vitest';
import { UserIdSchema, PlayerIdSchema, type CardDefinition } from '@easymtg/shared';
import { DeckService } from './deck-service.js';
import { RoomService } from './room-service.js';
import { MatchService } from './match-service.js';

const card: CardDefinition = {
  id: 'ABC123', status: 'ENABLED', currentVersion: 1,
  versions: [{ cardDefinitionId: 'ABC123', version: 1, englishName: 'Card', frontImageUrl: 'https://cards.example/card.png', hasBack: false, rulesData: {}, createdAt: '2026-01-01T00:00:00.000Z' }],
};
const cards = Array.from({ length: 60 }, () => 'ABC123');

describe('RoomService', () => {
  it('creates and joins a two-player room with valid owned decks', () => {
    let id = 0;
    const decks = new DeckService(() => [card], undefined, () => `deck-${++id}`);
    const userA = UserIdSchema.parse('user-a');
    const userB = UserIdSchema.parse('user-b');
    const deckA = decks.save(userA, { name: 'A', mainboard: cards, sideboard: [] });
    const deckB = decks.save(userB, { name: 'B', mainboard: cards, sideboard: [] });
    const rooms = new RoomService(decks, () => '2026-10-09T00:00:00.000Z', () => `room-${++id}`);
    const matches = new MatchService(rooms, decks, () => [card]);
    const created = rooms.create(userA, PlayerIdSchema.parse('player-a'), deckA.id);
    expect(created.room.participants).toHaveLength(1);
    const joined = rooms.join(userB, PlayerIdSchema.parse('player-b'), created.room.id, deckB.id);
    expect(joined.room.participants).toHaveLength(2);
    expect(joined.events[0]?.type).toBe('RoomPlayerJoined');
    expect(joined.events[1]?.type).toBe('GameStarted');
    expect(joined.room.status).toBe('IN_MATCH');
    expect(matches.get(joined.room.matchId!).match.status).toBe('ACTIVE');
    expect(rooms.get(created.room.id)).toEqual(joined.room);
  });

  it('deletes a one-player waiting room when its owner leaves', () => {
    let id = 0;
    const decks = new DeckService(() => [card], undefined, () => `deck-${++id}`);
    const userA = UserIdSchema.parse('user-a');
    const deckA = decks.save(userA, { name: 'A', mainboard: cards, sideboard: [] });
    const rooms = new RoomService(decks, undefined, () => `room-${++id}`);
    const room = rooms.create(userA, PlayerIdSchema.parse('player-a'), deckA.id).room;
    const left = rooms.leave(userA, PlayerIdSchema.parse('player-a'));
    expect(left.deleted).toBe(true);
    expect(left.events.map(({ type }) => type)).toEqual(['RoomPlayerLeft']);
    expect(() => rooms.get(room.id)).toThrow();
  });
});
