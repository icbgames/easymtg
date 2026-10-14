import { describe, expect, it } from 'vitest';
import { CardDefinitionIdSchema, DeckEntrySchema, PlayerIdSchema, z } from '@easymtg/shared';
import { GameCommandProcessor, InvalidCommandEnvelopeError, changeLife, createGameCommandProcessor, createInitialGameState } from './index.js';

const definitionId = CardDefinitionIdSchema.parse('ABC001');
const entry = DeckEntrySchema.parse({ cardDefinitionId: definitionId, quantity: 60 });
let idCounter = 0;
function makeState() {
  return createInitialGameState({
    gameId: 'game-1', matchId: 'match-1', playerIds: ['player-1', 'player-2'], hostPlayerId: 'player-1',
    decks: [
      { playerId: 'player-1', mainboard: [entry], sideboard: [] },
      { playerId: 'player-2', mainboard: [entry], sideboard: [] },
    ],
    definitions: { [definitionId]: { version: 1, status: 'ENABLED' } },
    createId: () => `command-test-${idCounter++}`,
    randomIndex: () => 0,
  });
}
const zoneFor = (state: ReturnType<typeof makeState>, type: string, ownerPlayerId: string | null) =>
  state.zones.find((zone) => zone.type === type && zone.ownerPlayerId === ownerPlayerId)!;

function processor() {
  const instance = new GameCommandProcessor();
  instance.registerGame(makeState());
  instance.setPlayerConnected('game-1', PlayerIdSchema.parse('player-1'), true);
  instance.setPlayerConnected('game-1', PlayerIdSchema.parse('player-2'), true);
  instance.registerHandler('ChangeLife', {
    payloadSchema: z.object({ amount: z.number().int() }),
    execute: (state, playerId, payload) => ({
      state: changeLife(state, playerId, payload.amount),
      eventType: 'LifeChanged',
      payload: { playerId, amount: payload.amount },
    }),
  });
  return instance;
}

