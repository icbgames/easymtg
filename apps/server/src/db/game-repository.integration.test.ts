import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterAll, describe, expect, it } from 'vitest';
import { createGameCommandProcessor, createInitialGameState } from '@easymtg/game';
import { CommandResultSchema, GameEventSchema, HelloSchema, PlayerIdSchema, UserIdSchema } from '@easymtg/shared';
import { eq, inArray } from 'drizzle-orm';
import { createDatabase } from './client.js';
import type { Database } from './client.js';
import { GameRepository } from './game-repository.js';
import { PostgresGameCommandPersistence } from './game-command-persistence.js';
import { MatchRepository } from './match-repository.js';
import { RoomRepository } from './room-repository.js';
import { GameSyncRepository } from './game-sync-repository.js';
import { CleanupRepository } from './cleanup-repository.js';
import { WebSocketSessionManager, type WebSocketLike } from '../websocket-session-manager.js';
import type { Match, Room } from '@easymtg/shared';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
import {
  cardDefinitionVersions, cardDefinitions, commandResults, deckSnapshots, decks, gameCardDefinitionRefs, gameEventViews,
  gameEvents, gameStates, games, matchPlayers, matches, rooms, roomPlayers, users,
} from './schema.js';

const enabled = Boolean(process.env.DATABASE_URL);
const database = enabled ? createDatabase() : undefined;
const suite = describe.skipIf(!enabled);

