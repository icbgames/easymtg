import { randomUUID } from 'node:crypto';
import {
  DeckEntrySchema, DeckSnapshotSchema, GameIdSchema, GameSchema, MatchIdSchema, MatchSchema,
  type CardDefinition, type DeckSnapshot, type Game, type GameId, type Match, type MatchId, type PlayerId, type Room,
} from '@easymtg/shared';
import { createGameCommandProcessor, createInitialGameState, type GameCommandProcessor, type InitialDeck } from '@easymtg/game';
import type { ViewNotification } from '@easymtg/game';
import type { GameState } from '@easymtg/game';
import { DeckService, DeckServiceError } from './deck-service.js';
import { RoomService, type LifecycleEvent } from './room-service.js';

type GameRecord = { game: Game; snapshots: [DeckSnapshot, DeckSnapshot] };
type MatchRecord = { match: Match; games: Map<number, GameRecord> };

export class MatchServiceError extends Error {
  constructor(readonly code: 'MATCH_NOT_FOUND' | 'ROOM_NOT_FOUND' | 'FORBIDDEN' | 'MATCH_NOT_ACTIVE' | 'GAME_STILL_ACTIVE' | 'GAME_NOT_ACTIVE' | 'ALL_GAMES_COMPLETE' | 'GAME_NOT_FOUND' | 'DECK_INVALID' | 'GAME_INITIALIZATION_FAILED') {
    super(code);
    this.name = 'MatchServiceError';
  }
}

/** In-memory Match/Game lifecycle. Persistence and delivery are Phase 7. */
export class MatchService {
  private readonly matches = new Map<MatchId, MatchRecord>();
  private readonly gameToMatch = new Map<GameId, MatchId>();
  readonly processor: GameCommandProcessor;

  constructor(
    private readonly rooms: RoomService,
    private readonly decks: DeckService,
    private readonly definitions: () => readonly CardDefinition[],
    processor: GameCommandProcessor = createGameCommandProcessor(),
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = randomUUID,
  ) {
    this.processor = processor;
    this.rooms.setAutoStartRoom((room) => this.startMatchAndGameOne(room));
  }

  /** Game 1 and the Match are created atomically as the second Player joins. */
  private startMatchAndGameOne(room: Room): { matchId: MatchId; events: LifecycleEvent[] } {
    const matchId = MatchIdSchema.parse(this.createId());
    const match = MatchSchema.parse({
      id: matchId, roomId: room.id, playerIds: room.participants.map(({ playerId }) => playerId),
      status: 'ACTIVE', currentGameNumber: 1, createdAt: this.now(),
    });
    const firstGame = this.buildGame(room, match, 1);
    this.processor.registerGame(firstGame.gameState);
    const activeMatch = MatchSchema.parse({ ...match, activeGameId: firstGame.record.game.id });
    this.matches.set(matchId, { match: activeMatch, games: new Map([[1, firstGame.record]]) });
    this.gameToMatch.set(firstGame.record.game.id, matchId);
    return {
      matchId,
      events: [this.gameStartedEvent(room.id, matchId, firstGame.record.game)],
    };
  }

  startNextGame(roomId: string, actorPlayerId: PlayerId): { match: Match; game: Game; snapshots: [DeckSnapshot, DeckSnapshot]; events: LifecycleEvent[] } {
    const room = this.rooms.get(roomId);
    const matchId = room.matchId;
    if (!matchId) throw new MatchServiceError('MATCH_NOT_FOUND');
    const record = this.getMatchRecord(matchId);
    if (room.ownerPlayerId !== actorPlayerId) throw new MatchServiceError('FORBIDDEN');
    if (record.match.status !== 'ACTIVE') throw new MatchServiceError('MATCH_NOT_ACTIVE');
    if (record.match.activeGameId) throw new MatchServiceError('GAME_STILL_ACTIVE');
    if (record.match.currentGameNumber >= 5) throw new MatchServiceError('ALL_GAMES_COMPLETE');

    const number = record.match.currentGameNumber + 1;
    const created = this.buildGame(room, record.match, number);
    this.processor.registerGame(created.gameState);
    const match = MatchSchema.parse({ ...record.match, currentGameNumber: number, activeGameId: created.record.game.id });
    record.games.set(number, created.record);
    record.match = match;
    this.gameToMatch.set(created.record.game.id, match.id);
    return {
      match: structuredClone(match), game: structuredClone(created.record.game), snapshots: structuredClone(created.record.snapshots),
      events: [this.gameStartedEvent(roomId, match.id, created.record.game)],
    };
  }

  /** Deck selection is allowed between ended Games for sideboard changes. */
  selectDeck(roomId: string, userId: Parameters<RoomService['updateSelectedDeck']>[1], playerId: PlayerId, deckId: Parameters<RoomService['updateSelectedDeck']>[3]): Room {
    const room = this.rooms.get(roomId);
    if (!room.matchId) throw new MatchServiceError('MATCH_NOT_FOUND');
    const match = this.getMatchRecord(room.matchId).match;
    if (match.status !== 'ACTIVE') throw new MatchServiceError('MATCH_NOT_ACTIVE');
    if (match.activeGameId) throw new MatchServiceError('GAME_STILL_ACTIVE');
    return this.rooms.updateSelectedDeck(roomId, userId, playerId, deckId);
  }

  /** Observe processor output after a Concede command and emit lifecycle completion. */
  syncGameEnd(gameId: string): LifecycleEvent[] {
    const gameIdParsed = GameIdSchema.parse(gameId);
    const matchId = this.gameToMatch.get(gameIdParsed);
    if (!matchId) throw new MatchServiceError('GAME_NOT_FOUND');
    const state = this.processor.getState(gameIdParsed);
    if (!state || (state.status !== 'FINISHED' && state.status !== 'ABANDONED')) throw new MatchServiceError('GAME_NOT_ACTIVE');
    return this.finishGame(matchId, gameIdParsed, state);
  }