describe('GameCommandProcessor', () => {
  it('commits a state transition with one event and increments sequence once', async () => {
    const instance = processor();
    const response = await instance.process('game-1', PlayerIdSchema.parse('player-1'), {
      type: 'ChangeLife', commandId: 'command-1', payload: { amount: 3 },
    });

    expect(response.result.success).toBe(true);
    expect(response.event?.sequence).toBe(1);
    expect(instance.getState('game-1')?.players[0]?.life).toBe(23);
    expect(instance.getEvents('game-1')).toHaveLength(1);
  });

  it('does not convert persistence failures into command receipts or mutate memory state', async () => {
    const instance = processor();
    instance.setPersistenceAdapter({ persist: async () => { throw new Error('database unavailable'); } });
    await expect(instance.process('game-1', PlayerIdSchema.parse('player-1'), {
      type: 'ChangeLife', commandId: 'retry-after-db-error', payload: { amount: 3 },
    })).rejects.toThrow('database unavailable');
    expect(instance.getState('game-1')?.sequence).toBe(0);
    expect(instance.getEvents('game-1')).toHaveLength(0);
  });

  it('returns the prior result for a duplicate command without replaying its event', async () => {
    const instance = processor();
    const actor = PlayerIdSchema.parse('player-1');
    const command = { type: 'ChangeLife', commandId: 'command-1', payload: { amount: 3 } };
    const first = await instance.process('game-1', actor, command);
    const duplicate = await instance.process('game-1', actor, command);

    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.result).toEqual(first.result);
    expect(duplicate.event).toBeNull();
    expect(instance.getState('game-1')?.players[0]?.life).toBe(23);
    expect(instance.getEvents('game-1')).toHaveLength(1);
  });

  it('rejects reuse of a commandId with a different actor or command payload', async () => {
    const instance = processor();
    const first = await instance.process('game-1', PlayerIdSchema.parse('player-1'), {
      type: 'ChangeLife', commandId: 'reused-id', payload: { amount: 3 },
    });
    const differentPayload = await instance.process('game-1', PlayerIdSchema.parse('player-1'), {
      type: 'ChangeLife', commandId: 'reused-id', payload: { amount: 5 },
    });
    const differentActor = await instance.process('game-1', PlayerIdSchema.parse('player-2'), {
      type: 'ChangeLife', commandId: 'reused-id', payload: { amount: 3 },
    });

    expect(first.result.success).toBe(true);
    expect(differentPayload.result.errorCode).toBe('COMMAND_ID_CONFLICT');
    expect(differentActor.result.errorCode).toBe('COMMAND_ID_CONFLICT');
    expect(instance.getState('game-1')?.players[0]?.life).toBe(23);
    expect(instance.getEvents('game-1')).toHaveLength(1);
  });

  it('rejects sequential and concurrent commandId reuse across Games', async () => {
    const instance = processor();
    const secondGame = { ...makeState(), gameId: 'game-2' };
    instance.registerGame(secondGame);
    instance.setPlayerConnected('game-2', PlayerIdSchema.parse('player-1'), true);
    instance.setPlayerConnected('game-2', PlayerIdSchema.parse('player-2'), true);
    const actor = PlayerIdSchema.parse('player-1');
    const command = { type: 'ChangeLife', commandId: 'global-id', payload: { amount: 3 } };
    const first = await instance.process('game-1', actor, command);
    const sequentialConflict = await instance.process('game-2', actor, command);
    expect(first.result.success).toBe(true);
    expect(sequentialConflict.result.errorCode).toBe('COMMAND_ID_CONFLICT');
    expect(instance.getState('game-2')?.sequence).toBe(0);

    const [concurrentWinner, concurrentConflict] = await Promise.all([
      instance.process('game-1', actor, { ...command, commandId: 'concurrent-global-id' }),
      instance.process('game-2', actor, { ...command, commandId: 'concurrent-global-id' }),
    ]);
    expect(concurrentWinner.result.success).toBe(true);
    expect(concurrentConflict.result.errorCode).toBe('COMMAND_ID_CONFLICT');
    expect(instance.getState('game-1')?.sequence).toBe(2);
    expect(instance.getState('game-2')?.sequence).toBe(0);
  });

  it('returns INVALID_ENVELOPE when a usable commandId is present and rejects uncorrelatable envelopes', async () => {
    const instance = processor();
    const malformed = await instance.process('game-1', PlayerIdSchema.parse('player-1'), {
      type: '', commandId: 'malformed-1',
    });
    expect(malformed.result).toMatchObject({ success: false, errorCode: 'INVALID_ENVELOPE' });
    await expect(instance.process('game-1', PlayerIdSchema.parse('player-1'), { type: 'ChangeLife' }))
      .rejects.toBeInstanceOf(InvalidCommandEnvelopeError);
  });

  it('uses fixed codes for missing Games, unknown Commands, and unexpected handler failures', async () => {
    const instance = processor();
    const actor = PlayerIdSchema.parse('player-1');
    const missingGame = await instance.process('missing-game', actor, { type: 'ChangeLife', commandId: 'missing-game-1', payload: { amount: 1 } });
    const unknownCommand = await instance.process('game-1', actor, { type: 'NotACommand', commandId: 'unknown-command-1' });
    instance.registerHandler('TestFailure', {
      payloadSchema: z.object({}).strict(),
      execute: () => { throw new Error('internal details must not reach the client'); },
    });
    const internalFailure = await instance.process('game-1', actor, { type: 'TestFailure', commandId: 'internal-failure-1', payload: {} });

    expect(missingGame.result.errorCode).toBe('GAME_NOT_FOUND');
    expect(unknownCommand.result.errorCode).toBe('UNKNOWN_COMMAND');
    expect(internalFailure.result.errorCode).toBe('INTERNAL_ERROR');
    expect(internalFailure.result).not.toHaveProperty('message');
  });

  it('does not change state or sequence for invalid payloads and failed operations', async () => {
    const instance = processor();
    const actor = PlayerIdSchema.parse('player-1');
    const invalidPayload = await instance.process('game-1', actor, {
      type: 'ChangeLife', commandId: 'command-1', payload: { amount: 'three' },
    });
    const failedOperation = await instance.process('game-1', actor, {
      type: 'ChangeLife', commandId: 'command-2', payload: { amount: 0 },
    });

    expect(invalidPayload.result).toMatchObject({ success: false, errorCode: 'INVALID_PAYLOAD' });
    expect(failedOperation.result).toMatchObject({ success: false, errorCode: 'INVALID_AMOUNT' });
    expect(instance.getState('game-1')?.sequence).toBe(0);
    expect(instance.getEvents('game-1')).toHaveLength(0);
  });

  it('serializes concurrent commands for one game', async () => {
    const instance = processor();
    const actor = PlayerIdSchema.parse('player-1');
    const [first, second] = await Promise.all([
      instance.process('game-1', actor, { type: 'ChangeLife', commandId: 'command-1', payload: { amount: 1 } }),
      instance.process('game-1', actor, { type: 'ChangeLife', commandId: 'command-2', payload: { amount: 2 } }),
    ]);

    expect(first.event?.sequence).toBe(1);
    expect(second.event?.sequence).toBe(2);
    expect(instance.getState('game-1')?.players[0]?.life).toBe(23);
  });

  it('rejects operations while either player is disconnected', async () => {
    const instance = processor();
    instance.setPlayerConnected('game-1', PlayerIdSchema.parse('player-2'), false);
    const response = await instance.process('game-1', PlayerIdSchema.parse('player-1'), {
      type: 'ChangeLife', commandId: 'command-1', payload: { amount: 1 },
    });

    expect(response.result).toMatchObject({ success: false, errorCode: 'PLAYERS_NOT_CONNECTED' });
    expect(instance.getState('game-1')?.sequence).toBe(0);
    expect(instance.getEvents('game-1')).toHaveLength(0);
  });

  it('connects every Game operation payload to its Phase 3 operation and emits a sequenced event', async () => {
    idCounter = 0;
    const instance = createGameCommandProcessor(() => 0);
    const state = makeState();
    instance.registerGame(state);
    instance.setPlayerConnected('game-1', PlayerIdSchema.parse('player-1'), true);
    instance.setPlayerConnected('game-1', PlayerIdSchema.parse('player-2'), true);
    const cardId = zoneFor(state, 'HAND', 'player-1').cardIds[0]!;
    const secondCardId = zoneFor(state, 'HAND', 'player-1').cardIds[2]!;
    const battlefield = zoneFor(state, 'BATTLEFIELD', null);
    const commands: Array<{ actor: string; type: string; payload?: unknown }> = [
      { actor: 'player-1', type: 'MoveCard', payload: { cardId, destinationZoneId: battlefield.zoneId, position: { x: 1, y: 2 } } },
      { actor: 'player-1', type: 'ReorderCard', payload: { cardId: secondCardId, insertIndex: 0 } },
      { actor: 'player-1', type: 'TapCard', payload: { cardId } },
      { actor: 'player-1', type: 'UntapCard', payload: { cardId } },
      { actor: 'player-1', type: 'TurnFaceDown', payload: { cardId } },
      { actor: 'player-1', type: 'TurnFaceUp', payload: { cardId } },
      { actor: 'player-1', type: 'AddCounter', payload: { cardId, counterType: 'OTHER', amount: 2 } },
      { actor: 'player-1', type: 'RemoveCounter', payload: { cardId, counterType: 'OTHER', amount: 1 } },
      { actor: 'player-1', type: 'ChangeController', payload: { cardId, controllerPlayerId: 'player-2' } },
      { actor: 'player-2', type: 'ChangeVisibility', payload: { cardId, visibility: 'CONTROLLER_ONLY' } },
      { actor: 'player-2', type: 'MoveCardPosition', payload: { cardId, position: { x: 4, y: 5 } } },
      { actor: 'player-1', type: 'ChangeLife', payload: { amount: -2 } },
      { actor: 'player-1', type: 'ShuffleZone', payload: { zoneId: zoneFor(state, 'LIBRARY', 'player-1').zoneId } },
      { actor: 'player-1', type: 'ChangeTurnPosition', payload: { phase: 'ENDING', step: 'END' } },
      { actor: 'player-1', type: 'EndTurn' },
      { actor: 'player-2', type: 'Concede' },
    ];

    for (const [index, command] of commands.entries()) {
      const response = await instance.process('game-1', PlayerIdSchema.parse(command.actor), {
        type: command.type, commandId: `mapped-${index}`, ...(command.payload === undefined ? {} : { payload: command.payload }),
      });
      expect(response.result.success, command.type).toBe(true);
      expect(response.event?.eventType, command.type).toBe(`${command.type}Applied`);
      expect(response.event?.sequence, command.type).toBe(index + 1);
      expect(response.event?.payload).toMatchObject({
        actorPlayerId: command.actor,
        commandPayload: command.payload ?? null,
      });
      if (command.type === 'ShuffleZone') {
        const eventPayload = response.event?.payload as { cardIds?: string[] };
        expect(eventPayload.cardIds).toHaveLength(53);
      }
    }

    expect(instance.getState('game-1')?.status).toBe('FINISHED');
    expect(instance.getState('game-1')?.activePlayerId).toBe('player-2');
    expect(instance.getState('game-1')?.cards[cardId]?.controllerPlayerId).toBe('player-2');
    expect(instance.getEvents('game-1')).toHaveLength(commands.length);
  });

  it('applies destination-dependent payload rules against the current GameState', async () => {
    const instance = createGameCommandProcessor();
    const state = makeState();
    instance.registerGame(state);
    instance.setPlayerConnected('game-1', PlayerIdSchema.parse('player-1'), true);
    instance.setPlayerConnected('game-1', PlayerIdSchema.parse('player-2'), true);
    const cardId = zoneFor(state, 'HAND', 'player-1').cardIds[0]!;
    const battlefield = zoneFor(state, 'BATTLEFIELD', null);

    const response = await instance.process('game-1', PlayerIdSchema.parse('player-1'), {
      type: 'MoveCard', commandId: 'invalid-battlefield-move',
      payload: { cardId, destinationZoneId: battlefield.zoneId },
    });

    expect(response.result).toMatchObject({ success: false, errorCode: 'INVALID_POSITION' });
    expect(instance.getState('game-1')?.sequence).toBe(0);
    expect(instance.getEvents('game-1')).toHaveLength(0);

    const wrongActor = await instance.process('game-1', PlayerIdSchema.parse('player-2'), {
      type: 'MoveCard', commandId: 'wrong-move-actor',
      payload: { cardId, destinationZoneId: battlefield.zoneId, position: { x: 0, y: 0 } },
    });
    expect(wrongActor.result).toMatchObject({ success: false, errorCode: 'FORBIDDEN' });
    expect(instance.getState('game-1')?.sequence).toBe(0);
    expect(instance.getEvents('game-1')).toHaveLength(0);
  });
});
