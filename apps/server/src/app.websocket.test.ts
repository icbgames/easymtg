import { randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HelloSchema, PlayerIdSchema } from '@easymtg/shared';
import { buildApp } from './app.js';
import { GameSyncRepository } from './db/game-sync-repository.js';
import { GameRepository } from './db/game-repository.js';
import { WebSocketSessionManager } from './websocket-session-manager.js';

const userIds = ['f2a3aa30-9191-4c48-aa76-84df905f3254', '1da8fc01-df9a-4c6e-8d68-6f1823312b0b'];
const playerIds = [PlayerIdSchema.parse('player-one'), PlayerIdSchema.parse('player-two')];
const tokens = ['A'.repeat(43), 'B'.repeat(43)];

describe('WebSocket application transport', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const clients: RawWebSocket[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    await app?.close();
    app = undefined;
  });

  it('authenticates two real socket clients and preserves sync and PlayerConnected ordering', async () => {
    const sync = {
      resolveConnectionContext: async (userId: string) => {
        const index = userIds.indexOf(userId);
        return index < 0 ? null : {
          roomId: 'room-e2e', playerId: playerIds[index]!, participantIds: playerIds,
          matchId: null, gameId: null, gameNumber: null,
        };
      },
      buildMessages: async (_userId: string, _hello: unknown, isConnected: (playerId: typeof playerIds[number]) => 'CONNECTED' | 'DISCONNECTED') => [
        { type: 'Welcome', protocolVersion: 1 },
        { type: 'RoomStateSync', room: {
          roomId: 'room-e2e', status: 'WAITING', ownerPlayerId: playerIds[0],
          participants: playerIds.map((playerId) => ({ playerId, connectionState: isConnected(playerId) })),
        } },
        { type: 'MatchStateSync', match: null },
      ],
    };
    const sessions = {
      createAnonymousUser: async () => { throw new Error('Not needed for this WebSocket test.'); },
      resolveAndTouch: async (token: string) => {
        const index = tokens.indexOf(token);
        return index < 0 ? null : {
          user: { id: userIds[index]!, displayName: `Player ${index + 1}`, createdAt: '2026-10-11T00:00:00.000Z' },
          expiresAt: new Date('2026-11-10T00:00:00.000Z'),
        };
      },
    };
    const manager = new WebSocketSessionManager(sync as unknown as GameSyncRepository, {} as GameRepository);
    app = await buildApp({ sessions, webSockets: manager, secureCookies: false });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an ephemeral TCP listener.');

    const first = await RawWebSocket.connect(address.port, `easymtg_session=${tokens[0]}`);
    clients.push(first);
    first.sendText(JSON.stringify(HelloSchema.parse({ type: 'Hello', protocolVersion: 1, lastGameId: null, lastSequence: null })));
    expect((await first.nextMessage()).type).toBe('Welcome');
    expect((await first.nextMessage()).type).toBe('RoomStateSync');
    expect((await first.nextMessage()).type).toBe('MatchStateSync');
    expect((await first.nextMessage()).type).toBe('PlayerConnected');

    const second = await RawWebSocket.connect(address.port, `easymtg_session=${tokens[1]}`);
    clients.push(second);
    second.sendText(JSON.stringify(HelloSchema.parse({ type: 'Hello', protocolVersion: 1, lastGameId: null, lastSequence: null })));
    expect((await second.nextMessage()).type).toBe('Welcome');
    const roomSync = await second.nextMessage();
    expect(roomSync).toMatchObject({ type: 'RoomStateSync', room: { participants: [
      { playerId: playerIds[0], connectionState: 'CONNECTED' },
      { playerId: playerIds[1], connectionState: 'CONNECTED' },
    ] } });
    expect((await second.nextMessage()).type).toBe('MatchStateSync');
    expect((await second.nextMessage()).type).toBe('PlayerConnected');
    expect((await first.nextMessage()).type).toBe('PlayerConnected');
  });
});

class RawWebSocket {
  private buffer = Buffer.alloc(0);
  private handshakeComplete = false;
  private readonly messages: unknown[] = [];
  private readonly waiters: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  private handshakeResolve!: () => void;
  private handshakeReject!: (error: Error) => void;
  private readonly handshake = new Promise<void>((resolve, reject) => { this.handshakeResolve = resolve; this.handshakeReject = reject; });

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => {
      this.handshakeReject(error);
      this.waiters.splice(0).forEach((waiter) => waiter.reject(error));
    });
    socket.on('close', () => this.waiters.splice(0).forEach((waiter) => waiter.reject(new Error('Socket closed.'))));
  }

  static async connect(port: number, cookie: string) {
    const socket = createConnection({ host: '127.0.0.1', port });
    const client = new RawWebSocket(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const key = randomBytes(16).toString('base64');
    socket.write([
      'GET /ws HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', `Cookie: ${cookie}`, '\r\n',
    ].join('\r\n'));
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([client.handshake, new Promise<void>((_, reject) => { timeout = setTimeout(() => reject(new Error('WebSocket handshake timed out.')), 3000); })]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    return client;
  }

  sendText(value: string) {
    const payload = Buffer.from(value, 'utf8');
    if (payload.length >= 126) throw new Error('Test client only supports short frames.');
    const mask = randomBytes(4);
    const frame = Buffer.alloc(2 + mask.length + payload.length);
    frame[0] = 0x81;
    frame[1] = 0x80 | payload.length;
    mask.copy(frame, 2);
    for (let index = 0; index < payload.length; index += 1) frame[6 + index] = payload[index]! ^ mask[index % 4]!;
    this.socket.write(frame);
  }

  nextMessage() {
    const message = this.messages.shift();
    if (message !== undefined) return Promise.resolve(message as Record<string, unknown>);
    return new Promise<Record<string, unknown>>((resolve, reject) => this.waiters.push({ resolve: (value) => resolve(value as Record<string, unknown>), reject }));
  }

  destroy() { this.socket.destroy(); }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeComplete) {
      const marker = this.buffer.indexOf('\r\n\r\n');
      if (marker < 0) return;
      const header = this.buffer.subarray(0, marker).toString('latin1');
      this.buffer = this.buffer.subarray(marker + 4);
      if (!header.startsWith('HTTP/1.1 101')) { this.handshakeReject(new Error(`Unexpected upgrade response: ${header}`)); return; }
      this.handshakeComplete = true;
      this.handshakeResolve();
    }
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0]! & 0x0f;
      let length = this.buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const large = this.buffer.readBigUInt64BE(2);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unexpected large frame.');
        length = Number(large);
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 1) {
        const message = JSON.parse(payload.toString('utf8')) as unknown;
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(message); else this.messages.push(message);
      } else if (opcode === 8) {
        this.socket.end();
        return;
      }
    }
  }
}
