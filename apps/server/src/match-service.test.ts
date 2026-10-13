import { describe, expect, it } from 'vitest';
import { PlayerIdSchema, UserIdSchema, type CardDefinition } from '@easymtg/shared';
import { DeckService } from './deck-service.js';
import { MatchService, MatchServiceError } from './match-service.js';
import { RoomService } from './room-service.js';

const card: CardDefinition = {
  id: 'ABC123', status: 'ENABLED', currentVersion: 1,
  versions: [{ cardDefinitionId: 'ABC123', version: 1, englishName: 'Card v1', frontImageUrl: 'https://cards.example/card.png', hasBack: false, rulesData: {}, createdAt: '2026-01-01T00:00:00.000Z' }],
};
const mainboard = Array.from({ length: 60 }, () => 'ABC123');

describe('MatchService', () => {
  it('auto-starts Game 1 on second join, snapshots each Game, and runs through Game 5', async () => {
    let definitions = [card];
    const decks = new DeckService(() => definitions);
    const userA = UserIdSchema.parse('user-a');
    const userB = UserIdSchema.parse('user-b');
    const playerA = PlayerIdSchema.parse('player-a');
    const playerB = PlayerIdSchema.parse('player-b');
    const deckA = decks.save(userA, { name: 'Deck A', mainboard, sideboard: [] });
    const deckB = decks.save(userB, { name: 'Deck B', mainboard, sideboard: [] });
    const rooms = new RoomService(decks);
    const matches = new MatchService(rooms, decks, () => definitions);
    const room = rooms.create(userA, playerA, deckA.id).room;
    const joined = rooms.join(userB, playerB, room.id, deckB.id);
    const matchId = joined.room.matchId!;
    const initial = matches.get(matchId);
    expect(initial.match.currentGameNumber).toBe(1);
    expect(initial.match.activeGameId).toBe(initial.games[0]?.id);
    expect(initial.snapshots[0]?.decks[0].deckName).toBe('Deck A');
    expect(new Set(Object.values(matches.processor.getState(initial.games[0]!.id)!.cards).map(({ cardDefinitionVersion }) => cardDefinitionVersion))).toEqual(new Set([1]));

    const gameOneId = initial.games[0]!.id;
    matches.processor.setPlayerConnected(gameOneId, playerA, true);
    matches.processor.setPlayerConnected(gameOneId, playerB, true);
    const gameOneState = matches.processor.getState(gameOneId)!;
    const library = gameOneState.zones.find(({ type, ownerPlayerId }) => type === 'LIBRARY' && ownerPlayerId === playerA)!;
    await matches.processor.process(gameOneId, playerA, {
      type: 'StartView', commandId: 'view-game-1', payload: { sourceZoneId: library.zoneId, viewType: 'LIBRARY_TOP', count: 2 },
    });
    const concede = await matches.processor.process(gameOneId, playerA, { type: 'Concede', commandId: 'concede-game-1' });
    expect(concede.result.success).toBe(true);
    expect(concede.notifications.map(({ type }) => type)).toEqual(['ViewStateEnded', 'ViewStateEnded']);
    expect(matches.syncGameEnd(gameOneId).map(({ type }) => type)).toEqual(['GameEnded']);

    definitions = [{ ...card, currentVersion: 2, versions: [...card.versions, { ...card.versions[0]!, version: 2, englishName: 'Card v2', createdAt: '2026-02-01T00:00:00.000Z' }] }];
    decks.save(userB, { id: deckB.id, name: 'Deck B sideboarded', mainboard, sideboard: [] });
    matches.selectDeck(room.id, userB, playerB, deckB.id);
    const second = matches.startNextGame(room.id, playerA);
    expect(second.game.number).toBe(2);
    expect(second.snapshots[1].deckName).toBe('Deck B sideboarded');
    expect(new Set(Object.values(matches.processor.getState(second.game.id)!.cards).map(({ cardDefinitionVersion }) => cardDefinitionVersion))).toEqual(new Set([2]));

    for (let expectedGame = 2; expectedGame <= 5; expectedGame += 1) {
      const active = matches.get(matchId).match.activeGameId;
      expect(active).toBeDefined();
      const state = matches.processor.getState(active!)!;
      if (expectedGame < 5) {
        expect(state.status).toBe('PLAYING');
        expect(matches.abandonGame(active!).events.map(({ type }) => type)).toEqual(['GameEnded']);
        if (expectedGame === 2) expect(() => matches.startNextGame(room.id, playerB)).toThrow(MatchServiceError);
        const started = matches.startNextGame(room.id, playerA);
        expect(started.game.number).toBe(expectedGame + 1);
      } else {
        expect(matches.abandonGame(active!).events.map(({ type }) => type)).toEqual(['GameEnded', 'MatchEnded']);
      }
    }
    expect(matches.get(matchId).match.status).toBe('ENDED');
    expect(() => rooms.get(room.id)).toThrow();
    expect(matches.processor.getState(gameOneId)).toBeUndefined();
  });

  it('rejects Game 1 without partially joining or creating a Match when a selected card is disabled', () => {
    let validationCount = 0;
    const definitions: CardDefinition[] = [card];
    const decks = new DeckService(() => ++validationCount >= 3 ? [{ ...card, status: 'DISABLED' }] : definitions);
    const userA = UserIdSchema.parse('user-a');
    const userB = UserIdSchema.parse('user-b');
    const playerA = PlayerIdSchema.parse('player-a');
    const playerB = PlayerIdSchema.parse('player-b');
    const deckA = decks.save(userA, { name: 'Deck A', mainboard, sideboard: [] });
    const deckB = decks.save(userB, { name: 'Deck B', mainboard, sideboard: [] });
    const rooms = new RoomService(decks);
    const matches = new MatchService(rooms, decks, () => definitions);
    const room = rooms.create(userA, playerA, deckA.id).room;
    expect(() => rooms.join(userB, playerB, room.id, deckB.id)).toThrow();
    expect(rooms.get(room.id).participants.map(({ playerId }) => playerId)).toEqual([playerA]);
    expect(rooms.get(room.id).status).toBe('WAITING');
    expect(() => matches.get(room.matchId ?? 'missing')).toThrow(MatchServiceError);
  });
});
