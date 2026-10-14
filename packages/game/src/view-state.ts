import { randomUUID } from 'node:crypto';
import { GameCommandPayloadSchemas, type GameCardId, type PlayerId } from '@easymtg/shared';
import type { CommandHandler, CommandProcessorViewState, ViewNotification } from './command-processor.js';
import { GameOperationError, moveCard } from './operations.js';
import { ViewStateSchema, type GameState, type ViewState } from './model.js';
import { canViewCardIdentity, createIdentifiedCardView } from './views.js';

function assertPlaying(state: GameState, actor: PlayerId) {
  if (!state.players.some(({ playerId }) => playerId === actor)) throw new GameOperationError('FORBIDDEN', 'Actor is not a player in this game.');
  if (state.status !== 'PLAYING') throw new GameOperationError('GAME_NOT_PLAYING', 'Game is not playing.');
}

function zoneById(state: GameState, zoneId: string) {
  const zone = state.zones.find((candidate) => candidate.zoneId === zoneId);
  if (!zone) throw new GameOperationError('ZONE_NOT_FOUND', 'Zone does not exist.');
  return zone;
}

function notifyEnded(state: GameState, view: ViewState, reason: 'CONFIRMED' | 'CANCELLED' | 'REPLACED'): ViewNotification[] {
  return state.players.map(({ playerId }) => ({
    recipientPlayerId: playerId,
    type: 'ViewStateEnded',
    payload: { viewId: view.viewId, viewerPlayerId: view.viewerPlayerId, reason },
  }));
}

export function createViewStateNotifications(state: GameState, view: ViewState): ViewNotification[] {
  const publicPayload = {
    viewId: view.viewId,
    viewerPlayerId: view.viewerPlayerId,
    viewType: view.viewType,
    sourceZoneId: view.sourceZoneId,
    count: view.viewedCardIds.length,
  };
  return state.players.flatMap(({ playerId }) => [
    { recipientPlayerId: playerId, type: 'ViewStateStarted', payload: publicPayload },
    ...(playerId === view.viewerPlayerId ? [{
      recipientPlayerId: playerId,
      type: 'ViewStatePrivate',
      payload: {
        ...publicPayload,
        viewedCardIds: [...view.viewedCardIds],
        selectedCardIds: [...(view.selectedCardIds ?? [])],
        cards: view.viewedCardIds.map((cardId) => createIdentifiedCardView(state, cardId)),
      },
    }] : []),
  ]);
}

export function createViewStateSyncNotification(state: GameState, view: ViewState, recipientPlayerId: PlayerId): ViewNotification {
  const publicPayload = {
    viewId: view.viewId, viewerPlayerId: view.viewerPlayerId, viewType: view.viewType,
    sourceZoneId: view.sourceZoneId, count: view.viewedCardIds.length,
  };
  return {
    recipientPlayerId,
    type: 'ViewStateSync',
    payload: recipientPlayerId === view.viewerPlayerId ? {
      ...publicPayload,
      viewedCardIds: [...view.viewedCardIds],
      selectedCardIds: [...(view.selectedCardIds ?? [])],
      cards: view.viewedCardIds.map((cardId) => createIdentifiedCardView(state, cardId)),
    } : publicPayload,
  };
}

function requireView(view: ViewState | undefined, actor: PlayerId, viewId: string) {
  if (!view || view.viewId !== viewId || view.viewerPlayerId !== actor) {
    throw new GameOperationError('VIEW_NOT_FOUND', 'ViewState does not exist for this player.');
  }
  return view;
}