suite('GameRepository PostgreSQL integration', () => {
  afterAll(async () => { await database?.pool.end(); });

  it('locks commands, commits state/events/views/receipts atomically, and deduplicates globally', async () => {
    const db = database!.db;
    const repository = new GameRepository(db);
    const fixture = await createFixture(db);
    try {
      const previous = fixture.state;
      const next = { ...previous, sequence: 1, players: previous.players.map((player, index) => index === 0 ? { ...player, life: player.life + 1 } : player) };
      const event = GameEventSchema.parse({
        type: 'GameEvent', eventId: randomUUID(), gameId: fixture.gameId, sequence: 1,
        eventType: 'LifeChanged', payload: { playerId: fixture.playerIds[0], amount: 1 },
      });
      const commandId = `integration-${randomUUID()}`;
      const input = {
        gameId: fixture.gameId,
        actorPlayerId: PlayerIdSchema.parse(fixture.playerIds[0]),
        commandId,
        fingerprint: 'stable-canonical-fingerprint',
        expectedSequence: 0,
        result: CommandResultSchema.parse({ type: 'CommandResult', commandId, success: true }),
        state: next,
        event,
        eventViews: fixture.playerIds.map((recipientPlayerId) => ({ recipientPlayerId: PlayerIdSchema.parse(recipientPlayerId), payload: event })),
      };
      const outcomes = await Promise.all([repository.persistCommand(input), repository.persistCommand(input)]);
      expect(outcomes.map(({ kind }) => kind).sort()).toEqual(['committed', 'duplicate']);
      expect(await repository.loadGameState(fixture.gameId)).toEqual(next);

      const conflict = await repository.persistCommand({ ...input, fingerprint: 'different-content', expectedSequence: 1 });
      expect(conflict.kind).toBe('conflict');
      expect((await db.select().from(gameEvents).where(eq(gameEvents.gameId, fixture.gameId)))).toHaveLength(1);
      expect((await db.select().from(gameEventViews).where(eq(gameEventViews.eventId, event.eventId)))).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('connects the command processor to PostgreSQL and deduplicates after processor restart', async () => {
    const repository = new GameRepository(database!.db);
    const fixture = await createFixture(database!.db);
    try {
      const commandId = `restart-${randomUUID()}`;
      const actor = PlayerIdSchema.parse(fixture.playerIds[0]);
      const command = { type: 'ChangeLife', commandId, payload: { amount: 2 } };
      const first = createGameCommandProcessor();
      first.registerGame(fixture.state);
      first.setPlayerConnected(fixture.gameId, actor, true);
      first.setPlayerConnected(fixture.gameId, PlayerIdSchema.parse(fixture.playerIds[1]), true);
      first.setPersistenceAdapter(new PostgresGameCommandPersistence(repository));
      const committed = await first.process(fixture.gameId, actor, command);
      expect(committed.result.success).toBe(true);
      expect(committed.event?.sequence).toBe(1);

      const restarted = createGameCommandProcessor();
      restarted.registerGame(await repository.loadGameState(fixture.gameId));
      restarted.setPlayerConnected(fixture.gameId, actor, true);
      restarted.setPlayerConnected(fixture.gameId, PlayerIdSchema.parse(fixture.playerIds[1]), true);
      restarted.setPersistenceAdapter(new PostgresGameCommandPersistence(repository));
      const duplicate = await restarted.process(fixture.gameId, actor, command);
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.result).toEqual(committed.result);
      expect(duplicate.event).toBeNull();
      expect(restarted.getState(fixture.gameId)?.players[0]?.life).toBe(22);
    } finally {
      await fixture.cleanup();
    }
  });

  it('persists and fans out a Game Command over two Sessions, then replays it after a send failure', async () => {
    const fixture = await createFixture(database!.db);
    const gameRepository = new GameRepository(database!.db);
    const logger = { error: () => undefined };
    try {
      const manager = new WebSocketSessionManager(new GameSyncRepository(database!.db), gameRepository);
      const first = new TestSocket();
      const second = new TestSocket();
      manager.accept(fixture.userIds[0]!, first, logger);
      manager.accept(fixture.userIds[1]!, second, logger);
      first.message({ type: 'Hello', protocolVersion: 1, lastGameId: null, lastSequence: null });
      second.message({ type: 'Hello', protocolVersion: 1, lastGameId: null, lastSequence: null });
      await waitFor(() => first.sent.some((message) => message.type === 'InitialState') && second.sent.some((message) => message.type === 'InitialState'));
      first.sent.length = 0;
      second.sent.length = 0;
      first.failNextEvent = true;
      const commandId = `websocket-db-${randomUUID()}`;
      first.message({ type: 'ChangeLife', commandId, payload: { amount: 1 } });
      await waitFor(() => first.sent.some((message) => message.type === 'CommandResult') && second.sent.some((message) => message.type === 'GameEvent'));

      expect(first.sent.map((message) => message.type)).toEqual(['CommandResult']);
      expect(first.sent[0]).toMatchObject({ success: true, commandId });
      expect(second.sent.map((message) => message.type)).toEqual(['GameEvent']);
      const savedState = await gameRepository.loadGameState(fixture.gameId);
      expect(savedState.sequence).toBe(1);
      expect(savedState.players.some(({ life }) => life === 21)).toBe(true);

      const restartedManager = new WebSocketSessionManager(new GameSyncRepository(database!.db), gameRepository);
      const resumed = new TestSocket();
      restartedManager.accept(fixture.userIds[0]!, resumed, logger);
      resumed.message({ type: 'Hello', protocolVersion: 1, lastGameId: fixture.gameId, lastSequence: 0 });
      await waitFor(() => resumed.sent.some((message) => message.type === 'GameEvent'));
      expect(resumed.sent.map((message) => message.type)).toEqual(['Welcome', 'RoomStateSync', 'MatchStateSync', 'GameEvent', 'PlayerConnected']);
      expect(resumed.sent[3]).toMatchObject({ sequence: 1, eventType: 'ChangeLifeApplied' });
      first.end(); second.end(); resumed.end();
      await flushSockets();
    } finally {
      await fixture.cleanup();
    }
  });

  it('replays contiguous recipient Event views and falls back to a privacy-safe InitialState', async () => {
    const db = database!.db;
    const repository = new GameRepository(db);
    const fixture = await createFixture(db);
    try {
      const event = GameEventSchema.parse({ type: 'GameEvent', eventId: randomUUID(), gameId: fixture.gameId, sequence: 1, eventType: 'LifeChanged', payload: { amount: 1 } });
      const nextState = { ...fixture.state, sequence: 1, players: fixture.state.players.map((player, index) => index === 0 ? { ...player, life: player.life + 1 } : player) };
      const commandId = `sync-${randomUUID()}`;
      await repository.persistCommand({
        gameId: fixture.gameId, actorPlayerId: PlayerIdSchema.parse(fixture.playerIds[0]), commandId,
        fingerprint: 'sync-test', expectedSequence: 0,
        result: CommandResultSchema.parse({ type: 'CommandResult', commandId, success: true }),
        state: nextState, event,
        eventViews: fixture.playerIds.map((recipientPlayerId) => ({ recipientPlayerId: PlayerIdSchema.parse(recipientPlayerId), payload: event })),
      });

      const sync = new GameSyncRepository(db);
      const resumed = await sync.buildMessages(fixture.userIds[0]!, HelloSchema.parse({ type: 'Hello', protocolVersion: 1, lastGameId: fixture.gameId, lastSequence: 0 }));
      expect(resumed.map(({ type }) => type)).toEqual(['Welcome', 'RoomStateSync', 'MatchStateSync', 'GameEvent']);
      expect(resumed.at(-1)).toMatchObject({ type: 'GameEvent', eventId: event.eventId, sequence: 1 });

      const snapshot = await sync.buildMessages(fixture.userIds[0]!, HelloSchema.parse({ type: 'Hello', protocolVersion: 1, lastGameId: 'old-game', lastSequence: 8 }));
      expect(snapshot.map(({ type }) => type)).toEqual(['Welcome', 'RoomStateSync', 'MatchStateSync', 'InitialState']);
      expect(snapshot.at(-1)).toMatchObject({ type: 'InitialState', gameId: fixture.gameId, sequence: 1 });
    } finally {
      await fixture.cleanup();
    }
  });

  it('cleans per-Game Event, receipt, ViewState, and version references when a Game ends', async () => {
    const db = database!.db;
    const repository = new GameRepository(db);
    const fixture = await createFixture(db);
    try {
      const commandId = `finish-${randomUUID()}`;
      const event = GameEventSchema.parse({
        type: 'GameEvent', eventId: randomUUID(), gameId: fixture.gameId, sequence: 1,
        eventType: 'GameEnded', payload: {},
      });
      const ended = { ...fixture.state, status: 'FINISHED' as const, sequence: 1 };
      await repository.persistCommand({
        gameId: fixture.gameId,
        actorPlayerId: PlayerIdSchema.parse(fixture.playerIds[0]),
        commandId,
        fingerprint: 'terminal-command',
        expectedSequence: 0,
        result: CommandResultSchema.parse({ type: 'CommandResult', commandId, success: true }),
        state: ended,
        event,
        eventViews: fixture.playerIds.map((recipientPlayerId) => ({ recipientPlayerId: PlayerIdSchema.parse(recipientPlayerId), payload: event })),
      });
      expect((await repository.loadGameState(fixture.gameId)).status).toBe('FINISHED');
      expect(await db.select().from(gameEvents).where(eq(gameEvents.gameId, fixture.gameId))).toHaveLength(0);
      expect(await db.select().from(gameEventViews).where(eq(gameEventViews.eventId, event.eventId))).toHaveLength(0);
      expect(await db.select().from(commandResults).where(eq(commandResults.gameId, fixture.gameId))).toHaveLength(0);
      expect(await db.select().from(gameCardDefinitionRefs).where(eq(gameCardDefinitionRefs.gameId, fixture.gameId))).toHaveLength(0);
      expect(await db.select().from(matches).where(eq(matches.id, fixture.matchId))).toMatchObject([{ status: 'ACTIVE', activeGameId: null }]);
      expect(await db.select().from(rooms).where(eq(rooms.id, fixture.roomId))).toMatchObject([{ status: 'IN_MATCH', matchId: fixture.matchId }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('deletes the Room and Match in the Game 5 end transaction', async () => {
    const db = database!.db;
    const repository = new GameRepository(db);
    const fixture = await createFixture(db, 5);
    try {
      const commandId = `finish-game-five-${randomUUID()}`;
      const event = GameEventSchema.parse({
        type: 'GameEvent', eventId: randomUUID(), gameId: fixture.gameId, sequence: 1,
        eventType: 'GameEnded', payload: {},
      });
      await repository.persistCommand({
        gameId: fixture.gameId,
        actorPlayerId: PlayerIdSchema.parse(fixture.playerIds[0]),
        commandId,
        fingerprint: 'game-five-terminal-command',
        expectedSequence: 0,
        result: CommandResultSchema.parse({ type: 'CommandResult', commandId, success: true }),
        state: { ...fixture.state, status: 'FINISHED', sequence: 1 },
        event,
        eventViews: fixture.playerIds.map((recipientPlayerId) => ({ recipientPlayerId: PlayerIdSchema.parse(recipientPlayerId), payload: event })),
      });
      expect(await db.select().from(rooms).where(eq(rooms.id, fixture.roomId))).toHaveLength(0);
      expect(await db.select().from(matches).where(eq(matches.id, fixture.matchId))).toHaveLength(0);
      expect(await db.select().from(games).where(eq(games.id, fixture.gameId))).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('abandons an expired disconnected Game under lock and preserves the Match between Games', async () => {
    const db = database!.db;
    const repository = new GameRepository(db);
    const fixture = await createFixture(db);
    try {
      const now = new Date();
      await repository.setAllPlayersDisconnectedAt(fixture.gameId, new Date(now.getTime() - 31 * 60 * 1000));
      expect(await repository.abandonExpiredBatch(now)).toEqual([{
        roomId: fixture.roomId, matchId: fixture.matchId, gameId: fixture.gameId, gameNumber: 1,
      }]);
      expect((await repository.loadGameState(fixture.gameId)).status).toBe('ABANDONED');
      expect(await db.select().from(gameEvents).where(eq(gameEvents.gameId, fixture.gameId))).toHaveLength(0);
      expect(await db.select().from(gameCardDefinitionRefs).where(eq(gameCardDefinitionRefs.gameId, fixture.gameId))).toHaveLength(0);
      expect(await db.select().from(matches).where(eq(matches.id, fixture.matchId))).toMatchObject([{ status: 'ACTIVE', activeGameId: null }]);

      await repository.setAllPlayersDisconnectedAt(fixture.gameId, new Date(now.getTime() - 31 * 60 * 1000));
      expect(await repository.abandonExpiredBatch(now)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('marks active Games disconnected at startup without resetting an existing grace period', async () => {
    const db = database!.db;
    const repository = new GameRepository(db);
    const fixture = await createFixture(db);
    try {
      const firstBoot = new Date('2026-10-11T01:00:00.000Z');
      expect(await repository.markPlayingGamesDisconnectedAtStartup(firstBoot)).toBe(1);
      const [firstState] = await db.select().from(games).where(eq(games.id, fixture.gameId));
      expect(firstState?.allPlayersDisconnectedAt?.toISOString()).toBe(firstBoot.toISOString());
      expect(await repository.markPlayingGamesDisconnectedAtStartup(new Date('2026-10-11T02:00:00.000Z'))).toBe(0);
      const [secondState] = await db.select().from(games).where(eq(games.id, fixture.gameId));
      expect(secondState?.allPlayersDisconnectedAt?.toISOString()).toBe(firstBoot.toISOString());
    } finally {
      await fixture.cleanup();
    }
  });

  it('deletes only old Card Definition versions with no active Game references', async () => {
    const db = database!.db;
    const fixture = await createFixture(db);
    try {
      await db.insert(cardDefinitionVersions).values({
        cardDefinitionId: fixture.cardDefinitionId, version: 2, englishName: 'Integration v2',
        hasBack: false, frontImageUrl: 'https://cards.example.test/integration-v2.jpg', rulesData: {},
      });
      await db.update(cardDefinitions).set({ currentVersion: 2 }).where(eq(cardDefinitions.id, fixture.cardDefinitionId));
      const cleanup = new CleanupRepository(db);
      expect(await cleanup.deleteUnreferencedCardVersions()).toBe(0);
      expect(await db.select().from(cardDefinitionVersions).where(eq(cardDefinitionVersions.cardDefinitionId, fixture.cardDefinitionId))).toHaveLength(2);

      await db.delete(gameCardDefinitionRefs).where(eq(gameCardDefinitionRefs.gameId, fixture.gameId));
      expect(await cleanup.deleteUnreferencedCardVersions()).toBe(1);
      const remaining = await db.select().from(cardDefinitionVersions).where(eq(cardDefinitionVersions.cardDefinitionId, fixture.cardDefinitionId));
      expect(remaining.map(({ version }) => version)).toEqual([2]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('starts the next Game under Match/Room locks after the current Game ends', async () => {
    const db = database!.db;
    const gameRepository = new GameRepository(db);
    const matchRepository = new MatchRepository(db);
    const fixture = await createFixture(db);
    const nextGameId = `game-${randomUUID()}`;
    try {
      const commandId = `finish-before-next-${randomUUID()}`;
      const event = GameEventSchema.parse({
        type: 'GameEvent', eventId: randomUUID(), gameId: fixture.gameId, sequence: 1,
        eventType: 'GameEnded', payload: {},
      });
      await gameRepository.persistCommand({
        gameId: fixture.gameId,
        actorPlayerId: PlayerIdSchema.parse(fixture.playerIds[0]),
        commandId,
        fingerprint: 'finish-before-next',
        expectedSequence: 0,
        result: CommandResultSchema.parse({ type: 'CommandResult', commandId, success: true }),
        state: { ...fixture.state, status: 'FINISHED', sequence: 1 },
        event,
        eventViews: fixture.playerIds.map((recipientPlayerId) => ({ recipientPlayerId: PlayerIdSchema.parse(recipientPlayerId), payload: event })),
      });
      await confirmFixtureDecks(db, fixture);
      const started = await matchRepository.startNextGame(fixture.roomId, PlayerIdSchema.parse(fixture.playerIds[0]!), async (tx, room, match, gameNumber) => {
        expect(match.currentGameNumber).toBe(1);
        expect(gameNumber).toBe(2);
        const state = createInitialGameState({
          gameId: nextGameId, matchId: match.id, playerIds: match.playerIds as [string, string], hostPlayerId: room.ownerPlayerId,
          decks: match.playerIds.map((playerId) => ({ playerId, mainboard: [{ cardDefinitionId: fixture.cardDefinitionId, quantity: 60 }], sideboard: [] })) as [
            { playerId: string; mainboard: Array<{ cardDefinitionId: string; quantity: number }>; sideboard: Array<{ cardDefinitionId: string; quantity: number }> },
            { playerId: string; mainboard: Array<{ cardDefinitionId: string; quantity: number }>; sideboard: Array<{ cardDefinitionId: string; quantity: number }> },
          ],
          definitions: { [fixture.cardDefinitionId]: { version: 1, status: 'ENABLED' } }, createId: randomUUID, randomIndex: () => 0,
        });
        await tx.insert(games).values({ id: nextGameId, matchId: match.id, gameNumber, status: 'PLAYING', currentSequence: 0 });
        await tx.insert(gameStates).values({ gameId: nextGameId, state });
        await tx.insert(deckSnapshots).values(match.playerIds.map((playerId, index) => ({
          gameId: nextGameId,
          playerId,
          snapshot: { deckId: fixture.deckIds[index], deckName: 'Integration', mainboard: fixture.mainboard, sideboard: [] },
        })));
        await tx.insert(gameCardDefinitionRefs).values({ gameId: nextGameId, cardDefinitionId: fixture.cardDefinitionId, version: 1 });
        return nextGameId;
      });
      expect(started.match).toMatchObject({ currentGameNumber: 2, activeGameId: nextGameId });
      expect(await db.select().from(matches).where(eq(matches.id, fixture.matchId))).toMatchObject([{ currentGameNumber: 2, activeGameId: nextGameId }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('persists the complete Game 1 to Game 5 lifecycle and removes the finished Match', async () => {
    const db = database!.db;
    const gameRepository = new GameRepository(db);
    const matchRepository = new MatchRepository(db);
    const fixture = await createFixture(db);
    try {
      let gameId = fixture.gameId;
      for (let nextNumber = 2; nextNumber <= 5; nextNumber += 1) {
        const previousState = await gameRepository.loadGameState(gameId);
        const commandId = `lifecycle-end-${randomUUID()}`;
        const event = GameEventSchema.parse({ type: 'GameEvent', eventId: randomUUID(), gameId, sequence: previousState.sequence + 1, eventType: 'GameEnded', payload: {} });
        await gameRepository.persistCommand({
          gameId, actorPlayerId: PlayerIdSchema.parse(fixture.playerIds[0]), commandId,
          fingerprint: `lifecycle-${nextNumber}`, expectedSequence: previousState.sequence,
          result: CommandResultSchema.parse({ type: 'CommandResult', commandId, success: true }),
          state: { ...previousState, status: 'FINISHED', sequence: event.sequence }, event,
          eventViews: fixture.playerIds.map((recipientPlayerId) => ({ recipientPlayerId: PlayerIdSchema.parse(recipientPlayerId), payload: event })),
        });
        await confirmFixtureDecks(db, fixture);
        const nextGameId = `game-${randomUUID()}`;
        const started = await matchRepository.startNextGame(fixture.roomId, PlayerIdSchema.parse(fixture.playerIds[0]!), async (tx, room, match, gameNumber) => {
          expect(gameNumber).toBe(nextNumber);
          return persistInitialGame(tx, room, match, gameNumber, nextGameId, fixture);
        });
        expect(started.match.currentGameNumber).toBe(nextNumber);
        expect(started.match.activeGameId).toBe(nextGameId);
        gameId = nextGameId;
      }
      const finalState = await gameRepository.loadGameState(gameId);
      const finalCommand = `lifecycle-game-five-${randomUUID()}`;
      const finalEvent = GameEventSchema.parse({ type: 'GameEvent', eventId: randomUUID(), gameId, sequence: finalState.sequence + 1, eventType: 'GameEnded', payload: {} });
      await gameRepository.persistCommand({
        gameId, actorPlayerId: PlayerIdSchema.parse(fixture.playerIds[0]), commandId: finalCommand,
        fingerprint: 'lifecycle-game-five', expectedSequence: finalState.sequence,
        result: CommandResultSchema.parse({ type: 'CommandResult', commandId: finalCommand, success: true }),
        state: { ...finalState, status: 'FINISHED', sequence: finalEvent.sequence }, event: finalEvent,
        eventViews: fixture.playerIds.map((recipientPlayerId) => ({ recipientPlayerId: PlayerIdSchema.parse(recipientPlayerId), payload: finalEvent })),
      });
      expect(await db.select().from(rooms).where(eq(rooms.id, fixture.roomId))).toHaveLength(0);
      expect(await db.select().from(matches).where(eq(matches.id, fixture.matchId))).toHaveLength(0);
      expect(await db.select().from(games).where(eq(games.matchId, fixture.matchId))).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });
});

async function persistInitialGame(tx: Transaction, room: Room, match: Match, gameNumber: number, gameId: string, fixture: Awaited<ReturnType<typeof createFixture>>) {
  const decks = match.playerIds.map((playerId) => ({
    playerId, mainboard: [{ cardDefinitionId: fixture.cardDefinitionId, quantity: 60 }], sideboard: [],
  })) as [{ playerId: string; mainboard: Array<{ cardDefinitionId: string; quantity: number }>; sideboard: [] }, { playerId: string; mainboard: Array<{ cardDefinitionId: string; quantity: number }>; sideboard: [] }];
  const state = createInitialGameState({
    gameId, matchId: match.id, playerIds: match.playerIds as [string, string], hostPlayerId: room.ownerPlayerId,
    decks, definitions: { [fixture.cardDefinitionId]: { version: 1, status: 'ENABLED' } }, randomIndex: () => 0,
  });
  await tx.insert(games).values({ id: gameId, matchId: match.id, gameNumber, status: 'PLAYING', currentSequence: 0 });
  await tx.insert(gameStates).values({ gameId, state });
  await tx.insert(deckSnapshots).values(room.participants.map((participant) => ({
    gameId, playerId: participant.playerId,
    snapshot: { deckId: participant.deckId, deckName: 'Integration', mainboard: fixture.mainboard, sideboard: [] },
  })));
  await tx.insert(gameCardDefinitionRefs).values({ gameId, cardDefinitionId: fixture.cardDefinitionId, version: 1 });
  return gameId;
}

async function createFixture(db: NonNullable<typeof database>['db'], gameNumber = 1) {
  const userIds = [randomUUID(), randomUUID()];
  const playerIds = [`player-${randomUUID()}`, `player-${randomUUID()}`];
  const deckIds = [`deck-${randomUUID()}`, `deck-${randomUUID()}`];
  const roomId = `room-${randomUUID()}`;
  const matchId = `match-${randomUUID()}`;
  const gameId = `game-${randomUUID()}`;
  const cardDefinitionId = newCardDefinitionId();
  const createdAt = new Date();
  const mainboard = Array.from({ length: 60 }, () => cardDefinitionId);
  const state = createInitialGameState({
    gameId, matchId, playerIds: playerIds as [string, string], hostPlayerId: playerIds[0]!,
    decks: playerIds.map((playerId) => ({ playerId, mainboard: [{ cardDefinitionId, quantity: 60 }], sideboard: [] })) as [
      { playerId: string; mainboard: Array<{ cardDefinitionId: string; quantity: number }>; sideboard: Array<{ cardDefinitionId: string; quantity: number }> },
      { playerId: string; mainboard: Array<{ cardDefinitionId: string; quantity: number }>; sideboard: Array<{ cardDefinitionId: string; quantity: number }> },
    ],
    definitions: { [cardDefinitionId]: { version: 1, status: 'ENABLED' } },
    createId: randomUUID,
    randomIndex: () => 0,
  });

  await db.transaction(async (tx) => {
    await tx.insert(users).values(userIds.map((id) => ({ id, displayName: 'Game Repository Test', createdAt })));
    await tx.insert(decks).values(deckIds.map((id, index) => ({ id, ownerUserId: userIds[index]!, name: 'Integration', mainboard, sideboard: [] })));
    await tx.insert(cardDefinitions).values({ id: cardDefinitionId, currentVersion: 1, status: 'ENABLED' });
    await tx.insert(cardDefinitionVersions).values({
      cardDefinitionId, version: 1, englishName: 'Integration Card', hasBack: false,
      frontImageUrl: 'https://cards.example.test/integration.jpg', rulesData: {},
    });
    await tx.insert(rooms).values({ id: roomId, ownerPlayerId: playerIds[0]!, status: 'IN_MATCH', matchId, createdAt });
    await tx.insert(roomPlayers).values(playerIds.map((playerId, seatOrder) => ({
      roomId, playerId, userId: userIds[seatOrder]!, deckId: deckIds[seatOrder]!, seatOrder,
    })));
    await tx.insert(matches).values({ id: matchId, roomId, status: 'ACTIVE', currentGameNumber: gameNumber, activeGameId: gameId, createdAt });
    await tx.insert(matchPlayers).values(playerIds.map((playerId, seatOrder) => ({ matchId, roomId, playerId, seatOrder })));
    await tx.insert(games).values({ id: gameId, matchId, gameNumber, status: 'PLAYING', currentSequence: 0, createdAt });
    await tx.insert(gameStates).values({ gameId, state });
    await tx.insert(deckSnapshots).values(playerIds.map((playerId, index) => ({
      gameId, playerId, snapshot: { deckId: deckIds[index]!, deckName: 'Integration', mainboard, sideboard: [] },
    })));
    await tx.insert(gameCardDefinitionRefs).values({ gameId, cardDefinitionId, version: 1 });
  });

  return {
    gameId, matchId, roomId, playerIds, userIds, state, deckIds, cardDefinitionId, mainboard,
    cleanup: async () => db.transaction(async (tx) => {
      await tx.delete(matches).where(eq(matches.id, matchId));
      await tx.delete(rooms).where(eq(rooms.id, roomId));
      await tx.delete(decks).where(inArray(decks.id, deckIds));
      await tx.delete(users).where(inArray(users.id, userIds));
      await tx.delete(cardDefinitionVersions).where(eq(cardDefinitionVersions.cardDefinitionId, cardDefinitionId));
      await tx.delete(cardDefinitions).where(eq(cardDefinitions.id, cardDefinitionId));
    }),
  };
}

function newCardDefinitionId(): string {
  const letters = [...randomBytes(3)].map((value) => String.fromCharCode(65 + value % 26)).join('');
  const digits = String(randomBytes(2).readUInt16BE(0) % 1000).padStart(3, '0');
  return `${letters}${digits}`;
}

async function confirmFixtureDecks(db: NonNullable<typeof database>['db'], fixture: Awaited<ReturnType<typeof createFixture>>) {
  const rooms = new RoomRepository(db);
  await Promise.all(fixture.playerIds.map((playerId, index) => rooms.confirmNextGameDeck({
    userId: UserIdSchema.parse(fixture.userIds[index]),
    playerId: PlayerIdSchema.parse(playerId),
    composition: { mainboard: fixture.mainboard, sideboard: [] },
  })));
}

class TestSocket extends EventEmitter implements WebSocketLike {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  failNextEvent = false;
  send(data: string, callback?: (error?: Error) => void) {
    const message = JSON.parse(data) as Record<string, unknown>;
    if (this.failNextEvent && message.type === 'GameEvent') {
      this.failNextEvent = false;
      callback?.(new Error('Simulated socket write failure.'));
      return;
    }
    this.sent.push(message);
    callback?.();
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  message(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  end() { this.close(); }
}

async function flushSockets() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for socket message delivery.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
