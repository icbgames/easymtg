import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CommandEnvelopeSchema, CommandIdSchema, CommandResultSchema, GameEventSchema, type CommandEnvelope, type CommandErrorCode, type CommandResult, type GameEvent, type GameCardId, type PlayerId } from '@easymtg/shared';
import { GameOperationError } from './operations.js';
import { GameStateSchema, ViewStateSchema, type GameState, type ViewState } from './model.js';
import { createViewStateSyncNotification } from './view-state.js';

export type ViewNotification = { recipientPlayerId: PlayerId; type: string; payload: unknown };
export type ViewStateChange = { playerId: PlayerId; value: ViewState | null; sourceCardIdsSnapshot?: GameCardId[] | null; notifications: ViewNotification[] };
export type CommandApplication = { state: GameState; eventType: string; payload: unknown; viewStateChange?: ViewStateChange };
export type CommandHandler = {
  payloadSchema: { safeParse(value: unknown): { success: true; data: unknown } | { success: false } };
  execute(state: GameState, actorPlayerId: PlayerId, payload: unknown, viewState?: ViewState, sourceCardIdsSnapshot?: GameCardId[]): CommandApplication;
};
export type CommandProcessorViewState = { registerHandler(type: string, handler: CommandHandler): void };
export type CommandProcessingResponse = { result: CommandResult; event: GameEvent | null; eventViews?: Array<{ recipientPlayerId: PlayerId; payload: GameEvent }>; notifications: ViewNotification[]; duplicate: boolean };
export type PersistedCommandInput = {
  gameId: string;
  actorPlayerId: PlayerId;
  commandId: string;
  command: unknown;
  expectedSequence: number;
  result: CommandResult;
  state?: GameState;
  event?: GameEvent;
  viewStateChange?: ViewStateChange;
};
export type PersistedCommandOutcome = { kind: 'committed'; result: CommandResult; eventViews?: Array<{ recipientPlayerId: PlayerId; payload: GameEvent }> } | { kind: 'duplicate'; result: CommandResult } | { kind: 'conflict' };
export type CommandPersistenceAdapter = { persist(input: PersistedCommandInput): Promise<PersistedCommandOutcome> };

type CommandIdentity = { gameId: string; actorPlayerId: PlayerId; command: CommandEnvelope };
type CommandRecord = { identity: CommandIdentity; response: CommandProcessingResponse };
type InFlightCommand = { identity: CommandIdentity; promise: Promise<CommandProcessingResponse> };

export class InvalidCommandEnvelopeError extends Error {
  readonly code = 'INVALID_ENVELOPE' as const;
  constructor() { super('Command envelope is invalid and has no usable commandId.'); this.name = 'InvalidCommandEnvelopeError'; }
}

/** In-memory Phase 4 processor; persistence and network delivery are supplied by later layers. */
export class GameCommandProcessor {
  private readonly states = new Map<string, GameState>();
  private readonly eventHistory = new Map<string, GameEvent[]>();
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly records = new Map<string, CommandRecord>();
  private readonly inFlight = new Map<string, InFlightCommand>();
  private readonly gameQueues = new Map<string, Promise<void>>();
  private readonly connectedPlayers = new Map<string, Set<PlayerId>>();
  private readonly viewStates = new Map<string, Map<PlayerId, ViewState>>();
  private readonly viewSourceSnapshots = new Map<string, Map<PlayerId, GameCardId[]>>();
  private persistence: CommandPersistenceAdapter | undefined;

  setPersistenceAdapter(adapter: CommandPersistenceAdapter) {
    this.persistence = adapter;
  }

  registerHandler(type: string, handler: CommandHandler) {
    if (!type.trim()) throw new Error('Command type must not be empty.');
    if (this.handlers.has(type)) throw new Error(`Command handler already registered: ${type}`);
    this.handlers.set(type, handler);
  }

  registerGame(state: GameState) {
    const canonical = GameStateSchema.parse(state);
    if (this.states.has(canonical.gameId)) throw new Error(`Game already registered: ${canonical.gameId}`);
    this.states.set(canonical.gameId, structuredClone(canonical));
    this.eventHistory.set(canonical.gameId, []);
    this.connectedPlayers.set(canonical.gameId, new Set());
    this.viewStates.set(canonical.gameId, new Map());
    this.viewSourceSnapshots.set(canonical.gameId, new Map());
  }

