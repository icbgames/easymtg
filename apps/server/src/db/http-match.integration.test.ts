import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { HelloSchema } from '@easymtg/shared';
import { buildApp } from '../app.js';
import { CardDefinitionRepository } from './card-definition-repository.js';
import { createDatabase } from './client.js';
import { DeckRepository } from './deck-repository.js';
import { GameRepository } from './game-repository.js';
import { GameSyncRepository } from './game-sync-repository.js';
import { RoomLifecycleApi } from '../room-lifecycle-api.js';
import { SessionRepository } from './session-repository.js';
import { cardDefinitionVersions, cardDefinitions, deckSnapshots, decks, games, matches, rooms, sessions as sessionTable, users } from './schema.js';
import { WebSocketSessionManager, type WebSocketLike } from '../websocket-session-manager.js';

const enabled = Boolean(process.env.DATABASE_URL);
const database = enabled ? createDatabase() : undefined;
const suite = describe.skipIf(!enabled);

suite('HTTP two-player Match PostgreSQL integration', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterAll(async () => {
    await app?.close();
    await database?.pool.end();
  });

  it('runs both players through Deck creation, Game 1–5 and Match cleanup over HTTP and WebSocket', async () => {
    const db = database!.db;
    const sessions = new SessionRepository(db);
    const decksRepository = new DeckRepository(db);
    const gameRepository = new GameRepository(db);
    const gameSync = new GameSyncRepository(db);
    const webSocketSessions = new WebSocketSessionManager(gameSync, gameRepository);
    const lifecycle = new RoomLifecycleApi(db, undefined, (playerId) => webSocketSessions.getConnectionState(playerId));
    const cards = new CardDefinitionRepository(db);
    const cardDefinitionId = createCardDefinitionId();
    const joiningCardDefinitionId = createCardDefinitionId();
    const mainboard = Array.from({ length: 61 }, () => cardDefinitionId);
    const joiningMainboard = Array.from({ length: 61 }, () => joiningCardDefinitionId);
    let roomId: string | undefined;
    let ownerDeckId: string | undefined;
    let joiningDeckId: string | undefined;
    let ownerUserId: string | undefined;
    let joiningUserId: string | undefined;
    let cardDefinitionCreated = false;
    const clients: MatchTestSocket[] = [];

    await db.transaction(async (tx) => {
      await tx.insert(cardDefinitions).values([
        { id: cardDefinitionId, currentVersion: 1, status: 'ENABLED' },
        { id: joiningCardDefinitionId, currentVersion: 1, status: 'ENABLED' },
      ]);
      await tx.insert(cardDefinitionVersions).values([
        {
          cardDefinitionId, version: 1, englishName: 'HTTP Integration Card', hasBack: false,
          frontImageUrl: 'https://cards.example.test/http-integration.jpg', rulesData: {},
        },
        {
          cardDefinitionId: joiningCardDefinitionId, version: 1, englishName: 'Joining Integration Card', hasBack: false,
          frontImageUrl: 'https://cards.example.test/joining-integration.jpg', rulesData: {},
        },
      ]);
    });
    cardDefinitionCreated = true;

    try {
      app = await buildApp({
        secureCookies: false,
        cardDefinitions: cards,
        cardDefinitionDetails: cards,
        cardDefinitionVersions: cards,
        currentGameView: gameSync,
        decks: decksRepository,
        sessions,
        webSockets: webSocketSessions,
        roomLifecycle: lifecycle,
      });

      const owner = await sessions.createAnonymousUser('Owner');
      const joiningPlayer = await sessions.createAnonymousUser('Joining player');
      ownerUserId = owner.user.id;
      joiningUserId = joiningPlayer.user.id;
      const ownerHeaders = { cookie: `easymtg_session=${owner.token}` };
      const joiningHeaders = { cookie: `easymtg_session=${joiningPlayer.token}` };

      const ownerDeckResponse = await app.inject({
        method: 'POST', url: '/api/decks', headers: ownerHeaders,
        payload: { name: 'Owner Deck', mainboard, sideboard: [] },
      });
      expect(ownerDeckResponse.statusCode).toBe(200);
      const ownerDeck = ownerDeckResponse.json();
      ownerDeckId = ownerDeck.id;
      expect(ownerDeck).toMatchObject({ name: 'Owner Deck', mainboard, sideboard: [] });

      const joiningDeckResponse = await app.inject({
        method: 'POST', url: '/api/decks', headers: joiningHeaders,
        payload: { name: 'Joining Deck', mainboard: joiningMainboard, sideboard: [] },
      });
      expect(joiningDeckResponse.statusCode).toBe(200);
      const joiningDeck = joiningDeckResponse.json();
      joiningDeckId = joiningDeck.id;

      const listedOwnerDecks = await app.inject({ method: 'GET', url: '/api/decks', headers: ownerHeaders });
      expect(listedOwnerDecks.statusCode).toBe(200);
      expect(listedOwnerDecks.json()).toHaveLength(1);
      expect(listedOwnerDecks.json()[0]).toMatchObject({ id: ownerDeckId, mainboardCount: 61, sideboardCount: 0 });

      const createdRoomResponse = await app.inject({
        method: 'POST', url: '/api/rooms', headers: ownerHeaders, payload: { deckId: ownerDeckId },
      });
      expect(createdRoomResponse.statusCode).toBe(200);
      const createdRoom = createdRoomResponse.json();
      roomId = createdRoom.room.roomId;
      expect(createdRoom.room.status).toBe('WAITING');
      expect(createdRoom.room.participants[0]).not.toHaveProperty('deckId');

      const joinedRoomResponse = await app.inject({
        method: 'POST', url: `/api/rooms/${roomId}/join`, headers: joiningHeaders, payload: { deckId: joiningDeckId },
      });
      expect(joinedRoomResponse.statusCode).toBe(200);
      const joinedRoom = joinedRoomResponse.json();
      expect(joinedRoom).toMatchObject({ gameNumber: 1 });
      expect(joinedRoom.gameId).toBeTruthy();
      expect(joinedRoom.room.participants).toHaveLength(2);
      expect(joinedRoom.room.participants.every((participant: Record<string, unknown>) => !('deckId' in participant))).toBe(true);

      const ownerCurrentRoom = await app.inject({ method: 'GET', url: '/api/rooms/current', headers: ownerHeaders });
      const joiningCurrentRoom = await app.inject({ method: 'GET', url: '/api/rooms/current', headers: joiningHeaders });
      expect(ownerCurrentRoom.statusCode).toBe(200);
      expect(joiningCurrentRoom.statusCode).toBe(200);
      expect(ownerCurrentRoom.json().room).toMatchObject({ roomId, status: 'IN_MATCH' });
      expect(joiningCurrentRoom.json().room).toMatchObject({ roomId, status: 'IN_MATCH' });

      const [ownerGame, joiningGame] = await Promise.all([
        app.inject({ method: 'GET', url: '/api/rooms/current/game-state', headers: ownerHeaders }),
        app.inject({ method: 'GET', url: '/api/rooms/current/game-state', headers: joiningHeaders }),
      ]);
      expect(ownerGame.statusCode).toBe(200);
      expect(joiningGame.statusCode).toBe(200);
      assertOpponentHandIsMasked(ownerGame.json().game.gameStateView, ownerCurrentRoom.json().playerId);
      assertOpponentHandIsMasked(joiningGame.json().game.gameStateView, joiningCurrentRoom.json().playerId);

      const ownerSocket = new MatchTestSocket();
      const joiningSocket = new MatchTestSocket();
      clients.push(ownerSocket, joiningSocket);
      const logger = { error: () => undefined };
      webSocketSessions.accept(ownerUserId, ownerSocket, logger);
      webSocketSessions.accept(joiningUserId, joiningSocket, logger);
      ownerSocket.message(HelloSchema.parse({ type: 'Hello', protocolVersion: 1, lastGameId: null, lastSequence: null }));
      joiningSocket.message(HelloSchema.parse({ type: 'Hello', protocolVersion: 1, lastGameId: null, lastSequence: null }));
      await waitFor(() => ownerSocket.has('InitialState', joinedRoom.gameId) && joiningSocket.has('InitialState', joinedRoom.gameId));

      let activeGameId = joinedRoom.gameId as string;
      for (let gameNumber = 1; gameNumber <= 5; gameNumber += 1) {
        if (gameNumber > 1) {
          const composition = { mainboard: mainboard.slice(1), sideboard: [mainboard[0]!] };
          const joiningComposition = { mainboard: joiningMainboard.slice(1), sideboard: [joiningMainboard[0]!] };
          const prematureStart = await app.inject({ method: 'POST', url: '/api/rooms/current/games/next', headers: ownerHeaders });
          expect(prematureStart.statusCode).toBe(409);
          expect(prematureStart.json().error.code).toBe('PLAYERS_NOT_READY');

          const ownerConfirmed = await app.inject({
            method: 'PUT', url: '/api/rooms/current/next-game-deck', headers: ownerHeaders, payload: composition,
          });
          expect(ownerConfirmed.statusCode).toBe(200);
          const ownerPrivateDeck = await app.inject({ method: 'GET', url: '/api/rooms/current', headers: ownerHeaders });
          const opponentPrivateDeck = await app.inject({ method: 'GET', url: '/api/rooms/current', headers: joiningHeaders });
          expect(ownerPrivateDeck.json().nextGameDeck).toMatchObject({ mainboard: composition.mainboard, sideboard: composition.sideboard, confirmed: true });
          expect(opponentPrivateDeck.json().nextGameDeck).not.toHaveProperty('mainboard', composition.mainboard);

          const onePlayerReadyStart = await app.inject({ method: 'POST', url: '/api/rooms/current/games/next', headers: ownerHeaders });
          expect(onePlayerReadyStart.statusCode).toBe(409);
          expect(onePlayerReadyStart.json().error.code).toBe('PLAYERS_NOT_READY');

          const joiningConfirmed = await app.inject({
            method: 'PUT', url: '/api/rooms/current/next-game-deck', headers: joiningHeaders, payload: joiningComposition,
          });
          expect(joiningConfirmed.statusCode).toBe(200);
          const ownerPrivateDeckAfterConfirmation = await app.inject({ method: 'GET', url: '/api/rooms/current', headers: ownerHeaders });
          const joiningPrivateDeckAfterConfirmation = await app.inject({ method: 'GET', url: '/api/rooms/current', headers: joiningHeaders });
          expect(ownerPrivateDeckAfterConfirmation.json().nextGameDeck.mainboard).not.toContain(joiningCardDefinitionId);
          expect(ownerPrivateDeckAfterConfirmation.json().nextGameDeck.sideboard).not.toContain(joiningCardDefinitionId);
          expect(joiningPrivateDeckAfterConfirmation.json().nextGameDeck.mainboard).not.toContain(cardDefinitionId);
          expect(joiningPrivateDeckAfterConfirmation.json().nextGameDeck.sideboard).not.toContain(cardDefinitionId);
          const nonOwnerStart = await app.inject({ method: 'POST', url: '/api/rooms/current/games/next', headers: joiningHeaders });
          expect(nonOwnerStart.statusCode).toBe(403);
          expect(nonOwnerStart.json().error.code).toBe('FORBIDDEN');

          const started = await app.inject({ method: 'POST', url: '/api/rooms/current/games/next', headers: ownerHeaders });
          expect(started.statusCode).toBe(200);
          expect(started.json()).toMatchObject({ gameNumber });
          activeGameId = started.json().gameId;
          await waitFor(() => ownerSocket.has('InitialState', activeGameId) && joiningSocket.has('InitialState', activeGameId));

          const [ownerSnapshot] = await db.select().from(deckSnapshots).where(and(
            eq(deckSnapshots.gameId, activeGameId),
            eq(deckSnapshots.playerId, ownerCurrentRoom.json().playerId),
          )).limit(1);
          const [joiningSnapshot] = await db.select().from(deckSnapshots).where(and(
            eq(deckSnapshots.gameId, activeGameId),
            eq(deckSnapshots.playerId, joiningCurrentRoom.json().playerId),
          )).limit(1);
          expect(ownerSnapshot?.snapshot).toMatchObject({ mainboard: composition.mainboard, sideboard: composition.sideboard });
          expect(joiningSnapshot?.snapshot).toMatchObject({ mainboard: joiningComposition.mainboard, sideboard: joiningComposition.sideboard });
        }

        ownerSocket.clear();
        joiningSocket.clear();
        const commandId = randomUUID();
        ownerSocket.message({ type: 'Concede', commandId });
        await waitFor(() =>
          ownerSocket.has('CommandResult', commandId) &&
          ownerSocket.has('GameEnded', activeGameId) &&
          joiningSocket.has('GameEnded', activeGameId),
        );
        expect(ownerSocket.find('CommandResult', commandId)).toMatchObject({ success: true, commandId });
        expect(ownerSocket.find('GameEvent', activeGameId)).toMatchObject({ eventType: 'ConcedeApplied' });
        for (const socket of clients) {
          const gameEnded = socket.find('GameEnded', activeGameId);
          expect(gameEnded).toMatchObject({ gameNumber, gameStatus: 'FINISHED' });
          expect(gameEnded).not.toHaveProperty('winnerPlayerId');
          expect(gameEnded).not.toHaveProperty('loserPlayerId');
        }

        if (gameNumber < 5) {
          const activeRoom = await app.inject({ method: 'GET', url: '/api/rooms/current', headers: ownerHeaders });
          expect(activeRoom.statusCode).toBe(200);
          expect(activeRoom.json().room).toMatchObject({ roomId, status: 'IN_MATCH' });
        } else {
          for (const headers of [ownerHeaders, joiningHeaders]) {
            const finishedRoom = await app.inject({ method: 'GET', url: '/api/rooms/current', headers });
            const finishedGame = await app.inject({ method: 'GET', url: '/api/rooms/current/game-state', headers });
            expect(finishedRoom.json()).toEqual({ room: null });
            expect(finishedGame.json()).toEqual({ game: null });
          }
          expect(await db.select().from(rooms).where(eq(rooms.id, roomId))).toHaveLength(0);
          expect(await db.select().from(matches).where(eq(matches.id, joinedRoom.room.matchId))).toHaveLength(0);
          expect(await db.select().from(games).where(eq(games.matchId, joinedRoom.room.matchId))).toHaveLength(0);
          expect(ownerSocket.find('MatchEnded', joinedRoom.room.matchId)).toMatchObject({ gameNumber: 5 });
          expect(joiningSocket.find('MatchEnded', joinedRoom.room.matchId)).toMatchObject({ gameNumber: 5 });
        }
      }
    } finally {
      clients.forEach((socket) => socket.end());
      await app?.close();
      app = undefined;
      await db.transaction(async (tx) => {
        if (roomId) {
          await tx.update(rooms).set({ status: 'WAITING', matchId: null }).where(eq(rooms.id, roomId));
          await tx.delete(matches).where(eq(matches.roomId, roomId));
          await tx.delete(rooms).where(eq(rooms.id, roomId));
        }
        if (ownerDeckId) await tx.delete(decks).where(eq(decks.id, ownerDeckId));
        if (joiningDeckId) await tx.delete(decks).where(eq(decks.id, joiningDeckId));
        if (ownerUserId) await tx.delete(sessionTable).where(eq(sessionTable.userId, ownerUserId));
        if (joiningUserId) await tx.delete(sessionTable).where(eq(sessionTable.userId, joiningUserId));
        if (ownerUserId) await tx.delete(users).where(eq(users.id, ownerUserId));
        if (joiningUserId) await tx.delete(users).where(eq(users.id, joiningUserId));
        if (cardDefinitionCreated) {
          await tx.delete(cardDefinitionVersions).where(eq(cardDefinitionVersions.cardDefinitionId, cardDefinitionId));
          await tx.delete(cardDefinitionVersions).where(eq(cardDefinitionVersions.cardDefinitionId, joiningCardDefinitionId));
          await tx.delete(cardDefinitions).where(eq(cardDefinitions.id, cardDefinitionId));
          await tx.delete(cardDefinitions).where(eq(cardDefinitions.id, joiningCardDefinitionId));
        }
      });
    }
  });
});