  /** Called by the Phase 7 reconnect timer after the 30 minute grace period. */
  abandonGame(gameId: string): { events: LifecycleEvent[]; notifications: ViewNotification[] } {
    const gameIdParsed = GameIdSchema.parse(gameId);
    const matchId = this.gameToMatch.get(gameIdParsed);
    if (!matchId) throw new MatchServiceError('GAME_NOT_FOUND');
    const notifications = this.processor.getGameEndNotifications(gameIdParsed);
    const state = this.processor.markAbandoned(gameIdParsed);
    if (!state) throw new MatchServiceError('GAME_NOT_ACTIVE');
    return { events: this.finishGame(matchId, gameIdParsed, state), notifications };
  }

  get(matchId: string): { match: Match; games: Game[]; snapshots: Array<{ gameNumber: number; decks: [DeckSnapshot, DeckSnapshot] }> } {
    const record = this.getMatchRecord(matchId);
    return {
      match: structuredClone(record.match),
      games: [...record.games.values()].map(({ game }) => structuredClone(game)),
      snapshots: [...record.games.entries()].map(([gameNumber, value]) => ({ gameNumber, decks: structuredClone(value.snapshots) })),
    };
  }

  private buildGame(room: Room, match: Match, number: number): { record: GameRecord; gameState: GameState } {
    try {
      const playerIds = match.playerIds as [PlayerId, PlayerId];
      const snapshots = playerIds.map((playerId) => {
        const selected = this.rooms.getSelectedDeck(room.id, playerId, room);
        const deck = this.decks.validateForUse(selected.userId, selected.deckId);
        return DeckSnapshotSchema.parse({ deckId: deck.id, deckName: deck.name, mainboard: deck.mainboard, sideboard: deck.sideboard });
      }) as [DeckSnapshot, DeckSnapshot];
      const resolved: Record<string, { version: number; status: 'ENABLED' | 'DISABLED' }> = {};
      for (const cardId of snapshots.flatMap(({ mainboard, sideboard }) => [...mainboard, ...sideboard])) {
        const definition = this.definitions().find(({ id }) => id === cardId);
        const latest = definition?.versions.find(({ version }) => version === definition.currentVersion);
        if (!definition || definition.status !== 'ENABLED' || !latest) throw new MatchServiceError('DECK_INVALID');
        resolved[cardId] = { version: latest.version, status: definition.status };
      }
      const gameId = GameIdSchema.parse(this.createId());
      const gameDecks: [InitialDeck, InitialDeck] = [
        { playerId: playerIds[0], mainboard: toEntries(snapshots[0].mainboard), sideboard: toEntries(snapshots[0].sideboard) },
        { playerId: playerIds[1], mainboard: toEntries(snapshots[1].mainboard), sideboard: toEntries(snapshots[1].sideboard) },
      ];
      const gameState = createInitialGameState({
        gameId, matchId: match.id, playerIds, hostPlayerId: room.ownerPlayerId,
        decks: gameDecks,
        definitions: resolved, createId: this.createId,
      });
      const game = GameSchema.parse({ id: gameId, matchId: match.id, number, status: 'PLAYING', createdAt: this.now() });
      return { record: { game, snapshots }, gameState };
    } catch (error) {
      if (error instanceof MatchServiceError) throw error;
      if (error instanceof DeckServiceError) throw new MatchServiceError('DECK_INVALID');
      throw new MatchServiceError('GAME_INITIALIZATION_FAILED');
    }
  }

  private finishGame(matchId: MatchId, gameId: GameId, state: GameState): LifecycleEvent[] {
    const record = this.getMatchRecord(matchId);
    const gameNumber = record.match.currentGameNumber;
    const prior = record.games.get(gameNumber);
    if (!prior || prior.game.id !== gameId) throw new MatchServiceError('GAME_NOT_ACTIVE');
    if (prior.game.status !== 'PLAYING') return [];
    prior.game = GameSchema.parse({ ...prior.game, status: state.status });
    const events: LifecycleEvent[] = [{
      eventId: this.createId(), type: 'GameEnded', roomId: record.match.roomId,
      matchId, gameId, gameNumber, gameStatus: state.status,
    }];
    const isFinalGame = gameNumber === 5;
    if (isFinalGame) {
      record.match = MatchSchema.parse({ ...record.match, status: 'ENDED', activeGameId: undefined });
      events.push({ eventId: this.createId(), type: 'MatchEnded', roomId: record.match.roomId, matchId, gameNumber });
      this.rooms.deleteForMatchEnd(record.match.roomId);
      for (const game of record.games.values()) this.processor.releaseGame(game.game.id);
    } else {
      record.match = MatchSchema.parse({ ...record.match, activeGameId: undefined });
    }
    return events;
  }

  private getMatchRecord(matchId: string): MatchRecord {
    const parsed = MatchIdSchema.safeParse(matchId);
    const record = parsed.success ? this.matches.get(parsed.data) : undefined;
    if (!record) throw new MatchServiceError('MATCH_NOT_FOUND');
    return record;
  }

  private gameStartedEvent(roomId: string, matchId: MatchId, game: Game): LifecycleEvent {
    return { eventId: this.createId(), type: 'GameStarted', roomId, matchId, gameId: game.id, gameNumber: game.number };
  }
}

function toEntries(cardIds: string[]) {
  const quantities = new Map<string, number>();
  for (const cardId of cardIds) quantities.set(cardId, (quantities.get(cardId) ?? 0) + 1);
  return [...quantities].map(([cardDefinitionId, quantity]) => DeckEntrySchema.parse({ cardDefinitionId, quantity }));
}