  /** Restores persisted private ViewState after process restart, before accepting commands. */
  restoreViewState(gameId: string, playerId: PlayerId, value: ViewState, sourceCardIdsSnapshot: GameCardId[] | null) {
    const state = this.states.get(gameId);
    const view = ViewStateSchema.parse(value);
    if (!state || !state.players.some((player) => player.playerId === playerId) || view.viewerPlayerId !== playerId) {
      throw new Error('Persisted ViewState does not belong to a registered Game player.');
    }
    this.viewStates.get(gameId)!.set(playerId, structuredClone(view));
    if (sourceCardIdsSnapshot) this.viewSourceSnapshots.get(gameId)!.set(playerId, [...sourceCardIdsSnapshot]);
  }

  /** Connection adapters report the aggregate player connection state here. */
  setPlayerConnected(gameId: string, playerId: PlayerId, connected: boolean) {
    const state = this.states.get(gameId);
    if (!state || !state.players.some((player) => player.playerId === playerId)) return false;
    const connectedPlayers = this.connectedPlayers.get(gameId)!;
    if (connected) connectedPlayers.add(playerId);
    else connectedPlayers.delete(playerId);
    return true;
  }

  getState(gameId: string): GameState | undefined {
    const state = this.states.get(gameId);
    return state ? structuredClone(state) : undefined;
  }

  /** Server lifecycle transition for the reconnect-timeout path (not a player command). */
  markAbandoned(gameId: string): GameState | undefined {
    const state = this.states.get(gameId);
    if (!state || state.status !== 'PLAYING') return undefined;
    const abandoned = GameStateSchema.parse({ ...state, status: 'ABANDONED' });
    this.states.set(gameId, abandoned);
    this.viewStates.get(gameId)?.clear();
    this.viewSourceSnapshots.get(gameId)?.clear();
    return structuredClone(abandoned);
  }

  getEvents(gameId: string): GameEvent[] {
    return structuredClone(this.eventHistory.get(gameId) ?? []);
  }

  getViewState(gameId: string, playerId: PlayerId): ViewState | undefined {
    const viewState = this.viewStates.get(gameId)?.get(playerId);
    return viewState ? structuredClone(viewState) : undefined;
  }

  getViewSourceSnapshot(gameId: string, playerId: PlayerId): GameCardId[] | undefined {
    const snapshot = this.viewSourceSnapshots.get(gameId)?.get(playerId);
    return snapshot ? [...snapshot] : undefined;
  }

  getViewStateSyncMessages(gameId: string, recipientPlayerId: PlayerId): ViewNotification[] {
    const state = this.states.get(gameId);
    if (!state || !state.players.some(({ playerId }) => playerId === recipientPlayerId)) return [];
    return [...(this.viewStates.get(gameId)?.values() ?? [])]
      .map((view) => createViewStateSyncNotification(state, view, recipientPlayerId));
  }

  getGameEndNotifications(gameId: string): ViewNotification[] {
    const state = this.states.get(gameId);
    if (!state) return [];
    return [...(this.viewStates.get(gameId)?.values() ?? [])].flatMap((viewState) =>
      state.players.map((player) => ({
        recipientPlayerId: player.playerId,
        type: 'ViewStateEnded',
        payload: { viewId: viewState.viewId, viewerPlayerId: viewState.viewerPlayerId, reason: 'GAME_ENDED' },
      })),
    );
  }