class MatchTestSocket extends EventEmitter implements WebSocketLike {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];

  send(data: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
    callback?.();
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  message(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }

  end() {
    this.close();
  }

  has(type: string, id?: string) {
    return this.sent.some((message) =>
      message.type === type &&
      (id === undefined || message.gameId === id || message.commandId === id || message.matchId === id),
    );
  }

  find(type: string, id: string) {
    return this.sent.find((message) => message.type === type && (message.gameId === id || message.commandId === id || message.matchId === id));
  }

  clear() {
    this.sent.length = 0;
  }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Match WebSocket messages.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assertOpponentHandIsMasked(gameStateView: {
  zones: Array<{ type: string; ownerPlayerId: string; cards: Array<Record<string, unknown>> }>;
}, viewerPlayerId: string) {
  const ownHand = gameStateView.zones.find((zone) => zone.type === 'HAND' && zone.ownerPlayerId === viewerPlayerId);
  const opponentHand = gameStateView.zones.find((zone) => zone.type === 'HAND' && zone.ownerPlayerId !== viewerPlayerId);
  expect(ownHand?.cards).toHaveLength(7);
  expect(ownHand?.cards.every((card) => typeof card.cardDefinitionId === 'string' && typeof card.cardId === 'string')).toBe(true);
  expect(opponentHand?.cards).toHaveLength(7);
  expect(opponentHand?.cards.every((card) => !('cardDefinitionId' in card) && !('cardId' in card) && !('cardDefinitionVersion' in card))).toBe(true);
}

function createCardDefinitionId() {
  const bytes = randomBytes(5);
  const prefix = [...bytes.subarray(0, 3)].map((value) => String.fromCharCode(65 + value % 26)).join('');
  return `${prefix}${(bytes.readUInt16BE(3) % 1000).toString().padStart(3, '0')}`;
}
