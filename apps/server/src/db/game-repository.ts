import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  CommandResultSchema, GameCardIdSchema, GameEventSchema, PlayerIdSchema,
  type CommandResult, type GameCardId, type GameEvent, type PlayerId,
} from '@easymtg/shared';
import { GameStateSchema, ViewStateSchema, type GameState, type ViewState } from '@easymtg/game';
import type { Database } from './client.js';
import { commandResults, gameCardDefinitionRefs, gameEventViews, gameEvents, gameStates, games, matches, rooms, viewStates } from './schema.js';

export type PersistedViewStateChange = { playerId: PlayerId; value: ViewState | null; sourceCardIdsSnapshot?: string[] | null };
export type PersistCommandInput = {
  gameId: string;
  actorPlayerId: PlayerId;
  commandId: string;
  fingerprint: string;
  expectedSequence: number;
  result: CommandResult;
  state?: GameState;
  event?: GameEvent;
  eventViews?: Array<{ recipientPlayerId: PlayerId; payload: GameEvent }>;
  viewStateChange?: PersistedViewStateChange;
};
export type PersistCommandOutcome =
  | { kind: 'committed'; result: CommandResult; event: GameEvent | null; eventViews: Array<{ recipientPlayerId: PlayerId; payload: GameEvent }> }
  | { kind: 'duplicate'; result: CommandResult }
  | { kind: 'conflict' };

export class PersistedGameStateError extends Error {
  constructor(readonly code: 'GAME_NOT_FOUND' | 'INVALID_STATE', message: string) {
    super(message);
    this.name = 'PersistedGameStateError';
  }
}

export class ConcurrentGameCommandError extends Error {
  constructor() { super('Game state changed before the command could be committed.'); this.name = 'ConcurrentGameCommandError'; }
}

/** PostgreSQL commit boundary for canonical state, event views, ViewState, and command receipt. */
export class GameRepository {
  constructor(private readonly db: Database) {}

  async loadGameRuntime(gameId: string): Promise<{ state: GameState; viewStates: Array<{ playerId: PlayerId; value: ViewState; sourceCardIdsSnapshot: GameCardId[] | null }> }> {
    const state = await this.loadGameState(gameId);
    const rows = await this.db.select().from(viewStates).where(eq(viewStates.gameId, gameId));
    const restored = rows.map((row) => {
      const stored = row.state;
      if (typeof stored !== 'object' || stored === null || !('viewState' in stored)) throw new PersistedGameStateError('INVALID_STATE', `Persisted ViewState is invalid for Game ${gameId}.`);
      const value = ViewStateSchema.parse(stored.viewState);
      if (value.viewerPlayerId !== row.viewerPlayerId) throw new PersistedGameStateError('INVALID_STATE', `Persisted ViewState owner is invalid for Game ${gameId}.`);
      const snapshot = stored.sourceCardIdsSnapshot;
      if (snapshot !== null && (!Array.isArray(snapshot) || snapshot.some((id) => typeof id !== 'string'))) {
        throw new PersistedGameStateError('INVALID_STATE', `Persisted ViewState source snapshot is invalid for Game ${gameId}.`);
      }
      return { playerId: PlayerIdSchema.parse(row.viewerPlayerId), value, sourceCardIdsSnapshot: snapshot === null ? null : snapshot.map((id) => GameCardIdSchema.parse(id)) };
    });
    return { state, viewStates: restored };
  }

  async loadPlayerEventView(eventId: string, playerId: PlayerId): Promise<import('@easymtg/shared').GameEvent | null> {
    const [row] = await this.db.select({ payload: gameEventViews.payload })
      .from(gameEventViews).where(and(eq(gameEventViews.eventId, eventId), eq(gameEventViews.recipientPlayerId, playerId)));
    return row ? GameEventSchema.parse(row.payload) : null;
  }

