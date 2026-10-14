import { randomUUID } from 'node:crypto';
import {
  CommandEnvelopeSchema, CommandResultSchema, HelloSchema, LifecycleEventSchema, PongSchema,
  ServerMessageSchema, type PlayerId, type ServerMessage,
} from '@easymtg/shared';
import type { RoomLifecycleResult } from './room-lifecycle-api.js';
import { createGameCommandProcessor, type GameCommandProcessor } from '@easymtg/game';
import type { GameRepository } from './db/game-repository.js';
import type { GameSyncRepository } from './db/game-sync-repository.js';
import { PostgresGameCommandPersistence } from './db/game-command-persistence.js';

export interface WebSocketLike {
  readyState: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', callback: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): this;
  on(event: 'close' | 'error', callback: () => void): this;
}
export interface ConnectionLogger { error(fields: Record<string, unknown>, message: string): void }

type Session = {
  id: string; userId: string; socket: WebSocketLike; logger: ConnectionLogger;
  helloReceived: boolean;
  playerId: PlayerId | null; roomId: string | null; participants: PlayerId[];
  receiveTail: Promise<void>; sendTail: Promise<void>; pendingNonce: string | null;
  pendingPingAt: number; helloTimer: NodeJS.Timeout; heartbeat: NodeJS.Timeout; closed: boolean;
};

