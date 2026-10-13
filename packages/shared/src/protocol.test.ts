import { describe, expect, it } from 'vitest';
import {
  ClientMessageSchema, CommandErrorCodeSchema, CommandResultSchema, HTTP_STATUS_BY_ERROR_CODE,
  HttpErrorCodeSchema, HttpErrorResponseSchema, LifecycleEventSchema, MatchStateSyncSchema,
  RoomStateSyncSchema, ServerMessageSchema,
} from './protocol.js';

describe('CommandResult error codes', () => {
  it('accepts the fixed command error catalog and rejects unknown codes', () => {
    for (const errorCode of CommandErrorCodeSchema.options) {
      expect(CommandResultSchema.safeParse({ type: 'CommandResult', commandId: 'cmd-1', success: false, errorCode }).success).toBe(true);
    }
    expect(CommandResultSchema.safeParse({ type: 'CommandResult', commandId: 'cmd-1', success: false, errorCode: 'SOME_NEW_CODE' }).success).toBe(false);
  });
});

describe('HTTP error catalog', () => {
  it('has a status mapping and response schema for each fixed HTTP code', () => {
    for (const errorCode of HttpErrorCodeSchema.options) {
      expect(HTTP_STATUS_BY_ERROR_CODE[errorCode]).toBeGreaterThanOrEqual(400);
      expect(HttpErrorResponseSchema.safeParse({ error: { code: errorCode, message: 'Request failed.' } }).success).toBe(true);
    }
    expect(HttpErrorResponseSchema.safeParse({ error: { code: 'UNKNOWN', message: 'Failure' } }).success).toBe(false);
  });
});

describe('WebSocket protocol v1 schemas', () => {
  it('validates Hello sync hints as a nullable pair and rejects extra fields', () => {
    expect(ClientMessageSchema.safeParse({ type: 'Hello', protocolVersion: 1, lastGameId: null, lastSequence: null }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'Hello', protocolVersion: 1, lastGameId: 'game-1', lastSequence: null }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'Hello', protocolVersion: 1, lastGameId: null, lastSequence: null, roomId: 'room-1' }).success).toBe(false);
  });

  it('accepts unknown commands as envelopes for the transport to return UNKNOWN_COMMAND', () => {
    expect(ClientMessageSchema.safeParse({ type: 'FutureCommand', commandId: 'cmd-1', payload: {} }).success).toBe(true);
  });

  it('validates Room and Match sync privacy shapes', () => {
    expect(RoomStateSyncSchema.safeParse({ type: 'RoomStateSync', room: null }).success).toBe(true);
    expect(RoomStateSyncSchema.safeParse({ type: 'RoomStateSync', room: { roomId: 'r', status: 'WAITING', ownerPlayerId: 'p1', participants: [{ playerId: 'p1', connectionState: 'CONNECTED', deckId: 'private' }] } }).success).toBe(false);
    expect(MatchStateSyncSchema.safeParse({ type: 'MatchStateSync', match: null }).success).toBe(true);
  });

  it('validates lifecycle and server messages', () => {
    const event = { eventId: '00000000-0000-4000-8000-000000000001', type: 'PlayerConnected', roomId: 'r', playerId: 'p', connectionState: 'CONNECTED' };
    expect(LifecycleEventSchema.safeParse(event).success).toBe(true);
    expect(ServerMessageSchema.safeParse(event).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: 'Welcome', protocolVersion: 2 }).success).toBe(false);
  });
});
