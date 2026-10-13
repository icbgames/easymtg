import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createInitialGameState } from '@easymtg/game';
import { PlayerIdSchema, UserIdSchema } from '@easymtg/shared';
import { eq } from 'drizzle-orm';
import { createDatabase } from './client.js';
import { PersistedRoomError, RoomRepository } from './room-repository.js';
import { GameInitializer } from './game-initializer.js';
import { MatchRepository } from './match-repository.js';
import { cardDefinitionVersions, cardDefinitions, deckSnapshots, decks, gameCardDefinitionRefs, gameStates, games, matchPlayers, matches, roomPlayers, rooms, users } from './schema.js';

const enabled = Boolean(process.env.DATABASE_URL);
const database = enabled ? createDatabase() : undefined;
const suite = describe.skipIf(!enabled);

suite('RoomRepository PostgreSQL integration', () => {
  afterAll(async () => { await database?.pool.end(); });

  it('creates a validated WAITING Room, resolves active state, and prevents two active Rooms per User', async () => {
    const db = database!.db;
    const repository = new RoomRepository(db);
    const userId = randomUUID();
    const joiningUserId = randomUUID();
    const playerId = `player-${randomUUID()}`;
    const joiningPlayerId = `player-${randomUUID()}`;
    const deckId = `deck-${randomUUID()}`;
    const joiningDeckId = `deck-${randomUUID()}`;
    const roomId = `room-${randomUUID()}`;
    const cardDefinitionId = newCardDefinitionId();
    const mainboard = Array.from({ length: 60 }, () => cardDefinitionId);
    await db.transaction(async (tx) => {
      await tx.insert(users).values({ id: userId, displayName: 'Room Repository Test' });
      await tx.insert(users).values({ id: joiningUserId, displayName: 'Room Join Test' });
      await tx.insert(decks).values({ id: deckId, ownerUserId: userId, name: 'Legal deck', mainboard, sideboard: [] });
      await tx.insert(decks).values({ id: joiningDeckId, ownerUserId: joiningUserId, name: 'Joining deck', mainboard, sideboard: [] });
      await tx.insert(cardDefinitions).values({ id: cardDefinitionId, currentVersion: 1, status: 'ENABLED' });
      await tx.insert(cardDefinitionVersions).values({
        cardDefinitionId, version: 1, englishName: 'Integration Card', hasBack: false,
        frontImageUrl: 'https://cards.example.test/room.jpg', rulesData: {},
      });
    });
    try {
      const created = await repository.createWaitingRoom({ roomId, ownerPlayerId: PlayerIdSchema.parse(playerId), userId: UserIdSchema.parse(userId), deckId });
      expect(created).toMatchObject({ id: roomId, status: 'WAITING', ownerPlayerId: playerId, participants: [{ playerId, deckId, connectionState: 'CONNECTED' }] });
      expect(await repository.getActiveRoom(UserIdSchema.parse(userId), () => 'CONNECTED')).toEqual(created);
      await expect(repository.createWaitingRoom({ roomId: `room-${randomUUID()}`, ownerPlayerId: PlayerIdSchema.parse(`player-${randomUUID()}`), userId: UserIdSchema.parse(userId), deckId }))
        .rejects.toMatchObject({ code: 'ACTIVE_ROOM_EXISTS' });
      await expect(repository.joinAndStartMatch({ roomId, playerId: PlayerIdSchema.parse(joiningPlayerId), userId: UserIdSchema.parse(joiningUserId), deckId: joiningDeckId }, async () => {
        throw new Error('Game initialization failed');
      })).rejects.toThrow('Game initialization failed');
      expect((await repository.getRoom(roomId)).participants).toHaveLength(1);
      expect(await repository.getActiveRoom(UserIdSchema.parse(joiningUserId))).toBeNull();
      const stale = await repository.getRoom(roomId);
      expect(stale.participants[0]?.connectionState).toBe('DISCONNECTED');

      await db.insert(roomPlayers).values({ roomId, playerId: joiningPlayerId, userId: joiningUserId, deckId: joiningDeckId, seatOrder: 1 });
      const transferred = await repository.leaveWaitingRoom({ roomId, playerId: PlayerIdSchema.parse(playerId), userId: UserIdSchema.parse(userId) });
      expect(transferred).toMatchObject({ deleted: false, ownerChanged: true, room: { ownerPlayerId: joiningPlayerId } });
      expect(await db.select().from(roomPlayers).where(eq(roomPlayers.roomId, roomId))).toMatchObject([{ playerId: joiningPlayerId, seatOrder: 0 }]);
      const removed = await repository.leaveWaitingRoom({ roomId, playerId: PlayerIdSchema.parse(joiningPlayerId), userId: UserIdSchema.parse(joiningUserId) });
      expect(removed).toMatchObject({ deleted: true, room: null });
      expect(await repository.getActiveRoom(UserIdSchema.parse(joiningUserId))).toBeNull();
    } finally {
      await db.transaction(async (tx) => {
        await tx.delete(rooms).where(eq(rooms.id, roomId));
        await tx.delete(decks).where(eq(decks.id, deckId));
        await tx.delete(decks).where(eq(decks.id, joiningDeckId));
        await tx.delete(users).where(eq(users.id, userId));
        await tx.delete(users).where(eq(users.id, joiningUserId));
        await tx.delete(cardDefinitionVersions).where(eq(cardDefinitionVersions.cardDefinitionId, cardDefinitionId));
        await tx.delete(cardDefinitions).where(eq(cardDefinitions.id, cardDefinitionId));
      });
    }
  });

  it('rejects a Deck when a referenced Card Definition is disabled', async () => {
    const db = database!.db;
    const repository = new RoomRepository(db);
    const userId = randomUUID();
    const deckId = `deck-${randomUUID()}`;
    const roomId = `room-${randomUUID()}`;
    const cardDefinitionId = newCardDefinitionId();
    await db.transaction(async (tx) => {
      await tx.insert(users).values({ id: userId, displayName: 'Unavailable Card Test' });
      await tx.insert(decks).values({ id: deckId, ownerUserId: userId, name: 'Disabled card', mainboard: Array.from({ length: 60 }, () => cardDefinitionId), sideboard: [] });
      await tx.insert(cardDefinitions).values({ id: cardDefinitionId, currentVersion: 1, status: 'DISABLED' });
      await tx.insert(cardDefinitionVersions).values({
        cardDefinitionId, version: 1, englishName: 'Disabled Card', hasBack: false,
        frontImageUrl: 'https://cards.example.test/disabled.jpg', rulesData: {},
      });
    });
    try {
      await expect(repository.createWaitingRoom({ roomId, ownerPlayerId: PlayerIdSchema.parse(`player-${randomUUID()}`), userId: UserIdSchema.parse(userId), deckId }))
        .rejects.toBeInstanceOf(PersistedRoomError);
      expect(await db.select().from(rooms).where(eq(rooms.id, roomId))).toHaveLength(0);
    } finally {
      await db.transaction(async (tx) => {
        await tx.delete(decks).where(eq(decks.id, deckId));
        await tx.delete(users).where(eq(users.id, userId));
        await tx.delete(cardDefinitionVersions).where(eq(cardDefinitionVersions.cardDefinitionId, cardDefinitionId));
        await tx.delete(cardDefinitions).where(eq(cardDefinitions.id, cardDefinitionId));
      });
    }
  });

  it('confirms temporary sideboard compositions and starts the next Game from them', async () => {
    const db = database!.db;
    const roomRepository = new RoomRepository(db);
    const matchRepository = new MatchRepository(db);
    const initializer = new GameInitializer();
    const ownerUserId = randomUUID();
    const joiningUserId = randomUUID();
    const ownerPlayerId = PlayerIdSchema.parse(`player-${randomUUID()}`);
    const joiningPlayerId = PlayerIdSchema.parse(`player-${randomUUID()}`);
    const ownerDeckId = `deck-${randomUUID()}`;
    const joiningDeckId = `deck-${randomUUID()}`;
    const roomId = `room-${randomUUID()}`;
    const cardDefinitionId = newCardDefinitionId();
    const mainboard = Array.from({ length: 61 }, () => cardDefinitionId);
    await db.transaction(async (tx) => {
      await tx.insert(users).values([
        { id: ownerUserId, displayName: 'Initializer owner' },
        { id: joiningUserId, displayName: 'Initializer joiner' },
      ]);
      await tx.insert(decks).values([
        { id: ownerDeckId, ownerUserId, name: 'Owner deck', mainboard, sideboard: [] },
        { id: joiningDeckId, ownerUserId: joiningUserId, name: 'Joiner deck', mainboard, sideboard: [] },
      ]);
      await tx.insert(cardDefinitions).values({ id: cardDefinitionId, currentVersion: 1, status: 'ENABLED' });
      await tx.insert(cardDefinitionVersions).values({
        cardDefinitionId, version: 1, englishName: 'Initializer card', hasBack: false,
        frontImageUrl: 'https://cards.example.test/initializer.jpg', rulesData: {},
      });
    });
    try {
      await roomRepository.createWaitingRoom({ roomId, ownerPlayerId, userId: UserIdSchema.parse(ownerUserId), deckId: ownerDeckId });
      const joined = await roomRepository.joinAndStartMatch({ roomId, playerId: joiningPlayerId, userId: UserIdSchema.parse(joiningUserId), deckId: joiningDeckId },
        (tx, room) => initializer.startFirst(tx, room));
      expect(joined.status).toBe('IN_MATCH');
      const [firstMatch] = await db.select().from(matches).where(eq(matches.roomId, roomId));
      expect(firstMatch?.activeGameId).toBeTruthy();
      const [firstState] = await db.select().from(gameStates).where(eq(gameStates.gameId, firstMatch!.activeGameId!));
      expect(firstState?.state).toMatchObject({ status: 'PLAYING', sequence: 0 });
      expect(await db.select().from(deckSnapshots).where(eq(deckSnapshots.gameId, firstMatch!.activeGameId!))).toHaveLength(2);

      await db.transaction(async (tx) => {
        await tx.update(games).set({ status: 'FINISHED' }).where(eq(games.id, firstMatch!.activeGameId!));
        await tx.update(gameStates).set({ state: { ...(firstState!.state as Record<string, unknown>), status: 'FINISHED' } }).where(eq(gameStates.gameId, firstMatch!.activeGameId!));
        await tx.update(matches).set({ activeGameId: null }).where(eq(matches.id, firstMatch!.id));
      });
      const changedComposition = { mainboard: Array.from({ length: 60 }, () => cardDefinitionId), sideboard: [cardDefinitionId] };
      await roomRepository.confirmNextGameDeck({ userId: UserIdSchema.parse(joiningUserId), playerId: joiningPlayerId, composition: changedComposition });
      expect(await roomRepository.getNextGameDeck(UserIdSchema.parse(ownerUserId), ownerPlayerId)).toMatchObject({ confirmed: false, opponentConfirmed: true });
      await roomRepository.confirmNextGameDeck({ userId: UserIdSchema.parse(ownerUserId), playerId: ownerPlayerId, composition: changedComposition });
      const next = await matchRepository.startNextGame(roomId, ownerPlayerId, (tx, room, match, gameNumber, temporaryDecks) => initializer.startNext(tx, room, match, gameNumber, temporaryDecks));
      expect(next.match.currentGameNumber).toBe(2);
      expect(next.match.activeGameId).toBe(next.gameId);
      const snapshots = await db.select().from(deckSnapshots).where(eq(deckSnapshots.gameId, next.gameId));
      expect(snapshots).toHaveLength(2);
      expect(snapshots.map(({ snapshot }) => (snapshot as { deckId: string }).deckId).sort()).toEqual([ownerDeckId, joiningDeckId].sort());
      expect(snapshots.map(({ snapshot }) => (snapshot as { mainboard: string[]; sideboard: string[] })).every(({ mainboard: cards, sideboard }) => cards.length === 60 && sideboard.length === 1)).toBe(true);
      expect((await db.select().from(decks).where(eq(decks.id, ownerDeckId)))[0]).toMatchObject({ mainboard, sideboard: [] });
      expect(await roomRepository.getNextGameDeck(UserIdSchema.parse(ownerUserId), ownerPlayerId)).toBeNull();
    } finally {
      await db.transaction(async (tx) => {
        await tx.delete(matches).where(eq(matches.roomId, roomId));
        await tx.delete(rooms).where(eq(rooms.id, roomId));
        await tx.delete(decks).where(eq(decks.id, ownerDeckId));
        await tx.delete(decks).where(eq(decks.id, joiningDeckId));
        await tx.delete(users).where(eq(users.id, ownerUserId));
        await tx.delete(users).where(eq(users.id, joiningUserId));
        await tx.delete(cardDefinitionVersions).where(eq(cardDefinitionVersions.cardDefinitionId, cardDefinitionId));
        await tx.delete(cardDefinitions).where(eq(cardDefinitions.id, cardDefinitionId));
      });
    }
  });

  it('commits the second Room participant with Match, Game 1, snapshots and Version refs atomically', async () => {
    const db = database!.db;
    const repository = new RoomRepository(db);
    const ownerUserId = randomUUID();
    const joiningUserId = randomUUID();
    const ownerPlayerId = `player-${randomUUID()}`;
    const joiningPlayerId = `player-${randomUUID()}`;
    const ownerDeckId = `deck-${randomUUID()}`;
    const joiningDeckId = `deck-${randomUUID()}`;
    const roomId = `room-${randomUUID()}`;
    const matchId = `match-${randomUUID()}`;
    const gameId = `game-${randomUUID()}`;
    const cardDefinitionId = newCardDefinitionId();
    const cardIds = Array.from({ length: 60 }, () => cardDefinitionId);
    await db.transaction(async (tx) => {
      await tx.insert(users).values([ownerUserId, joiningUserId].map((id) => ({ id, displayName: 'Matchmaking Integration' })));
      await tx.insert(decks).values([
        { id: ownerDeckId, ownerUserId, name: 'Owner Deck', mainboard: cardIds, sideboard: [] },
        { id: joiningDeckId, ownerUserId: joiningUserId, name: 'Joiner Deck', mainboard: cardIds, sideboard: [] },
      ]);
      await tx.insert(cardDefinitions).values({ id: cardDefinitionId, currentVersion: 1, status: 'ENABLED' });
      await tx.insert(cardDefinitionVersions).values({
        cardDefinitionId, version: 1, englishName: 'Matchmaking Card', hasBack: false,
        frontImageUrl: 'https://cards.example.test/matchmaking.jpg', rulesData: {},
      });
    });

    try {
      await repository.createWaitingRoom({ roomId, ownerPlayerId: PlayerIdSchema.parse(ownerPlayerId), userId: UserIdSchema.parse(ownerUserId), deckId: ownerDeckId });
      const joined = await repository.joinAndStartMatch({
        roomId, playerId: PlayerIdSchema.parse(joiningPlayerId), userId: UserIdSchema.parse(joiningUserId), deckId: joiningDeckId,
      }, async (tx, room) => {
        const playerIds = [ownerPlayerId, joiningPlayerId] as [string, string];
        const state = createInitialGameState({
          gameId, matchId, playerIds, hostPlayerId: ownerPlayerId,
          decks: playerIds.map((playerId) => ({ playerId, mainboard: [{ cardDefinitionId, quantity: 60 }], sideboard: [] })) as [
            { playerId: string; mainboard: Array<{ cardDefinitionId: string; quantity: number }>; sideboard: Array<{ cardDefinitionId: string; quantity: number }> },
            { playerId: string; mainboard: Array<{ cardDefinitionId: string; quantity: number }>; sideboard: Array<{ cardDefinitionId: string; quantity: number }> },
          ],
          definitions: { [cardDefinitionId]: { version: 1, status: 'ENABLED' } }, createId: randomUUID, randomIndex: () => 0,
        });
        await tx.insert(matches).values({ id: matchId, roomId, status: 'ACTIVE', currentGameNumber: 1, activeGameId: gameId });
        await tx.insert(matchPlayers).values(playerIds.map((playerId, seatOrder) => ({ matchId, roomId, playerId, seatOrder })));
        await tx.insert(games).values({ id: gameId, matchId, gameNumber: 1, status: 'PLAYING', currentSequence: 0 });
        await tx.insert(gameStates).values({ gameId, state });
        await tx.insert(deckSnapshots).values(room.participants.map(({ playerId, deckId }) => ({
          gameId, playerId, snapshot: { deckId, deckName: playerId === ownerPlayerId ? 'Owner Deck' : 'Joiner Deck', mainboard: cardIds, sideboard: [] },
        })));
        await tx.insert(gameCardDefinitionRefs).values({ gameId, cardDefinitionId, version: 1 });
        return matchId;
      });

      expect(joined).toMatchObject({ id: roomId, status: 'IN_MATCH', matchId, participants: [{ playerId: ownerPlayerId }, { playerId: joiningPlayerId }] });
      expect(await db.select().from(matches).where(eq(matches.id, matchId))).toHaveLength(1);
      expect(await db.select().from(games).where(eq(games.id, gameId))).toHaveLength(1);
      expect(await db.select().from(deckSnapshots).where(eq(deckSnapshots.gameId, gameId))).toHaveLength(2);
      expect(await db.select().from(gameCardDefinitionRefs).where(eq(gameCardDefinitionRefs.gameId, gameId))).toHaveLength(1);
      await expect(repository.confirmNextGameDeck({ userId: UserIdSchema.parse(joiningUserId), playerId: PlayerIdSchema.parse(joiningPlayerId), composition: { mainboard: cardIds, sideboard: [] } }))
        .rejects.toMatchObject({ code: 'GAME_STILL_ACTIVE' });
      await db.transaction(async (tx) => {
        const [state] = await tx.select().from(gameStates).where(eq(gameStates.gameId, gameId));
        await tx.update(gameStates).set({ state: { ...state!.state, status: 'FINISHED' } }).where(eq(gameStates.gameId, gameId));
        await tx.update(games).set({ status: 'FINISHED' }).where(eq(games.id, gameId));
        await tx.update(matches).set({ activeGameId: null }).where(eq(matches.id, matchId));
      });
      await repository.confirmNextGameDeck({ userId: UserIdSchema.parse(joiningUserId), playerId: PlayerIdSchema.parse(joiningPlayerId), composition: { mainboard: cardIds, sideboard: [] } });
      expect(await repository.getNextGameDeck(UserIdSchema.parse(joiningUserId), PlayerIdSchema.parse(joiningPlayerId))).toMatchObject({ mainboard: cardIds, sideboard: [], confirmed: true, opponentConfirmed: false });
    } finally {
      await db.transaction(async (tx) => {
        await tx.delete(matches).where(eq(matches.id, matchId));
        await tx.delete(rooms).where(eq(rooms.id, roomId));
        await tx.delete(decks).where(eq(decks.id, ownerDeckId));
        await tx.delete(decks).where(eq(decks.id, joiningDeckId));
        await tx.delete(users).where(eq(users.id, ownerUserId));
        await tx.delete(users).where(eq(users.id, joiningUserId));
        await tx.delete(cardDefinitionVersions).where(eq(cardDefinitionVersions.cardDefinitionId, cardDefinitionId));
        await tx.delete(cardDefinitions).where(eq(cardDefinitions.id, cardDefinitionId));
      });
    }
  });
});

function newCardDefinitionId(): string {
  const letters = [...randomBytes(3)].map((value) => String.fromCharCode(65 + value % 26)).join('');
  const digits = String(randomBytes(2).readUInt16BE(0) % 1000).padStart(3, '0');
  return `${letters}${digits}`;
}
