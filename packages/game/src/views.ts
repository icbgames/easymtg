import { GameEventSchema, PlayerIdSchema, type GameCardId, type PlayerId, type GameEvent } from '@easymtg/shared';
import { GameOperationError } from './operations.js';
import { GameStateViewSchema, type GameCardView, type GameState, type GameStateView, type IdentifiedGameCardView, type ViewState } from './model.js';

export function canViewCardIdentity(
  state: GameState,
  viewerPlayerId: PlayerId,
  cardId: GameCardId,
  viewState?: ViewState,
): boolean {
  const card = state.cards[cardId];
  const zone = state.zones.find((candidate) => candidate.cardIds.includes(cardId));
  if (!card || !zone) return false;
  if (zone.type === 'LIBRARY') {
    return viewState?.viewerPlayerId === viewerPlayerId && viewState.viewedCardIds.includes(cardId);
  }
  if (zone.type === 'HAND' || zone.type === 'SIDEBOARD') return zone.ownerPlayerId === viewerPlayerId;
  if (card.visibility === 'PUBLIC') return true;
  if (card.visibility === 'CONTROLLER_ONLY') return card.controllerPlayerId === viewerPlayerId;
  return false;
}

function cardState(state: GameState, cardId: string): GameCardView {
  const card = state.cards[cardId]!;
  return {
    ownerPlayerId: card.ownerPlayerId,
    controllerPlayerId: card.controllerPlayerId,
    tapped: card.tapped,
    faceDown: card.faceDown,
    position: card.position,
    counters: structuredClone(card.counters),
  };
}

export function createIdentifiedCardView(state: GameState, cardId: GameCardId): IdentifiedGameCardView {
  const card = state.cards[cardId];
  if (!card) throw new GameOperationError('VIEW_CARD_NOT_FOUND', 'Viewed card no longer exists.');
  return {
    ...cardState(state, cardId),
    cardId: card.cardId,
    cardDefinitionId: card.cardDefinitionId,
    cardDefinitionVersion: card.cardDefinitionVersion,
  };
}

export function createGameStateView(state: GameState, viewerPlayerId: PlayerId): GameStateView {
  if (!state.players.some((player) => player.playerId === viewerPlayerId)) {
    throw new GameOperationError('FORBIDDEN', 'Viewer is not a player in this game.');
  }
  const view = {
    gameId: state.gameId,
    matchId: state.matchId,
    status: state.status,
    turnNumber: state.turnNumber,
    activePlayerId: state.activePlayerId,
    phase: state.phase,
    step: state.step,
    sequence: state.sequence,
    players: structuredClone(state.players),
    zones: state.zones.map((zone) => ({
      zoneId: zone.zoneId,
      type: zone.type,
      ownerPlayerId: zone.ownerPlayerId,
      cards: zone.cardIds.map((cardId) => canViewCardIdentity(state, viewerPlayerId, cardId)
        ? createIdentifiedCardView(state, cardId)
        : cardState(state, cardId)),
    })),
  };
  return GameStateViewSchema.parse(view);
}

function collectPrivateIdentities(state: GameState, viewerPlayerId: PlayerId) {
  const secrets = new Set<string>();
  for (const [rawCardId, card] of Object.entries(state.cards)) {
    const cardId = rawCardId as GameCardId;
    if (canViewCardIdentity(state, viewerPlayerId, cardId)) continue;
    secrets.add(cardId);
    secrets.add(card.cardDefinitionId);
  }
  return secrets;
}

function redact(value: unknown, privateIdentities: Set<string>): unknown {
  if (typeof value === 'string') return privateIdentities.has(value) ? undefined : value;
  if (Array.isArray(value)) return value.map((item) => redact(item, privateIdentities)).filter((item) => item !== undefined);
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (privateIdentities.has(key)) continue;
      const redacted = redact(item, privateIdentities);
      if (redacted !== undefined) output[key] = redacted;
    }
    return output;
  }
  return value;
}

/** Produces a recipient-safe event. Canonical events must never be sent directly to clients. */
export function createGameEventView(event: GameEvent, stateAfter: GameState, recipientPlayerId: PlayerId): GameEvent {
  if (event.gameId !== stateAfter.gameId) throw new GameOperationError('INVALID_STATE', 'Event and GameState belong to different Games.');
  if (!stateAfter.players.some(({ playerId }) => playerId === recipientPlayerId)) {
    throw new GameOperationError('FORBIDDEN', 'Recipient is not a player in this game.');
  }
  const privateIdentities = collectPrivateIdentities(stateAfter, recipientPlayerId);
  return GameEventSchema.parse({ ...event, payload: redact(event.payload, privateIdentities) ?? null });
}

export function assertViewRecipient(state: GameState, recipientPlayerId: PlayerId) {
  if (!PlayerIdSchema.safeParse(recipientPlayerId).success || !state.players.some(({ playerId }) => playerId === recipientPlayerId)) {
    throw new GameOperationError('FORBIDDEN', 'Recipient is not a player in this game.');
  }
}