  async process(gameId: string, actorPlayerId: PlayerId, input: unknown): Promise<CommandProcessingResponse> {
    const parsedCommand = CommandEnvelopeSchema.safeParse(input);
    if (!parsedCommand.success) {
      const rawCommandId = typeof input === 'object' && input !== null && 'commandId' in input
        ? input.commandId
        : undefined;
      const parsedCommandId = CommandIdSchema.safeParse(rawCommandId);
      if (!parsedCommandId.success) throw new InvalidCommandEnvelopeError();
      const current = this.states.get(gameId);
      if (!current) return this.failure(parsedCommandId.data, 'INVALID_ENVELOPE');
      return this.withGameQueue(gameId, () => this.persistFailure(gameId, actorPlayerId, parsedCommandId.data, input, current, 'INVALID_ENVELOPE'));
    }
    const command = parsedCommand.data;
    const identity: CommandIdentity = { gameId, actorPlayerId, command };
    const prior = this.records.get(command.commandId);
    if (prior) {
      if (!isDeepStrictEqual(prior.identity, identity)) return this.failure(command.commandId, 'COMMAND_ID_CONFLICT');
      return { result: structuredClone(prior.response.result), event: null, notifications: [], duplicate: true };
    }
    const pending = this.inFlight.get(command.commandId);
    if (pending) {
      if (!isDeepStrictEqual(pending.identity, identity)) return this.failure(command.commandId, 'COMMAND_ID_CONFLICT');
      const response = await pending.promise;
      return { result: structuredClone(response.result), event: null, notifications: [], duplicate: true };
    }

    const work = this.withGameQueue(gameId, () => this.processOne(gameId, actorPlayerId, command, input));
    this.inFlight.set(command.commandId, { identity, promise: work });
    try {
      const response = await work;
      this.records.set(command.commandId, { identity, response: { ...response, event: null } });
      return response;
    } finally {
      this.inFlight.delete(command.commandId);
    }
  }

  /** Called after the owning Game is eligible for cleanup. */
  releaseGame(gameId: string) {
    this.states.delete(gameId);
    this.eventHistory.delete(gameId);
    this.connectedPlayers.delete(gameId);
    this.viewStates.delete(gameId);
    this.viewSourceSnapshots.delete(gameId);
    for (const [commandId, record] of this.records) {
      if (record.identity.gameId === gameId) this.records.delete(commandId);
    }
  }

  private async withGameQueue<T>(gameId: string, work: () => T | Promise<T>): Promise<T> {
    const previous = this.gameQueues.get(gameId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.gameQueues.set(gameId, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.gameQueues.get(gameId) === tail) this.gameQueues.delete(gameId);
    }
  }

