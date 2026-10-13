import { and, asc, eq, gt, lte } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  createGameStateView, createViewStateSyncNotification,
  GameStateSchema, ViewStateSchema,
} from '@easymtg/game';
import {
  GameEventSchema, GameIdSchema, MatchStateSyncSchema, PlayerIdSchema, RoomStateSyncSchema,
  ServerMessageSchema, UserIdSchema, type Hello, type PlayerId, type ServerMessage,
} from '@easymtg/shared';
import type { Database } from './client.js';
import { gameEvents, gameEventViews, gameStates, games, matches, roomPlayers, rooms, viewStates } from './schema.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Builds the ordered reconnect snapshot from PostgreSQL, which remains the source of truth. */
export class GameSyncRepository {
  constructor(private readonly db: Database) {}

  async getCurrentGameView(userId: string): Promise<{ gameId: string; sequence: number; gameStateView: unknown } | null> {
    const messages = await this.buildMessages(userId, { type: 'Hello', protocolVersion: 1, lastGameId: null, lastSequence: null });
    const initial = messages.find((message) => message.type === 'InitialState');
    return initial?.type === 'InitialState' ? { gameId: initial.gameId, sequence: initial.sequence, gameStateView: initial.gameStateView } : null;
  }

  async resolveConnectionContext(userId: string): Promise<{ roomId: string; playerId: PlayerId; participantIds: PlayerId[]; matchId: string | null; gameId: string | null; gameNumber: number | null } | null> {
    const [membership] = await this.db.select({ roomId: roomPlayers.roomId, playerId: roomPlayers.playerId, matchId: rooms.matchId })
      .from(roomPlayers).innerJoin(rooms, eq(rooms.id, roomPlayers.roomId)).where(eq(roomPlayers.userId, UserIdSchema.parse(userId)));
    if (!membership) return null;
    const participants = await this.db.select({ playerId: roomPlayers.playerId }).from(roomPlayers)
      .where(eq(roomPlayers.roomId, membership.roomId)).orderBy(asc(roomPlayers.seatOrder));
    let gameId: string | null = null;
    let gameNumber: number | null = null;
    let matchId = membership.matchId;
    if (membership.matchId) {
      const [match] = await this.db.select({ id: matches.id, gameId: matches.activeGameId, gameNumber: matches.currentGameNumber, status: matches.status }).from(matches).where(eq(matches.id, membership.matchId));
      if (!match || match.status !== 'ACTIVE') matchId = null;
      else if (match.gameId) { gameId = match.gameId; gameNumber = match.gameNumber; }
    }
    return {
      roomId: membership.roomId,
      playerId: PlayerIdSchema.parse(membership.playerId),
      participantIds: participants.map(({ playerId }) => PlayerIdSchema.parse(playerId)),
      matchId,
      gameId,
      gameNumber,
    };
  }

  async buildMessages(userId: string, hello: Hello, connectionState: (playerId: PlayerId) => 'CONNECTED' | 'DISCONNECTED' = () => 'DISCONNECTED'): Promise<ServerMessage[]> {
    const parsedUserId = UserIdSchema.parse(userId);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level repeatable read read only`);
      const [membership] = await tx.select({ room: rooms, playerId: roomPlayers.playerId })
        .from(roomPlayers).innerJoin(rooms, eq(rooms.id, roomPlayers.roomId)).where(eq(roomPlayers.userId, parsedUserId));
      const room = membership?.room;
      const roomMessage = RoomStateSyncSchema.parse({
        type: 'RoomStateSync',
        room: room ? {
          roomId: room.id, status: room.status, ownerPlayerId: room.ownerPlayerId,
          participants: (await tx.select().from(roomPlayers).where(eq(roomPlayers.roomId, room.id)).orderBy(asc(roomPlayers.seatOrder)))
            .map((member) => ({ playerId: member.playerId, connectionState: connectionState(PlayerIdSchema.parse(member.playerId)) })),
          ...(room.matchId ? { matchId: room.matchId } : {}),
        } : null,
      });

      let matchMessage = MatchStateSyncSchema.parse({ type: 'MatchStateSync', match: null });
      let syncMessages: ServerMessage[] = [];
      if (room?.matchId) {
        const [match] = await tx.select().from(matches).where(eq(matches.id, room.matchId));
        if (match) {
          matchMessage = MatchStateSyncSchema.parse({ type: 'MatchStateSync', match: {
            matchId: match.id, status: match.status, currentGameNumber: match.currentGameNumber,
            ...(match.activeGameId ? { activeGameId: match.activeGameId } : {}),
          } });
          if (match.status === 'ACTIVE' && match.activeGameId) {
            syncMessages = await this.buildGameMessages(tx, match.activeGameId, membership!.playerId, hello);
          }
        }
      }
      return [ServerMessageSchema.parse({ type: 'Welcome', protocolVersion: 1 }), roomMessage, matchMessage, ...syncMessages];
    });
  }

  private async buildGameMessages(tx: Transaction, gameId: string, rawPlayerId: string, hello: Hello): Promise<ServerMessage[]> {
    const playerId = PlayerIdSchema.parse(rawPlayerId);
    const parsedGameId = GameIdSchema.parse(gameId);
    const [row] = await tx.select({ game: games, state: gameStates.state })
      .from(games).innerJoin(gameStates, eq(gameStates.gameId, games.id)).where(eq(games.id, parsedGameId));
    if (!row) return [];
    const state = GameStateSchema.parse(row.state);
    if (state.gameId !== parsedGameId || state.matchId !== row.game.matchId || state.sequence !== row.game.currentSequence ||
        !state.players.some((player) => player.playerId === playerId)) {
      throw new Error(`Persisted GameState is inconsistent for active Game ${parsedGameId}.`);
    }

    let messages: ServerMessage[];
    if (hello.lastGameId === parsedGameId && hello.lastSequence !== null && hello.lastSequence < state.sequence) {
      const rows = await tx.select({ payload: gameEventViews.payload, sequence: gameEvents.sequence })
        .from(gameEvents).innerJoin(gameEventViews, eq(gameEventViews.eventId, gameEvents.eventId))
        .where(and(eq(gameEvents.gameId, parsedGameId), eq(gameEventViews.recipientPlayerId, playerId), gt(gameEvents.sequence, hello.lastSequence), lte(gameEvents.sequence, state.sequence)))
        .orderBy(asc(gameEvents.sequence));
      const contiguous = rows.length === state.sequence - hello.lastSequence && rows.every((event, index) => event.sequence === hello.lastSequence! + index + 1);
      messages = contiguous ? rows.map(({ payload }) => GameEventSchema.parse(payload)) : [
        { type: 'InitialState', gameId: parsedGameId, sequence: state.sequence, gameStateView: createGameStateView(state, playerId) },
      ];
    } else {
      messages = [{ type: 'InitialState', gameId: parsedGameId, sequence: state.sequence, gameStateView: createGameStateView(state, playerId) }];
    }

    const [storedView] = await tx.select().from(viewStates)
      .where(and(eq(viewStates.gameId, parsedGameId), eq(viewStates.viewerPlayerId, playerId)));
    if (storedView) {
      const stored = storedView.state;
      if (typeof stored !== 'object' || stored === null || !('viewState' in stored)) throw new Error(`Persisted ViewState is invalid for ${parsedGameId}.`);
      const view = ViewStateSchema.parse(stored.viewState);
      const notification = createViewStateSyncNotification(state, view, playerId);
      messages.push(ServerMessageSchema.parse({ type: 'ViewStateSync', payload: notification.payload }));
    }
    return messages.map((message) => ServerMessageSchema.parse(message));
  }
}
