import { and, eq, inArray } from 'drizzle-orm';
import { GameStateSchema } from '@easymtg/game';
import { DeckSchema, DeckSnapshotSchema, GameIdSchema, MatchSchema, NextGameDeckSchema, PlayerIdSchema, RoomSchema, type Match, type PlayerId, type Room } from '@easymtg/shared';
import type { Database } from './client.js';
import { cardDefinitionVersions, cardDefinitions, decks, deckSnapshots, gameCardDefinitionRefs, gameStates, games, matchPlayers, matches, roomPlayers, rooms } from './schema.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class PersistedMatchError extends Error {
  constructor(readonly code: 'MATCH_NOT_FOUND' | 'ROOM_NOT_FOUND' | 'FORBIDDEN' | 'MATCH_NOT_ACTIVE' | 'GAME_STILL_ACTIVE' | 'GAME_NOT_ACTIVE' | 'ALL_GAMES_COMPLETE' | 'INVALID_INITIAL_GAME' | 'PLAYERS_NOT_READY', message: string = code) {
    super(message);
    this.name = 'PersistedMatchError';
  }
}

/** Transactional Game 2–5 creation for an already persisted Match. */
export class MatchRepository {
  constructor(private readonly db: Database) {}

  async startNextGame(roomId: string, actorPlayerId: PlayerId, initialize: (tx: Transaction, room: Room, match: Match, gameNumber: number, decks: Map<PlayerId, { mainboard: string[]; sideboard: string[] }>) => Promise<string>): Promise<{ match: Match; gameId: string }> {
    return this.db.transaction(async (tx) => {
      const [matchRow] = await tx.select().from(matches).where(eq(matches.roomId, roomId)).for('update');
      if (!matchRow) throw new PersistedMatchError('MATCH_NOT_FOUND');
      const [roomRow] = await tx.select().from(rooms).where(eq(rooms.id, matchRow.roomId)).for('update');
      if (!roomRow || roomRow.matchId !== matchRow.id || roomRow.status !== 'IN_MATCH') throw new PersistedMatchError('ROOM_NOT_FOUND');
      if (roomRow.ownerPlayerId !== actorPlayerId) throw new PersistedMatchError('FORBIDDEN');
      if (matchRow.status !== 'ACTIVE') throw new PersistedMatchError('MATCH_NOT_ACTIVE');
      if (matchRow.activeGameId !== null) throw new PersistedMatchError('GAME_STILL_ACTIVE');
      if (matchRow.currentGameNumber >= 5) throw new PersistedMatchError('ALL_GAMES_COMPLETE');
      const [previousGame] = await tx.select().from(games).where(and(eq(games.matchId, matchRow.id), eq(games.gameNumber, matchRow.currentGameNumber))).for('update');
      if (!previousGame || (previousGame.status !== 'FINISHED' && previousGame.status !== 'ABANDONED')) throw new PersistedMatchError('GAME_NOT_ACTIVE');

      const members = await tx.select().from(matchPlayers).where(eq(matchPlayers.matchId, matchRow.id)).orderBy(matchPlayers.seatOrder);
      if (members.length !== 2) throw new PersistedMatchError('INVALID_INITIAL_GAME', 'Match must have exactly two Player seats.');
      const roomMembers = await tx.select().from(roomPlayers).where(eq(roomPlayers.roomId, roomRow.id)).orderBy(roomPlayers.seatOrder);
      if (roomMembers.length !== 2 || members.some((member, index) => member.playerId !== roomMembers[index]?.playerId)) {
        throw new PersistedMatchError('INVALID_INITIAL_GAME', 'Match seats disagree with Room participants.');
      }
      if (roomMembers.some((member) => !member.nextGameConfirmed || !member.nextGameDeck)) throw new PersistedMatchError('PLAYERS_NOT_READY');
      const temporaryDecks = new Map<PlayerId, { mainboard: string[]; sideboard: string[] }>();
      for (const member of roomMembers) temporaryDecks.set(PlayerIdSchema.parse(member.playerId), NextGameDeckSchema.parse(member.nextGameDeck));
      const deckIds = [...new Set(roomMembers.map(({ deckId }) => deckId))].sort();
      const lockedDecks = await tx.select().from(decks).where(inArray(decks.id, deckIds)).orderBy(decks.id).for('share');
      if (lockedDecks.length !== deckIds.length) throw new PersistedMatchError('INVALID_INITIAL_GAME', 'A selected Deck no longer exists.');
      const parsedDecks = new Map(lockedDecks.map((deck) => [deck.id, DeckSchema.parse({ ...deck, updatedAt: deck.updatedAt.toISOString() })]));
      const playerIds = members.map(({ playerId }) => PlayerIdSchema.parse(playerId));
      const room = RoomSchema.parse({
        id: roomRow.id, ownerPlayerId: roomRow.ownerPlayerId, status: 'IN_MATCH', matchId: matchRow.id,
        participants: roomMembers.map((member) => ({ playerId: PlayerIdSchema.parse(member.playerId), deckId: member.deckId, connectionState: 'DISCONNECTED' as const })),
        createdAt: roomRow.createdAt.toISOString(),
      });
      const match = MatchSchema.parse({
        id: matchRow.id, roomId: matchRow.roomId, playerIds, status: matchRow.status,
        currentGameNumber: matchRow.currentGameNumber, createdAt: matchRow.createdAt.toISOString(),
      });
      for (const participant of room.participants) {
        const deck = parsedDecks.get(participant.deckId);
        if (!deck || deck.ownerUserId !== roomMembers.find((member) => member.playerId === participant.playerId)?.userId) {
          throw new PersistedMatchError('INVALID_INITIAL_GAME', 'Participant Deck ownership is invalid.');
        }
      }
      const cardIds = [...new Set([...temporaryDecks.values()].flatMap((deck) => [...deck.mainboard, ...deck.sideboard]))].sort();
      const definitions = await tx.select({ id: cardDefinitions.id, currentVersion: cardDefinitions.currentVersion, status: cardDefinitions.status })
        .from(cardDefinitions).where(inArray(cardDefinitions.id, cardIds)).orderBy(cardDefinitions.id).for('share', { of: cardDefinitions });
      if (definitions.length !== cardIds.length || definitions.some(({ status }) => status !== 'ENABLED')) {
        throw new PersistedMatchError('INVALID_INITIAL_GAME', 'A selected Deck references a missing or disabled Card Definition.');
      }
      const currentVersions = await tx.select({ id: cardDefinitionVersions.cardDefinitionId, version: cardDefinitionVersions.version })
        .from(cardDefinitionVersions).innerJoin(cardDefinitions, and(
          eq(cardDefinitions.id, cardDefinitionVersions.cardDefinitionId), eq(cardDefinitions.currentVersion, cardDefinitionVersions.version),
        )).where(inArray(cardDefinitionVersions.cardDefinitionId, cardIds)).orderBy(cardDefinitionVersions.cardDefinitionId).for('share', { of: cardDefinitionVersions });
      if (currentVersions.length !== cardIds.length) throw new PersistedMatchError('INVALID_INITIAL_GAME', 'A current Card Definition Version is missing.');

      const nextNumber = matchRow.currentGameNumber + 1;
      const gameId = GameIdSchema.parse(await initialize(tx, room, match, nextNumber, temporaryDecks));
      const [game] = await tx.select().from(games).where(and(eq(games.id, gameId), eq(games.matchId, matchRow.id), eq(games.gameNumber, nextNumber))).for('update');
      if (!game || game.status !== 'PLAYING') throw new PersistedMatchError('INVALID_INITIAL_GAME', 'Initializer did not persist the next playing Game.');
      const [persistedState] = await tx.select().from(gameStates).where(eq(gameStates.gameId, gameId));
      if (!persistedState) throw new PersistedMatchError('INVALID_INITIAL_GAME', 'Initializer did not persist GameState.');
      const state = GameStateSchema.parse(persistedState.state);
      if (state.gameId !== gameId || state.matchId !== matchRow.id || state.status !== 'PLAYING' || state.sequence !== 0 || playerIds.some((id) => !state.players.some((player) => player.playerId === id))) {
        throw new PersistedMatchError('INVALID_INITIAL_GAME', 'Persisted GameState does not match the new Game.');
      }
      const snapshots = await tx.select().from(deckSnapshots).where(eq(deckSnapshots.gameId, gameId));
      if (snapshots.length !== 2) throw new PersistedMatchError('INVALID_INITIAL_GAME', 'Initializer must persist both DeckSnapshots.');
      for (const snapshot of snapshots) {
        const parsed = DeckSnapshotSchema.parse(snapshot.snapshot);
        const participant = room.participants.find((item) => item.playerId === snapshot.playerId);
        if (!participant || parsed.deckId !== participant.deckId) throw new PersistedMatchError('INVALID_INITIAL_GAME', 'DeckSnapshot does not match the selected Deck.');
      }
      const refs = await tx.select().from(gameCardDefinitionRefs).where(eq(gameCardDefinitionRefs.gameId, gameId));
      if (refs.length !== currentVersions.length || currentVersions.some(({ id, version }) =>
        !refs.some((ref) => ref.cardDefinitionId === id && ref.version === version),
      )) throw new PersistedMatchError('INVALID_INITIAL_GAME', 'Active Game Card Definition Version refs are incomplete.');
      const [updated] = await tx.update(matches).set({ currentGameNumber: nextNumber, activeGameId: gameId }).where(eq(matches.id, matchRow.id)).returning();
      if (!updated) throw new PersistedMatchError('MATCH_NOT_FOUND');
      await tx.update(roomPlayers).set({ nextGameDeck: null, nextGameConfirmed: false }).where(eq(roomPlayers.roomId, roomRow.id));
      return { match: MatchSchema.parse({
        id: updated.id, roomId: updated.roomId, playerIds, status: updated.status,
        currentGameNumber: updated.currentGameNumber, activeGameId: updated.activeGameId!, createdAt: updated.createdAt.toISOString(),
      }), gameId };
    });
  }
}