function newView(state: GameState, actor: PlayerId, sourceZoneId: string, viewType: ViewState['viewType'], count?: number): ViewState {
  const zone = zoneById(state, sourceZoneId);
  let cardIds: string[];
  if (viewType === 'LIBRARY_TOP' || viewType === 'LIBRARY_SEARCH') {
    if (zone.type !== 'LIBRARY' || zone.ownerPlayerId !== actor) throw new GameOperationError('VIEW_ACCESS_DENIED', 'Only the library owner may view their library.');
    if (viewType === 'LIBRARY_TOP') {
      if (count === undefined || count > zone.cardIds.length) throw new GameOperationError('VIEW_ACCESS_DENIED', 'Requested library count is unavailable.');
      cardIds = zone.cardIds.slice(0, count);
    } else cardIds = [...zone.cardIds];
  } else {
    if (zone.type === 'LIBRARY') throw new GameOperationError('VIEW_ACCESS_DENIED', 'Use a library view type to view a library.');
    const isPublicZone = zone.type === 'BATTLEFIELD' || zone.type === 'GRAVEYARD' || zone.type === 'EXILE';
    const isOwnPrivateZone = (zone.type === 'HAND' || zone.type === 'SIDEBOARD') && zone.ownerPlayerId === actor;
    if (!isPublicZone && !isOwnPrivateZone) throw new GameOperationError('VIEW_ACCESS_DENIED', 'Player cannot view this zone.');
    cardIds = zone.cardIds.filter((cardId) => canViewCardIdentity(state, actor, cardId));
  }
  return ViewStateSchema.parse({
    viewId: randomUUID(), viewerPlayerId: actor, viewType, sourceZoneId,
    viewedCardIds: cardIds, selectedCardIds: [],
  });
}