  async setAllPlayersDisconnectedAt(gameId: string, value: Date | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [game] = await tx.select().from(games).where(eq(games.id, gameId)).for('update');
      if (!game || game.status !== 'PLAYING') return;
      await tx.update(games).set({ allPlayersDisconnectedAt: value }).where(eq(games.id, gameId));
    });
  }

  /** Run before accepting sockets: process-local Session ownership was lost on restart. */
  async markPlayingGamesDisconnectedAtStartup(now = new Date()): Promise<number> {
    const rows = await this.db.update(games).set({ allPlayersDisconnectedAt: now })
      .where(and(eq(games.status, 'PLAYING'), isNull(games.allPlayersDisconnectedAt))).returning({ id: games.id });
    return rows.length;
  }

  /** Marks due Games abandoned while competing reconnects serialize on the Game row. */
  async abandonExpiredBatch(now = new Date(), limit = 100): Promise<Array<{ roomId: string; matchId: string; gameId: string; gameNumber: number }>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Abandon batch limit must be between 1 and 1000.');
    return this.db.transaction(async (tx) => {
      const due = await tx.select({ id: games.id }).from(games)
        .where(and(eq(games.status, 'PLAYING'), lte(games.allPlayersDisconnectedAt, new Date(now.getTime() - 30 * 60 * 1000))))
        .orderBy(asc(games.allPlayersDisconnectedAt), asc(games.id)).limit(limit).for('update', { skipLocked: true });
      const abandoned: Array<{ roomId: string; matchId: string; gameId: string; gameNumber: number }> = [];
      for (const { id } of due) {
        const [game] = await tx.select().from(games).where(eq(games.id, id)).for('update');
        if (!game || game.status !== 'PLAYING' || !game.allPlayersDisconnectedAt || game.allPlayersDisconnectedAt.getTime() > now.getTime() - 30 * 60 * 1000) continue;
        const [match] = await tx.select().from(matches).where(eq(matches.id, game.matchId)).for('update');
        if (!match || match.status !== 'ACTIVE' || match.activeGameId !== game.id || match.currentGameNumber !== game.gameNumber) continue;
        const [room] = await tx.select().from(rooms).where(eq(rooms.id, match.roomId)).for('update');
        const [stored] = await tx.select().from(gameStates).where(eq(gameStates.gameId, game.id));
        if (!room || room.status !== 'IN_MATCH' || room.matchId !== match.id || !stored) continue;
        const state = GameStateSchema.parse(stored.state);
        if (state.status !== 'PLAYING' || state.gameId !== game.id || state.sequence !== game.currentSequence) {
          throw new PersistedGameStateError('INVALID_STATE', `Persisted GameState cannot be abandoned for ${game.id}.`);
        }
        await tx.update(gameStates).set({ state: { ...state, status: 'ABANDONED' } }).where(eq(gameStates.gameId, game.id));
        await tx.update(games).set({ status: 'ABANDONED', allPlayersDisconnectedAt: null }).where(eq(games.id, game.id));
        await tx.delete(gameEvents).where(eq(gameEvents.gameId, game.id));
        await tx.delete(commandResults).where(eq(commandResults.gameId, game.id));
        await tx.delete(viewStates).where(eq(viewStates.gameId, game.id));
        await tx.delete(gameCardDefinitionRefs).where(eq(gameCardDefinitionRefs.gameId, game.id));
        if (game.gameNumber === 5) {
          await tx.update(matches).set({ status: 'ENDED', activeGameId: null }).where(eq(matches.id, match.id));
          await tx.delete(rooms).where(eq(rooms.id, room.id));
          await tx.delete(matches).where(eq(matches.id, match.id));
        } else {
          await tx.update(matches).set({ activeGameId: null }).where(eq(matches.id, match.id));
        }
        abandoned.push({ roomId: room.id, matchId: match.id, gameId: game.id, gameNumber: game.gameNumber });
      }
      return abandoned;
    });
  }

  async loadGameState(gameId: string): Promise<GameState> {
    const [row] = await this.db.select({
      game: games,
      state: gameStates.state,
    }).from(games).innerJoin(gameStates, eq(gameStates.gameId, games.id)).where(eq(games.id, gameId));
    if (!row) throw new PersistedGameStateError('GAME_NOT_FOUND', 'Persisted Game or GameState does not exist.');
    return this.parsePersistedState(row.state, row.game.id, row.game.matchId, row.game.status, row.game.currentSequence);
  }

  async persistCommand(input: PersistCommandInput): Promise<PersistCommandOutcome> {
    const result = CommandResultSchema.parse(input.result);
    if (result.commandId !== input.commandId) throw new TypeError('CommandResult commandId must match the persisted commandId.');
    if (!result.success && (input.state !== undefined || input.event !== undefined || input.eventViews?.length || input.viewStateChange !== undefined)) {
      throw new TypeError('Failed commands cannot change GameState, Event, or ViewState.');
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.commandId}, 0))`);
      const [prior] = await tx.select().from(commandResults).where(eq(commandResults.commandId, input.commandId));
      if (prior) {
        if (prior.gameId !== input.gameId || prior.actorPlayerId !== input.actorPlayerId || prior.fingerprint !== input.fingerprint) {
          return { kind: 'conflict' } as const;
        }
        return { kind: 'duplicate', result: CommandResultSchema.parse(prior.result) } as const;
      }

      const [row] = await tx.select({ game: games, state: gameStates.state })
        .from(games).innerJoin(gameStates, eq(gameStates.gameId, games.id))
        .where(eq(games.id, input.gameId)).for('update', { of: games });
      if (!row) throw new PersistedGameStateError('GAME_NOT_FOUND', 'Persisted Game or GameState does not exist.');
      const current = this.parsePersistedState(row.state, row.game.id, row.game.matchId, row.game.status, row.game.currentSequence);
      if (current.sequence !== input.expectedSequence) throw new ConcurrentGameCommandError();

      const nextState = input.state === undefined ? undefined : GameStateSchema.parse(input.state);
      const event = input.event === undefined ? undefined : GameEventSchema.parse(input.event);
      if ((nextState === undefined) !== (event === undefined)) throw new TypeError('A canonical state update and GameEvent must be committed together.');
      if (nextState && event) {
        if (nextState.gameId !== input.gameId || event.gameId !== input.gameId || nextState.matchId !== current.matchId ||
            nextState.sequence !== current.sequence + 1 || event.sequence !== nextState.sequence ||
            nextState.status !== eventStatus(row.game.status, nextState.status)) {
          throw new TypeError('GameState and Event do not form a valid next sequence.');
        }
        this.assertEventViews(event, input.eventViews ?? [], current.players.map(({ playerId }) => playerId));
        await tx.update(gameStates).set({ state: nextState }).where(eq(gameStates.gameId, input.gameId));
        await tx.update(games).set({ status: nextState.status, currentSequence: nextState.sequence }).where(eq(games.id, input.gameId));
        await tx.insert(gameEvents).values({ eventId: event.eventId, gameId: input.gameId, sequence: event.sequence, event });
        await tx.insert(gameEventViews).values((input.eventViews ?? []).map((item) => ({
          eventId: event.eventId, recipientPlayerId: item.recipientPlayerId, payload: item.payload,
        })));
      } else if (input.eventViews?.length) {
        throw new TypeError('Event views cannot be stored without a canonical GameEvent.');
      }

      if (input.viewStateChange) await this.persistViewState(tx, input.gameId, input.viewStateChange);
      await tx.insert(commandResults).values({
        commandId: input.commandId,
        gameId: input.gameId,
        actorPlayerId: input.actorPlayerId,
        fingerprint: input.fingerprint,
        result,
      });
      if (nextState && (nextState.status === 'FINISHED' || nextState.status === 'ABANDONED')) {
        const [match] = await tx.select().from(matches).where(eq(matches.id, row.game.matchId)).for('update');
        if (!match || match.status !== 'ACTIVE' || match.currentGameNumber !== row.game.gameNumber || match.activeGameId !== input.gameId) {
          throw new PersistedGameStateError('INVALID_STATE', 'Terminal Game does not match the active Match/Game relationship.');
        }
        const [room] = await tx.select().from(rooms).where(eq(rooms.id, match.roomId)).for('update');
        if (!room || room.status !== 'IN_MATCH' || room.matchId !== match.id) {
          throw new PersistedGameStateError('INVALID_STATE', 'Terminal Game has no matching active Room.');
        }
        await tx.delete(gameEvents).where(eq(gameEvents.gameId, input.gameId));
        await tx.delete(commandResults).where(eq(commandResults.gameId, input.gameId));
        await tx.delete(viewStates).where(eq(viewStates.gameId, input.gameId));
        await tx.delete(gameCardDefinitionRefs).where(eq(gameCardDefinitionRefs.gameId, input.gameId));
        if (row.game.gameNumber < 5) {
          await tx.update(matches).set({ activeGameId: null }).where(eq(matches.id, match.id));
        } else {
          await tx.update(matches).set({ status: 'ENDED', activeGameId: null }).where(eq(matches.id, match.id));
          await tx.delete(rooms).where(eq(rooms.id, room.id));
          await tx.delete(matches).where(eq(matches.id, match.id));
        }
      }
      return { kind: 'committed', result, event: event ?? null, eventViews: input.eventViews ?? [] } as const;
    });
  }

  private parsePersistedState(value: unknown, gameId: string, matchId: string, status: string, sequence: number): GameState {
    const parsed = GameStateSchema.safeParse(value);
    if (!parsed.success || parsed.data.gameId !== gameId || parsed.data.matchId !== matchId || parsed.data.status !== status || parsed.data.sequence !== sequence) {
      throw new PersistedGameStateError('INVALID_STATE', `Persisted GameState is invalid or disagrees with Game row ${gameId}.`);
    }
    return parsed.data;
  }

  private assertEventViews(event: GameEvent, views: Array<{ recipientPlayerId: PlayerId; payload: GameEvent }>, players: string[]) {
    const recipients = views.map(({ recipientPlayerId }) => recipientPlayerId);
    if (views.length !== 2 || new Set(recipients).size !== 2 || players.some((player) => !recipients.some((recipient) => recipient === player))) {
      throw new TypeError('Every GameEvent must have exactly one view for each Game player.');
    }
    for (const { payload } of views) {
      const parsed = GameEventSchema.parse(payload);
      if (parsed.gameId !== event.gameId || parsed.eventId !== event.eventId || parsed.sequence !== event.sequence) {
        throw new TypeError('Player Event Views must preserve the canonical Event identity and sequence.');
      }
    }
  }

  private async persistViewState(tx: Parameters<Parameters<Database['transaction']>[0]>[0], gameId: string, change: PersistedViewStateChange) {
    const playerId = PlayerIdSchema.parse(change.playerId);
    if (!change.value) {
      await tx.delete(viewStates).where(and(eq(viewStates.gameId, gameId), eq(viewStates.viewerPlayerId, playerId)));
      return;
    }
    const value = ViewStateSchema.parse(change.value);
    if (value.viewerPlayerId !== playerId) throw new TypeError('ViewState viewer must match its storage key.');
    const stored = { viewState: value, sourceCardIdsSnapshot: change.sourceCardIdsSnapshot ?? null };
    await tx.insert(viewStates).values({ gameId, viewerPlayerId: playerId, viewId: value.viewId, state: stored })
      .onConflictDoUpdate({ target: [viewStates.gameId, viewStates.viewerPlayerId], set: { viewId: value.viewId, state: stored } });
  }
}

function eventStatus(previous: string, next: GameState['status']): GameState['status'] {
  if (previous === next || (previous === 'PLAYING' && (next === 'FINISHED' || next === 'ABANDONED'))) return next;
  throw new TypeError('Game status can only remain unchanged or end from PLAYING.');
}