  private async processOne(gameId: string, actorPlayerId: PlayerId, command: CommandEnvelope, originalInput: unknown): Promise<CommandProcessingResponse> {
    const current = this.states.get(gameId);
    if (!current) return this.failure(command.commandId, 'GAME_NOT_FOUND');
    const connected = this.connectedPlayers.get(gameId);
    if (!connected || current.players.some(({ playerId }) => !connected.has(playerId))) {
      return this.persistFailure(gameId, actorPlayerId, command.commandId, originalInput, current, 'PLAYERS_NOT_CONNECTED');
    }
    const handler = this.handlers.get(command.type);
    if (!handler) return this.persistFailure(gameId, actorPlayerId, command.commandId, originalInput, current, 'UNKNOWN_COMMAND');
    const parsedPayload = handler.payloadSchema.safeParse(command.payload);
    if (!parsedPayload.success) return this.persistFailure(gameId, actorPlayerId, command.commandId, originalInput, current, 'INVALID_PAYLOAD');

    let application: CommandApplication;
    try {
      application = handler.execute(
        structuredClone(current), actorPlayerId, parsedPayload.data,
        this.getViewState(gameId, actorPlayerId), this.getViewSourceSnapshot(gameId, actorPlayerId),
      );
    } catch (error) {
      if (error instanceof GameOperationError) return this.persistFailure(gameId, actorPlayerId, command.commandId, originalInput, current, error.code);
      return this.persistFailure(gameId, actorPlayerId, command.commandId, originalInput, current, 'INTERNAL_ERROR');
    }

    let candidate: GameState;
    try {
      candidate = GameStateSchema.parse(application.state);
    } catch {
      return this.persistFailure(gameId, actorPlayerId, command.commandId, originalInput, current, 'INVALID_STATE_TRANSITION');
    }
    if (candidate.gameId !== current.gameId || candidate.sequence !== current.sequence) {
      return this.persistFailure(gameId, actorPlayerId, command.commandId, originalInput, current, 'INVALID_STATE_TRANSITION');
    }
    const stateChanged = !isDeepStrictEqual(current, candidate);
    if (!stateChanged && !application.viewStateChange) {
      const response = { result: CommandResultSchema.parse({ type: 'CommandResult', commandId: command.commandId, success: true }), event: null, notifications: [], duplicate: false };
      return this.persistSuccess(gameId, actorPlayerId, command.commandId, originalInput, current, response);
    }

    let persistenceStarted = false;
    try {
      let event: GameEvent | null = null;
      let nextState = current;
      if (stateChanged) {
        const nextSequence = current.sequence + 1;
        nextState = GameStateSchema.parse({ ...candidate, sequence: nextSequence });
        event = GameEventSchema.parse({
          type: 'GameEvent', eventId: randomUUID(), gameId: current.gameId,
          sequence: nextSequence, eventType: application.eventType, payload: application.payload,
        });
      }
      const result = CommandResultSchema.parse({ type: 'CommandResult', commandId: command.commandId, success: true });
      persistenceStarted = true;
      const persistence = await this.persist({
        gameId, actorPlayerId, commandId: command.commandId, command: originalInput,
        expectedSequence: current.sequence, result,
        ...(stateChanged ? { state: nextState, event: event! } : {}),
        ...(application.viewStateChange ? { viewStateChange: application.viewStateChange } : {}),
      });
      if (persistence.kind === 'conflict') return this.failure(command.commandId, 'COMMAND_ID_CONFLICT');
      if (persistence.kind === 'duplicate') return { result: persistence.result, event: null, notifications: [], duplicate: true };
      if (stateChanged) {
        this.states.set(gameId, nextState);
        this.eventHistory.get(gameId)!.push(event!);
      }
      const notifications = [...(application.viewStateChange?.notifications ?? [])];
      if (application.viewStateChange) {
        const playerViews = this.viewStates.get(gameId)!;
        if (application.viewStateChange.value) playerViews.set(application.viewStateChange.playerId, structuredClone(application.viewStateChange.value));
        else playerViews.delete(application.viewStateChange.playerId);
        const snapshots = this.viewSourceSnapshots.get(gameId)!;
        if (application.viewStateChange.sourceCardIdsSnapshot !== undefined) {
          if (application.viewStateChange.sourceCardIdsSnapshot) snapshots.set(application.viewStateChange.playerId, [...application.viewStateChange.sourceCardIdsSnapshot]);
          else snapshots.delete(application.viewStateChange.playerId);
        }
      }
      if (stateChanged && (nextState.status === 'FINISHED' || nextState.status === 'ABANDONED')) {
        notifications.push(...this.getGameEndNotifications(gameId));
        const playerViews = this.viewStates.get(gameId)!;
        playerViews.clear();
        this.viewSourceSnapshots.get(gameId)!.clear();
      }
      return {
        result, event, notifications, duplicate: false,
        ...(event && persistence.eventViews ? { eventViews: persistence.eventViews } : {}),
      };
    } catch (error) {
      // A database failure is not an operation result: do not create an idempotency
      // receipt for an uncommitted command, and let the caller retry it.
      if (persistenceStarted) throw error;
      return this.persistFailure(gameId, actorPlayerId, command.commandId, originalInput, current, 'INTERNAL_ERROR');
    }
  }

  private async persistSuccess(gameId: string, actorPlayerId: PlayerId, commandId: string, command: unknown, state: GameState, response: CommandProcessingResponse) {
    const outcome = await this.persist({ gameId, actorPlayerId, commandId, command, expectedSequence: state.sequence, result: response.result });
    if (outcome.kind === 'conflict') return this.failure(commandId, 'COMMAND_ID_CONFLICT');
    if (outcome.kind === 'duplicate') return { result: outcome.result, event: null, notifications: [], duplicate: true };
    return response;
  }

  private async persistFailure(gameId: string, actorPlayerId: PlayerId, commandId: string, command: unknown, state: GameState, code: CommandErrorCode) {
    const response = this.failure(commandId, code);
    const outcome = await this.persist({ gameId, actorPlayerId, commandId, command, expectedSequence: state.sequence, result: response.result });
    if (outcome.kind === 'conflict') return this.failure(commandId, 'COMMAND_ID_CONFLICT');
    if (outcome.kind === 'duplicate') return { result: outcome.result, event: null, notifications: [], duplicate: true };
    return response;
  }

  private async persist(input: PersistedCommandInput): Promise<PersistedCommandOutcome> {
    return this.persistence?.persist(input) ?? { kind: 'committed', result: input.result };
  }

  private failure(commandId: string, errorCode: CommandErrorCode): CommandProcessingResponse {
    return { result: CommandResultSchema.parse({ type: 'CommandResult', commandId, success: false, errorCode }), event: null, notifications: [], duplicate: false };
  }
}
