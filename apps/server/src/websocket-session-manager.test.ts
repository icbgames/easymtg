import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelloSchema, type PlayerId } from '@easymtg/shared';
import { WebSocketSessionManager, type WebSocketLike } from './websocket-session-manager.js';

class FakeSocket extends EventEmitter implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  send(data: string, callback?: (error?: Error) => void) { this.sent.push(data); callback?.(); }
  close(code?: number, reason?: string) { this.closed.push({ code, reason }); this.readyState = 3; this.emit('close'); }
}

const players = ['player-1', 'player-2'] as PlayerId[];
const context = (userId: string) => ({ roomId: 'room-1', playerId: userId === 'user-1' ? players[0]! : players[1]!, participantIds: players, matchId: null, gameId: null, gameNumber: null });
const logger = { error: () => undefined };
const hello = Buffer.from(JSON.stringify(HelloSchema.parse({ type: 'Hello', protocolVersion: 1, lastGameId: null, lastSequence: null })));

describe('WebSocketSessionManager', () => {
  afterEach(() => vi.useRealTimers());
  it('sends the ordered reconnect sync and broadcasts only first Player connection transitions', async () => {
    const sync = {
      resolveConnectionContext: async (userId: string) => context(userId),
      buildMessages: async (_userId: string, _hello: unknown, isConnected: (playerId: PlayerId) => string) => [
        { type: 'Welcome', protocolVersion: 1 },
        { type: 'RoomStateSync', room: { roomId: 'room-1', status: 'WAITING', ownerPlayerId: players[0], participants: players.map((playerId) => ({ playerId, connectionState: isConnected(playerId) })) } },
        { type: 'MatchStateSync', match: null },
      ],
    };
    const gameRepository = { setAllPlayersDisconnectedAt: async () => undefined };
    const manager = new WebSocketSessionManager(sync as never, gameRepository as never);
    const first = new FakeSocket();
    manager.accept('user-1', first, logger);
    first.emit('message', hello, false);
    await flush();
    expect(first.sent.map((message) => JSON.parse(message).type)).toEqual(['Welcome', 'RoomStateSync', 'MatchStateSync', 'PlayerConnected']);
    expect(JSON.parse(first.sent[1]!).room.participants[0].connectionState).toBe('CONNECTED');

    const second = new FakeSocket();
    manager.accept('user-2', second, logger);
    second.emit('message', hello, false);
    await flush();
    expect(second.sent.map((message) => JSON.parse(message).type)).toEqual(['Welcome', 'RoomStateSync', 'MatchStateSync', 'PlayerConnected']);
    expect(second.sent.map((message) => JSON.parse(message).type)).toContain('PlayerConnected');
    expect(first.sent.map((message) => JSON.parse(message).type)).toContain('PlayerConnected');
    const secondSession = new FakeSocket();
    manager.accept('user-2', secondSession, logger);
    secondSession.emit('message', hello, false);
    await flush();
    expect(secondSession.sent.map((message) => JSON.parse(message).type)).toEqual(['Welcome', 'RoomStateSync', 'MatchStateSync']);
    expect(second.sent.filter((message) => JSON.parse(message).type === 'PlayerConnected')).toHaveLength(1);
    first.close(1000, 'test');
    second.close(1000, 'test');
    secondSession.close(1000, 'test');
    await flush();
  });

  it('rejects a non-Hello first message with protocol close 1002', async () => {
    const manager = new WebSocketSessionManager({
      resolveConnectionContext: async () => null,
      buildMessages: async () => [],
    } as never, {} as never);
    const socket = new FakeSocket();
    manager.accept('user-none', socket, logger);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'Pong', nonce: '00000000-0000-4000-8000-000000000000' })), false);
    await flush();
    expect(socket.closed[0]).toEqual({ code: 1002, reason: 'Invalid Hello.' });
  });

  it('attaches an already-open Session after an HTTP Room mutation and synchronizes the committed Room state', async () => {
    let joined = false;
    const sync = {
      resolveConnectionContext: async () => joined ? context('user-1') : null,
      buildMessages: async () => [
        { type: 'Welcome', protocolVersion: 1 },
        { type: 'RoomStateSync', room: joined ? { roomId: 'room-1', status: 'WAITING', ownerPlayerId: players[0], participants: [{ playerId: players[0], connectionState: 'CONNECTED' }] } : null },
        { type: 'MatchStateSync', match: null },
      ],
    };
    const manager = new WebSocketSessionManager(sync as never, {} as never);
    const socket = new FakeSocket();
    manager.accept('user-1', socket, logger);
    socket.emit('message', hello, false);
    await flush();
    expect(socket.sent.map((message) => JSON.parse(message).type)).toEqual(['Welcome', 'RoomStateSync', 'MatchStateSync']);

    joined = true;
    await manager.publishRoomUpdate('room-1', {
      room: {
        id: 'room-1', ownerPlayerId: players[0]!, status: 'WAITING', createdAt: '2026-10-11T00:00:00.000Z',
        participants: [{ playerId: players[0]!, deckId: 'deck-a', connectionState: 'CONNECTED' }],
      }, playerId: players[0]!,
      events: [{ eventId: 'cd598f75-0df4-4c1e-b3e6-875981593880', type: 'RoomPlayerJoined', roomId: 'room-1', playerId: players[0]! }],
    });
    expect(socket.sent.slice(3).map((message) => JSON.parse(message).type)).toEqual(['RoomPlayerJoined', 'PlayerConnected', 'RoomStateSync', 'MatchStateSync']);
    expect(JSON.parse(socket.sent[5]!).room.participants[0].connectionState).toBe('CONNECTED');
    socket.close(1000, 'test');
    await flush();
  });

  it('sends application Ping every 30 seconds, accepts matching Pong, and closes after 60 seconds unanswered', async () => {
    vi.useFakeTimers();
    const manager = new WebSocketSessionManager({ resolveConnectionContext: async () => null, buildMessages: async () => [] } as never, {} as never);
    const socket = new FakeSocket();
    manager.accept('user-heartbeat', socket, logger);
    socket.emit('message', hello, false);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    const firstPing = JSON.parse(socket.sent[0]!) as { type: string; nonce: string };
    expect(firstPing.type).toBe('Ping');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'Pong', nonce: firstPing.nonce })), false);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    const secondPing = JSON.parse(socket.sent[1]!) as { type: string; nonce: string };
    expect(secondPing.type).toBe('Ping');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.closed.at(-1)).toEqual({ code: 1001, reason: 'Heartbeat timeout.' });
  });
});

async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); }