export function registerViewStateCommandHandlers(processor: CommandProcessorViewState) {
  const register = (type: string, payloadSchema: { safeParse(value: unknown): { success: true; data: unknown } | { success: false } }, execute: CommandHandler['execute']) => {
    processor.registerHandler(type, { payloadSchema, execute });
  };

  register('StartView', GameCommandPayloadSchemas.StartView, (state, actor, payload, currentView) => {
    assertPlaying(state, actor);
    const input = payload as { sourceZoneId: string; viewType: ViewState['viewType']; count?: number };
    const sourceCardIdsSnapshot = [...zoneById(state, input.sourceZoneId).cardIds];
    const view = newView(state, actor, input.sourceZoneId, input.viewType, input.count);
    return {
      state,
      eventType: 'StartViewApplied',
      payload: null,
      viewStateChange: {
        playerId: actor,
        value: view,
        sourceCardIdsSnapshot,
        notifications: [
          ...(currentView ? notifyEnded(state, currentView, 'REPLACED') : []),
          ...createViewStateNotifications(state, view),
        ],
      },
    };
  });

  register('SelectViewCard', GameCommandPayloadSchemas.SelectViewCard, (state, actor, payload, currentView, sourceCardIdsSnapshot) => {
    assertPlaying(state, actor);
    const input = payload as { viewId: string; cardId: GameCardId; selected: boolean };
    const view = requireView(currentView, actor, input.viewId);
    if (!view.viewedCardIds.includes(input.cardId)) throw new GameOperationError('VIEW_CARD_NOT_FOUND', 'Card is not included in this view.');
    const selected = new Set(view.selectedCardIds ?? []);
    if (input.selected) selected.add(input.cardId); else selected.delete(input.cardId);
    const next = ViewStateSchema.parse({ ...view, selectedCardIds: [...selected] });
    return {
      state,
      eventType: 'SelectViewCardApplied',
      payload: null,
      viewStateChange: {
        playerId: actor, value: next,
        ...(sourceCardIdsSnapshot === undefined ? {} : { sourceCardIdsSnapshot }),
        notifications: [{ recipientPlayerId: actor, type: 'ViewStatePrivate', payload: createViewStateNotifications(state, next).find(({ type }) => type === 'ViewStatePrivate')!.payload }],
      },
    };
  });

  register('ReorderViewCards', GameCommandPayloadSchemas.ReorderViewCards, (state, actor, payload, currentView, sourceCardIdsSnapshot) => {
    assertPlaying(state, actor);
    const input = payload as { viewId: string; cardIds: GameCardId[] };
    const view = requireView(currentView, actor, input.viewId);
    if (input.cardIds.length !== view.viewedCardIds.length || new Set(input.cardIds).size !== input.cardIds.length ||
        input.cardIds.some((cardId) => !view.viewedCardIds.includes(cardId))) {
      throw new GameOperationError('INVALID_VIEW_ORDER', 'New order must be a complete permutation of viewed cards.');
    }
    const next = ViewStateSchema.parse({ ...view, viewedCardIds: [...input.cardIds] });
    return {
      state,
      eventType: 'ReorderViewCardsApplied',
      payload: null,
      viewStateChange: {
        playerId: actor, value: next,
        ...(sourceCardIdsSnapshot === undefined ? {} : { sourceCardIdsSnapshot }),
        notifications: [{ recipientPlayerId: actor, type: 'ViewStatePrivate', payload: createViewStateNotifications(state, next).find(({ type }) => type === 'ViewStatePrivate')!.payload }],
      },
    };
  });

  register('ConfirmView', GameCommandPayloadSchemas.ConfirmView, (state, actor, payload, currentView, sourceCardIdsSnapshot) => {
    assertPlaying(state, actor);
    const input = payload as { viewId: string; moves: Array<{ cardId: GameCardId; destinationZoneId: string; position?: { x: number; y: number }; insertIndex?: number }> };
    const view = requireView(currentView, actor, input.viewId);
    const source = zoneById(state, view.sourceZoneId);
    if (!sourceCardIdsSnapshot || source.cardIds.length !== sourceCardIdsSnapshot.length ||
        source.cardIds.some((cardId, index) => cardId !== sourceCardIdsSnapshot[index]) ||
        view.viewedCardIds.some((cardId) => !source.cardIds.includes(cardId))) {
      throw new GameOperationError('VIEW_STALE', 'Source zone changed after the view started.');
    }
    const selected = new Set(view.selectedCardIds ?? []);
    const moveIds = input.moves.map(({ cardId }) => cardId);
    if (new Set(moveIds).size !== moveIds.length || moveIds.some((cardId) => !selected.has(cardId))) {
      throw new GameOperationError('INVALID_VIEW_SELECTION', 'Moves must contain unique selected cards only.');
    }
    let nextState = structuredClone(state);
    for (const move of input.moves) {
      nextState = moveCard(nextState, actor, move.cardId, move.destinationZoneId, {
        ...(move.position === undefined ? {} : { position: move.position }),
        ...(move.insertIndex === undefined ? {} : { insertIndex: move.insertIndex }),
      });
    }
    const viewIds = new Set(view.viewedCardIds);
    const remainingViewed = view.viewedCardIds.filter((cardId) => !moveIds.includes(cardId));
    const nextSource = nextState.zones.find(({ zoneId }) => zoneId === view.sourceZoneId)!;
    let replacementIndex = 0;
    nextSource.cardIds = nextSource.cardIds.map((cardId) => viewIds.has(cardId)
      ? remainingViewed[replacementIndex++]!
      : cardId);
    return {
      state: nextState,
      eventType: 'ConfirmViewApplied',
      payload: { actorPlayerId: actor, commandPayload: input, sourceZoneCardIds: [...nextSource.cardIds] },
      viewStateChange: { playerId: actor, value: null, sourceCardIdsSnapshot: null, notifications: notifyEnded(state, view, 'CONFIRMED') },
    };
  });

  register('CancelView', GameCommandPayloadSchemas.CancelView, (state, actor, payload, currentView) => {
    assertPlaying(state, actor);
    const input = payload as { viewId: string };
    const view = requireView(currentView, actor, input.viewId);
    return {
      state,
      eventType: 'CancelViewApplied',
      payload: null,
      viewStateChange: { playerId: actor, value: null, sourceCardIdsSnapshot: null, notifications: notifyEnded(state, view, 'CANCELLED') },
    };
  });
}
