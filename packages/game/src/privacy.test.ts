import { describe, expect, it } from 'vitest';
import { CardDefinitionIdSchema, DeckEntrySchema, PlayerIdSchema, type GameEvent } from '@easymtg/shared';
import { changeVisibility, createGameCommandProcessor, createGameEventView, createGameStateView, createInitialGameState, moveCard } from './index.js';

const definitionId = CardDefinitionIdSchema.parse('ABC001');
const deckEntry = DeckEntrySchema.parse({ cardDefinitionId: definitionId, quantity: 60 });
let idCounter = 0;
function makeState() {
  return createInitialGameState({
    gameId: 'privacy-game', matchId: 'privacy-match', playerIds: ['player-1', 'player-2'], hostPlayerId: 'player-1',
    decks: [
      { playerId: 'player-1', mainboard: [deckEntry], sideboard: [] },
      { playerId: 'player-2', mainboard: [deckEntry], sideboard: [] },
    ],
    definitions: { [definitionId]: { version: 1, status: 'ENABLED' } },
    createId: () => `privacy-card-${idCounter++}`,
    randomIndex: () => 0,
  });
}
const zoneFor = (state: ReturnType<typeof makeState>, type: string, ownerPlayerId: string | null) =>
  state.zones.find((zone) => zone.type === type && zone.ownerPlayerId === ownerPlayerId)!;

function makeProcessor() {
  const processor = createGameCommandProcessor(() => 0);
  processor.registerGame(makeState());
  processor.setPlayerConnected('privacy-game', PlayerIdSchema.parse('player-1'), true);
  processor.setPlayerConnected('privacy-game', PlayerIdSchema.parse('player-2'), true);
  return processor;
}

describe('Player-specific Game views', () => {
  it('keeps opponent Hand, Sideboard, and Library identities out of GameStateView', () => {
    const state = makeState();
    const opponentView = createGameStateView(state, PlayerIdSchema.parse('player-2'));
    const playerOneHand = opponentView.zones.find((zone) => zone.zoneId === zoneFor(state, 'HAND', 'player-1').zoneId)!;
    const playerTwoHand = opponentView.zones.find((zone) => zone.zoneId === zoneFor(state, 'HAND', 'player-2').zoneId)!;
    const playerOneLibrary = opponentView.zones.find((zone) => zone.zoneId === zoneFor(state, 'LIBRARY', 'player-1').zoneId)!;

    expect(playerOneHand.cards).toHaveLength(7);
    expect(playerOneHand.cards.every((card) => !('cardId' in card))).toBe(true);
    expect(playerTwoHand.cards).toHaveLength(7);
    expect(playerTwoHand.cards.every((card) => 'cardId' in card && 'cardDefinitionId' in card)).toBe(true);
    expect(playerOneLibrary.cards.every((card) => !('cardId' in card))).toBe(true);
    expect(opponentView.zones.flatMap(({ cards }) => cards).some((card) => 'visibility' in card)).toBe(false);
  });

  it('uses zone restrictions before visibility and masks controller-only cards for non-controllers', () => {
    const state = makeState();
    const hand = zoneFor(state, 'HAND', 'player-1');
    const cardId = hand.cardIds[0]!;
    const publicHandState = structuredClone(state);
    publicHandState.cards[cardId]!.visibility = 'PUBLIC';
    const opponentView = createGameStateView(publicHandState, PlayerIdSchema.parse('player-2'));
    const opponentHand = opponentView.zones.find(({ zoneId }) => zoneId === hand.zoneId)!;
    expect(opponentHand.cards[0]).not.toHaveProperty('cardId');

    const battlefield = zoneFor(state, 'BATTLEFIELD', null);
    const onBattlefield = moveCard(state, PlayerIdSchema.parse('player-1'), cardId, battlefield.zoneId, { position: { x: 0, y: 0 } });
    const controllerOnly = changeVisibility(onBattlefield, PlayerIdSchema.parse('player-1'), cardId, 'CONTROLLER_ONLY');
    const playerTwoView = createGameStateView(controllerOnly, PlayerIdSchema.parse('player-2'));
    const playerOneView = createGameStateView(controllerOnly, PlayerIdSchema.parse('player-1'));
    expect(playerTwoView.zones.find(({ zoneId }) => zoneId === battlefield.zoneId)!.cards[0]).not.toHaveProperty('cardId');
    expect(playerOneView.zones.find(({ zoneId }) => zoneId === battlefield.zoneId)!.cards[0]).toHaveProperty('cardId', cardId);
  });

  it('redacts private card IDs and definition IDs from Canonical Events', () => {
    const state = makeState();
    const hiddenCardId = zoneFor(state, 'HAND', 'player-1').cardIds[0]!;
    const event = {
      type: 'GameEvent', eventId: '14a6eeb9-0fa6-4e9a-91bf-b8ef5117c926', gameId: state.gameId,
      sequence: 1, eventType: 'MoveCardApplied',
      payload: { actorPlayerId: 'player-1', commandPayload: { cardId: hiddenCardId, cardDefinitionId: definitionId }, cardIds: [hiddenCardId] },
    } satisfies GameEvent;
    const view = createGameEventView(event, state, PlayerIdSchema.parse('player-2'));
    const serialized = JSON.stringify(view.payload);
    expect(serialized).not.toContain(hiddenCardId);
    expect(serialized).not.toContain(definitionId);
  });
});