/** Single-process WebSocket ownership, per-session FIFO, per-room serialization and game command delivery. */
export class WebSocketSessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly byPlayer = new Map<PlayerId, Set<string>>();
  private readonly processors = new Map<string, GameCommandProcessor>();
  private readonly roomTails = new Map<string, Promise<void>>();

  constructor(private readonly sync: GameSyncRepository, private readonly games: GameRepository) {}

  releaseAbandonedGame(gameId: string) {
    this.processors.get(gameId)?.releaseGame(gameId);
    this.processors.delete(gameId);
  }

  getConnectionState(playerId: PlayerId) { return this.isPlayerConnected(playerId) ? 'CONNECTED' as const : 'DISCONNECTED' as const; }

  /** Refreshes already-open sockets after an HTTP lifecycle mutation. */
  async publishRoomUpdate(roomId: string, update: RoomLifecycleResult) {
    await this.withRoom(roomId, async () => {
      const newlyConnected: PlayerId[] = [];
      const detached: Session[] = [];
      for (const session of this.sessions.values()) {
        const context = await this.sync.resolveConnectionContext(session.userId);
        if (session.closed || !session.helloReceived) continue;
        if (!context && session.roomId === roomId) {
          if (session.playerId) {
            const previousSessions = this.byPlayer.get(session.playerId);
            previousSessions?.delete(session.id);
            if (!previousSessions?.size) this.byPlayer.delete(session.playerId);
          }
          session.playerId = null;
          session.roomId = null;
          session.participants = [];
          detached.push(session);
          continue;
        }
        if (!context || context.roomId !== roomId) continue;
        if (session.playerId && session.playerId !== context.playerId) this.byPlayer.get(session.playerId)?.delete(session.id);
        const wasConnected = this.isPlayerConnected(context.playerId);
        session.playerId = context.playerId;
        session.roomId = context.roomId;
        session.participants = context.participantIds;
        const playerSessions = this.byPlayer.get(context.playerId) ?? new Set<string>();
        playerSessions.add(session.id);
        this.byPlayer.set(context.playerId, playerSessions);
        if (!wasConnected) newlyConnected.push(context.playerId);
      }
      const playerIds = update.room?.participants.map(({ playerId }) => playerId) ?? [];
      const lifecycle: Array<RoomLifecycleResult['events'][number] | { eventId: string; type: 'PlayerConnected'; roomId: string; playerId: PlayerId; connectionState: 'CONNECTED' }> = [...update.events];
      for (const playerId of newlyConnected) lifecycle.push({
        eventId: randomUUID(), type: 'PlayerConnected', roomId, playerId, connectionState: 'CONNECTED',
      });
      for (const playerId of playerIds) {
        const sessions = [...(this.byPlayer.get(playerId) ?? [])].map((id) => this.sessions.get(id)).filter((session): session is Session => Boolean(session));
        for (const session of sessions) {
          const messages = await this.sync.buildMessages(session.userId, { type: 'Hello', protocolVersion: 1, lastGameId: null, lastSequence: null }, (id) => this.isPlayerConnected(id) ? 'CONNECTED' : 'DISCONNECTED');
          const recipientEvents = lifecycle.filter((event) => event.type !== 'RoomPlayerLeft' || event.playerId !== playerId);
          await this.enqueueBatch(session, [...recipientEvents, ...messages.slice(1)]);
        }
      }
      for (const session of detached) {
        const messages = await this.sync.buildMessages(session.userId, { type: 'Hello', protocolVersion: 1, lastGameId: null, lastSequence: null });
        await this.enqueueBatch(session, messages.slice(1));
      }
    });
  }

  accept(userId: string, socket: WebSocketLike, logger: ConnectionLogger) {
    const session: Session = {
      id: randomUUID(), userId, socket, logger, helloReceived: false, playerId: null, roomId: null, participants: [],
      receiveTail: Promise.resolve(), sendTail: Promise.resolve(), pendingNonce: null, pendingPingAt: 0, closed: false,
      helloTimer: setTimeout(() => socket.close(1002, 'Hello timeout.'), 10_000),
      heartbeat: setInterval(() => this.heartbeat(session), 30_000),
    };
    session.helloTimer.unref();
    session.heartbeat.unref();
    this.sessions.set(session.id, session);
    socket.on('message', (data, isBinary) => {
      session.receiveTail = session.receiveTail.then(() => this.receive(session, data, isBinary)).catch((error: unknown) => {
        logger.error({ err: error }, 'WebSocket message processing failed.');
        socket.close(1011, 'Message processing failed.');
      });
    });
    socket.on('close', () => { void this.disconnect(session).catch((error: unknown) => logger.error({ err: error }, 'WebSocket disconnect cleanup failed.')); });
    socket.on('error', () => { void this.disconnect(session).catch((error: unknown) => logger.error({ err: error }, 'WebSocket disconnect cleanup failed.')); });
  }

  private async receive(session: Session, data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) {
    if (session.closed) return;
    if (isBinary) { session.socket.close(1002, 'Text messages only.'); return; }
    let value: unknown;
    try { value = JSON.parse(toText(data)); }
    catch { session.socket.close(1002, 'Invalid JSON.'); return; }

    if (!session.helloReceived) {
      const hello = HelloSchema.safeParse(value);
      if (!hello.success) { session.socket.close(1002, 'Invalid Hello.'); return; }
      session.helloReceived = true;
      clearTimeout(session.helloTimer);
      await this.connect(session, hello.data);
      return;
    }

    const pong = PongSchema.safeParse(value);
    if (pong.success) {
      if (pong.data.nonce === session.pendingNonce) { session.pendingNonce = null; session.pendingPingAt = 0; }
      return;
    }
    const context = await this.sync.resolveConnectionContext(session.userId);
    if (!context || context.playerId !== session.playerId || !context.gameId) {
      const commandId = readCommandId(value);
      if (!commandId) { session.socket.close(1002, 'Invalid command envelope.'); return; }
      await this.enqueue(session, CommandResultSchema.parse({ type: 'CommandResult', commandId, success: false, errorCode: 'GAME_NOT_FOUND' }));
      return;
    }
    await this.withRoom(context.roomId, async () => {
      const current = await this.sync.resolveConnectionContext(session.userId);
      if (!current || current.playerId !== session.playerId || !current.gameId || current.roomId !== context.roomId) {
        const commandId = readCommandId(value);
        if (!commandId) { session.socket.close(1002, 'Invalid command envelope.'); return; }
        await this.enqueue(session, CommandResultSchema.parse({ type: 'CommandResult', commandId, success: false, errorCode: 'GAME_NOT_PLAYING' }));
        return;
      }
      await this.processCommand(session, current.roomId, current.participantIds, current.matchId, current.gameNumber, current.gameId, value);
    });
  }

  private async connect(session: Session, hello: ReturnType<typeof HelloSchema.parse>) {
    const context = await this.sync.resolveConnectionContext(session.userId);
    if (context) {
      session.playerId = context.playerId;
      session.roomId = context.roomId;
      session.participants = context.participantIds;
      await this.withRoom(context.roomId, async () => {
        const isFirst = !this.byPlayer.has(context.playerId) || this.byPlayer.get(context.playerId)!.size === 0;
        const sessions = this.byPlayer.get(context.playerId) ?? new Set<string>();
        sessions.add(session.id);
        this.byPlayer.set(context.playerId, sessions);
        if (context.gameId) {
          const processor = await this.getProcessor(context.gameId);
          for (const playerId of context.participantIds) processor.setPlayerConnected(context.gameId!, playerId, this.isPlayerConnected(playerId));
          await this.games.setAllPlayersDisconnectedAt(context.gameId, null);
        }
        const syncMessages = await this.sync.buildMessages(session.userId, hello, (playerId) => this.isPlayerConnected(playerId) ? 'CONNECTED' : 'DISCONNECTED');
        await this.enqueueBatch(session, syncMessages);
        if (isFirst) this.broadcast(context.participantIds, LifecycleEventSchema.parse({
          eventId: randomUUID(), type: 'PlayerConnected', roomId: context.roomId,
          playerId: context.playerId, connectionState: 'CONNECTED',
        }));
      });
    } else {
      await this.enqueueBatch(session, await this.sync.buildMessages(session.userId, hello));
    }
  }

  private async processCommand(session: Session, roomId: string, participantIds: PlayerId[], matchId: string | null, gameNumber: number | null, gameId: string, value: unknown) {
    const processor = await this.getProcessor(gameId);
    for (const playerId of participantIds) processor.setPlayerConnected(gameId, playerId, this.isPlayerConnected(playerId));
    const command = CommandEnvelopeSchema.safeParse(value);
    const commandId = readCommandId(value);
    if (!commandId) { session.socket.close(1002, 'Invalid command envelope.'); return; }
    const response = await processor.process(gameId, session.playerId!, command.success ? command.data : value);
    await this.enqueue(session, response.result);
    if (response.event) {
      const state = processor.getState(gameId);
      if (state) {
        for (const playerId of participantIds) {
          const eventView = response.eventViews?.find((view) => view.recipientPlayerId === playerId)?.payload;
          if (!eventView) throw new Error(`Committed Event View is missing for recipient ${playerId}.`);
          this.broadcast([playerId], eventView);
        }
        if (state.status === 'FINISHED' || state.status === 'ABANDONED') {
          if (matchId && gameNumber) {
            const ended = LifecycleEventSchema.parse({
              eventId: randomUUID(), type: 'GameEnded', roomId, matchId,
              gameId, gameNumber, gameStatus: state.status,
            });
            this.broadcast(participantIds, ended);
            if (gameNumber === 5) this.broadcast(participantIds, LifecycleEventSchema.parse({
              eventId: randomUUID(), type: 'MatchEnded', roomId, matchId, gameNumber: 5,
            }));
          }
          processor.releaseGame(gameId);
          this.processors.delete(gameId);
        }
      }
    }
    for (const notification of response.notifications) {
      this.broadcast([notification.recipientPlayerId], { type: notification.type, payload: notification.payload });
    }
  }

  private async getProcessor(gameId: string) {
    const existing = this.processors.get(gameId);
    if (existing) return existing;
    const loaded = await this.games.loadGameRuntime(gameId);
    const processor = createGameCommandProcessor();
    processor.registerGame(loaded.state);
    processor.setPersistenceAdapter(new PostgresGameCommandPersistence(this.games));
    for (const view of loaded.viewStates) processor.restoreViewState(gameId, view.playerId, view.value, view.sourceCardIdsSnapshot);
    this.processors.set(gameId, processor);
    return processor;
  }

  private async disconnect(session: Session) {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.helloTimer);
    clearInterval(session.heartbeat);
    this.sessions.delete(session.id);
    if (!session.playerId || !session.roomId) return;
    await this.withRoom(session.roomId, async () => {
      const sessions = this.byPlayer.get(session.playerId!);
      sessions?.delete(session.id);
      const isLast = !sessions || sessions.size === 0;
      if (isLast) this.byPlayer.delete(session.playerId!);
      const remaining = await this.sync.resolveConnectionContext(session.userId);
      const gameId = remaining?.gameId;
      if (gameId) {
        const processor = this.processors.get(gameId);
        for (const playerId of session.participants) processor?.setPlayerConnected(gameId, playerId, this.isPlayerConnected(playerId));
        const allDisconnected = session.participants.every((playerId) => !this.isPlayerConnected(playerId));
        await this.games.setAllPlayersDisconnectedAt(gameId, allDisconnected ? new Date() : null);
      }
      if (isLast) this.broadcast(session.participants, LifecycleEventSchema.parse({
        eventId: randomUUID(), type: 'PlayerDisconnected', roomId: session.roomId,
        playerId: session.playerId, connectionState: 'DISCONNECTED',
      }));
    });
  }

  private heartbeat(session: Session) {
    if (session.closed || session.socket.readyState !== 1) return;
    if (session.pendingNonce) {
      if (Date.now() - session.pendingPingAt >= 60_000) session.socket.close(1001, 'Heartbeat timeout.');
      return;
    }
    session.pendingNonce = randomUUID();
    session.pendingPingAt = Date.now();
    void this.enqueue(session, { type: 'Ping', nonce: session.pendingNonce });
  }

  private broadcast(players: PlayerId[], message: ServerMessage | { type: string; payload: unknown }, exceptSessionId?: string) {
    const parsed = ServerMessageSchema.parse(message);
    for (const playerId of players) {
      for (const sessionId of this.byPlayer.get(playerId) ?? []) {
        if (sessionId === exceptSessionId) continue;
        const session = this.sessions.get(sessionId);
        if (session) void this.enqueue(session, parsed);
      }
    }
  }

  private enqueue(session: Session, message: ServerMessage | unknown): Promise<void> {
    return this.enqueueBatch(session, [message]);
  }

  private enqueueBatch(session: Session, messages: Array<ServerMessage | unknown>): Promise<void> {
    for (const message of messages) {
      const data = JSON.stringify(ServerMessageSchema.parse(message));
      const send = session.sendTail.then(() => new Promise<void>((resolve, reject) => {
        if (session.closed || session.socket.readyState !== 1) { resolve(); return; }
        session.socket.send(data, (error) => error ? reject(error) : resolve());
      }));
      session.sendTail = send.catch((error: unknown) => {
        session.logger.error({ err: error }, 'WebSocket send failed.');
        session.socket.close(1011, 'Send failed.');
      });
    }
    
    return session.sendTail;
  }

  private isPlayerConnected(playerId: PlayerId) { return (this.byPlayer.get(playerId)?.size ?? 0) > 0; }

  private async withRoom<T>(roomId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.roomTails.get(roomId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => gate);
    this.roomTails.set(roomId, tail);
    await prior;
    try { return await work(); }
    finally { release(); if (this.roomTails.get(roomId) === tail) this.roomTails.delete(roomId); }
  }
}

function toText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function readCommandId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('commandId' in value) || typeof value.commandId !== 'string' || !value.commandId.trim()) return null;
  return value.commandId;
}