describe('ViewState commands', () => {
  it('keeps view details private and confirms an ordered selected move as one Game Event', async () => {
    const processor = makeProcessor();
    const before = processor.getState('privacy-game')!;
    const library = zoneFor(before, 'LIBRARY', 'player-1');
    const start = await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), {
      type: 'StartView', commandId: 'view-start', payload: { sourceZoneId: library.zoneId, viewType: 'LIBRARY_TOP', count: 3 },
    });
    expect(start.event).toBeNull();
    expect(processor.getState('privacy-game')?.sequence).toBe(0);
    const publicStart = start.notifications.find(({ recipientPlayerId, type }) => recipientPlayerId === 'player-2' && type === 'ViewStateStarted')!;
    expect(JSON.stringify(publicStart.payload)).not.toContain(library.cardIds[0]!);
    const privateStart = start.notifications.find(({ recipientPlayerId, type }) => recipientPlayerId === 'player-1' && type === 'ViewStatePrivate')!;
    const privatePayload = privateStart.payload as { viewId: string; viewedCardIds: string[] };
    const initialStateView = createGameStateView(processor.getState('privacy-game')!, PlayerIdSchema.parse('player-1'));
    const libraryStateView = initialStateView.zones.find(({ zoneId }) => zoneId === library.zoneId)!;
    expect(libraryStateView.cards.every((card) => !('cardId' in card))).toBe(true);
    const [firstCardId, secondCardId, thirdCardId] = privatePayload.viewedCardIds;
    expect(privatePayload.viewedCardIds).toHaveLength(3);

    const select = await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), {
      type: 'SelectViewCard', commandId: 'view-select', payload: { viewId: privatePayload.viewId, cardId: secondCardId, selected: true },
    });
    expect(select.event).toBeNull();
    expect(select.notifications.every(({ recipientPlayerId }) => recipientPlayerId === 'player-1')).toBe(true);
    const reorder = await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), {
      type: 'ReorderViewCards', commandId: 'view-reorder', payload: { viewId: privatePayload.viewId, cardIds: [thirdCardId!, secondCardId!, firstCardId!] },
    });
    expect(reorder.event).toBeNull();
    const confirm = await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), {
      type: 'ConfirmView', commandId: 'view-confirm', payload: {
        viewId: privatePayload.viewId,
        moves: [{ cardId: secondCardId, destinationZoneId: zoneFor(before, 'GRAVEYARD', 'player-1').zoneId }],
      },
    });
    const after = processor.getState('privacy-game')!;
    expect(confirm.result.success).toBe(true);
    expect(confirm.event?.eventType).toBe('ConfirmViewApplied');
    expect(confirm.event?.sequence).toBe(1);
    expect(after.sequence).toBe(1);
    expect(zoneFor(after, 'LIBRARY', 'player-1').cardIds.slice(0, 3)).toEqual([thirdCardId, firstCardId, ...library.cardIds.slice(3, 4)]);
    expect(zoneFor(after, 'GRAVEYARD', 'player-1').cardIds[0]).toBe(secondCardId);
    expect(processor.getViewState('privacy-game', PlayerIdSchema.parse('player-1'))).toBeUndefined();
    expect(confirm.notifications.map(({ type }) => type)).toEqual(['ViewStateEnded', 'ViewStateEnded']);
  });

  it('rejects stale views without changing GameState and syncs active views without exposing IDs', async () => {
    const processor = makeProcessor();
    const initial = processor.getState('privacy-game')!;
    const library = zoneFor(initial, 'LIBRARY', 'player-1');
    const start = await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), {
      type: 'StartView', commandId: 'stale-start', payload: { sourceZoneId: library.zoneId, viewType: 'LIBRARY_TOP', count: 2 },
    });
    const privatePayload = start.notifications.find(({ type }) => type === 'ViewStatePrivate')!.payload as { viewId: string };
    const ownViewSync = processor.getViewStateSyncMessages('privacy-game', PlayerIdSchema.parse('player-1'));
    const opponentViewSync = processor.getViewStateSyncMessages('privacy-game', PlayerIdSchema.parse('player-2'));
    expect(JSON.stringify(ownViewSync)).toContain(library.cardIds[0]!);
    expect(JSON.stringify(opponentViewSync)).not.toContain(library.cardIds[0]!);

    const reordered = await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), {
      type: 'ReorderCard', commandId: 'external-reorder', payload: { cardId: library.cardIds[0], insertIndex: 2 },
    });
    expect(reordered.result.success).toBe(true);
    const beforeConfirm = processor.getState('privacy-game')!;
    const stale = await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), {
      type: 'ConfirmView', commandId: 'stale-confirm', payload: { viewId: privatePayload.viewId },
    });
    expect(stale.result.errorCode).toBe('VIEW_STALE');
    expect(processor.getState('privacy-game')).toEqual(beforeConfirm);
    expect(processor.getViewState('privacy-game', PlayerIdSchema.parse('player-1'))).toBeDefined();
  });

  it('denies opponent private zones, rejects invalid permutations, and cancels without a Game Event', async () => {
    const processor = makeProcessor();
    const state = processor.getState('privacy-game')!;
    const opponentHand = zoneFor(state, 'HAND', 'player-2');
    const denied = await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), {
      type: 'StartView', commandId: 'deny-opponent-hand', payload: { sourceZoneId: opponentHand.zoneId, viewType: 'ZONE_VIEW' },
    });
    expect(denied.result.errorCode).toBe('VIEW_ACCESS_DENIED');
    expect(processor.getViewState('privacy-game', PlayerIdSchema.parse('player-1'))).toBeUndefined();

    const library = zoneFor(state, 'LIBRARY', 'player-1');
    const started = await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), {
      type: 'StartView', commandId: 'invalid-order-start', payload: { sourceZoneId: library.zoneId, viewType: 'LIBRARY_TOP', count: 2 },
    });
    const privatePayload = started.notifications.find(({ type }) => type === 'ViewStatePrivate')!.payload as { viewId: string; viewedCardIds: string[] };
    const invalidOrder = await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), {
      type: 'ReorderViewCards', commandId: 'invalid-order', payload: { viewId: privatePayload.viewId, cardIds: [privatePayload.viewedCardIds[0]!, privatePayload.viewedCardIds[0]!] },
    });
    expect(invalidOrder.result.errorCode).toBe('INVALID_VIEW_ORDER');
    const cancel = await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), {
      type: 'CancelView', commandId: 'cancel-view', payload: { viewId: privatePayload.viewId },
    });
    expect(cancel.result.success).toBe(true);
    expect(cancel.event).toBeNull();
    expect(processor.getState('privacy-game')?.sequence).toBe(0);
    expect(processor.getViewState('privacy-game', PlayerIdSchema.parse('player-1'))).toBeUndefined();
    expect(cancel.notifications.map(({ type }) => type)).toEqual(['ViewStateEnded', 'ViewStateEnded']);
  });

  it('syncs both players’ active ViewStates with private card details only to each viewer', async () => {
    const processor = makeProcessor();
    const state = processor.getState('privacy-game')!;
    const playerOneLibrary = zoneFor(state, 'LIBRARY', 'player-1');
    const playerTwoLibrary = zoneFor(state, 'LIBRARY', 'player-2');
    await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), {
      type: 'StartView', commandId: 'player-one-start', payload: { sourceZoneId: playerOneLibrary.zoneId, viewType: 'LIBRARY_TOP', count: 1 },
    });
    await processor.process('privacy-game', PlayerIdSchema.parse('player-2'), {
      type: 'StartView', commandId: 'player-two-start', payload: { sourceZoneId: playerTwoLibrary.zoneId, viewType: 'LIBRARY_TOP', count: 1 },
    });

    const playerOneSync = processor.getViewStateSyncMessages('privacy-game', PlayerIdSchema.parse('player-1'));
    const playerTwoSync = processor.getViewStateSyncMessages('privacy-game', PlayerIdSchema.parse('player-2'));
    expect(playerOneSync).toHaveLength(2);
    expect(playerTwoSync).toHaveLength(2);
    expect(JSON.stringify(playerOneSync)).toContain(playerOneLibrary.cardIds[0]!);
    expect(JSON.stringify(playerOneSync)).not.toContain(playerTwoLibrary.cardIds[0]!);
    expect(JSON.stringify(playerTwoSync)).toContain(playerTwoLibrary.cardIds[0]!);
    expect(JSON.stringify(playerTwoSync)).not.toContain(playerOneLibrary.cardIds[0]!);
  });

  it('replaces the same player’s prior ViewState and notifies both players without a Game Event', async () => {
    const processor = makeProcessor();
    const state = processor.getState('privacy-game')!;
    const library = zoneFor(state, 'LIBRARY', 'player-1');
    const first = await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), {
      type: 'StartView', commandId: 'replace-view-first', payload: { sourceZoneId: library.zoneId, viewType: 'LIBRARY_TOP', count: 1 },
    });
    const oldView = first.notifications.find(({ type }) => type === 'ViewStatePrivate')!.payload as { viewId: string };
    const replacement = await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), {
      type: 'StartView', commandId: 'replace-view-second', payload: { sourceZoneId: library.zoneId, viewType: 'LIBRARY_SEARCH' },
    });
    const ended = replacement.notifications.filter(({ type }) => type === 'ViewStateEnded');
    expect(ended).toHaveLength(2);
    expect(ended.every(({ payload }) => (payload as { reason: string }).reason === 'REPLACED')).toBe(true);
    expect(ended.every(({ payload }) => (payload as { viewId: string }).viewId === oldView.viewId)).toBe(true);
    expect(replacement.event).toBeNull();
    expect(processor.getState('privacy-game')?.sequence).toBe(0);
    expect(processor.getViewState('privacy-game', PlayerIdSchema.parse('player-1'))?.viewType).toBe('LIBRARY_SEARCH');
  });

  it('ends active views when the Game ends, after its Canonical Event is created', async () => {
    const processor = makeProcessor();
    const state = processor.getState('privacy-game')!;
    const library = zoneFor(state, 'LIBRARY', 'player-1');
    await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), {
      type: 'StartView', commandId: 'end-view-start', payload: { sourceZoneId: library.zoneId, viewType: 'LIBRARY_TOP', count: 1 },
    });
    const concede = await processor.process('privacy-game', PlayerIdSchema.parse('player-1'), { type: 'Concede', commandId: 'end-view-concede' });
    expect(concede.event?.eventType).toBe('ConcedeApplied');
    expect(concede.notifications.every(({ type }) => type === 'ViewStateEnded')).toBe(true);
    expect(concede.notifications.map(({ recipientPlayerId }) => recipientPlayerId)).toEqual(['player-1', 'player-2']);
    expect(processor.getViewState('privacy-game', PlayerIdSchema.parse('player-1'))).toBeUndefined();
  });
});
