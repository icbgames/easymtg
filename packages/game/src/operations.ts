import type { GameCardId, PlayerId } from '@easymtg/shared';
import type { CommandErrorCode } from '@easymtg/shared';
import { GameStateSchema, type GamePhase, type GameState, type GameStep, type Position, type Visibility, type Zone } from './model.js';

export class GameOperationError extends Error {
  constructor(readonly code: CommandErrorCode, message: string) { super(message); this.name = 'GameOperationError'; }
}

function ensurePlaying(state: GameState) {
  if (state.status !== 'PLAYING') throw new GameOperationError('GAME_NOT_PLAYING', 'Game is not playing.');
}

function findCard(state: GameState, cardId: GameCardId) {
  const card = state.cards[cardId];
  if (!card) throw new GameOperationError('CARD_NOT_FOUND', 'Card does not exist in this game.');
  const zone = state.zones.find((candidate) => candidate.cardIds.includes(cardId));
  if (!zone) throw new GameOperationError('INVALID_STATE', 'Card is not present in a zone.');
  return { card, zone };
}

function requireController(actorPlayerId: PlayerId, controllerPlayerId: PlayerId) {
  if (actorPlayerId !== controllerPlayerId) throw new GameOperationError('FORBIDDEN', 'Only the current controller may operate this card.');
}

function finalize(state: GameState): GameState { return GameStateSchema.parse(state); }

export function moveCard(state: GameState, actorPlayerId: PlayerId, cardId: GameCardId, destinationZoneId: string, options: { position?: Position; insertIndex?: number } = {}): GameState {
  ensurePlaying(state);
  const { card, zone: source } = findCard(state, cardId);
  const destination = state.zones.find((candidate) => candidate.zoneId === destinationZoneId);
  if (!destination) throw new GameOperationError('ZONE_NOT_FOUND', 'Destination zone does not exist.');
  if (source.type === 'BATTLEFIELD') requireController(actorPlayerId, card.controllerPlayerId);
  else if (actorPlayerId !== card.ownerPlayerId) throw new GameOperationError('FORBIDDEN', 'Only the owner may move a card from a non-battlefield zone.');
  if (source.zoneId === destination.zoneId) throw new GameOperationError('SAME_ZONE', 'Use reorderCard to change order within a zone.');
  if (destination.type !== 'BATTLEFIELD' && destination.ownerPlayerId !== card.ownerPlayerId) {
    throw new GameOperationError('INVALID_DESTINATION', 'A card must move to its owner’s non-battlefield zone.');
  }
  if (destination.type === 'BATTLEFIELD') {
    if (!options.position || options.insertIndex !== undefined) throw new GameOperationError('INVALID_POSITION', 'Battlefield moves require a position and do not accept an index.');
  } else if (options.position !== undefined) {
    throw new GameOperationError('INVALID_POSITION', 'Non-battlefield moves cannot specify a position.');
  }
  const insertIndex = options.insertIndex ?? 0;
  if (destination.type !== 'BATTLEFIELD' && (!Number.isInteger(insertIndex) || insertIndex < 0 || insertIndex > destination.cardIds.length)) {
    throw new GameOperationError('INVALID_INDEX', 'insertIndex is outside the destination zone.');
  }

  const next = structuredClone(state);
  const nextSource = next.zones.find((candidate) => candidate.zoneId === source.zoneId)!;
  const nextDestination = next.zones.find((candidate) => candidate.zoneId === destination.zoneId)!;
  const sourceIndex = nextSource.cardIds.indexOf(cardId);
  nextSource.cardIds.splice(sourceIndex, 1);
  if (nextDestination.type === 'BATTLEFIELD') nextDestination.cardIds.push(cardId);
  else nextDestination.cardIds.splice(insertIndex, 0, cardId);
  const nextCard = next.cards[cardId]!;
  if (source.type === 'BATTLEFIELD' && nextDestination.type !== 'BATTLEFIELD') nextCard.controllerPlayerId = nextCard.ownerPlayerId;
  nextCard.tapped = false;
  nextCard.faceDown = false;
  nextCard.position = options.position ?? null;
  nextCard.visibility = visibilityForZone(nextDestination.type);
  if (!['BATTLEFIELD', 'EXILE'].includes(nextDestination.type)) nextCard.counters = { plusOnePlusOne: 0, other: 0 };
  return finalize(next);
}

export function reorderCard(state: GameState, actorPlayerId: PlayerId, cardId: GameCardId, insertIndex: number): GameState {
  ensurePlaying(state);
  const { card, zone } = findCard(state, cardId);
  if (zone.type === 'BATTLEFIELD') throw new GameOperationError('INVALID_ZONE', 'Battlefield cards do not have a meaningful order.');
  if (zone.ownerPlayerId !== actorPlayerId || card.ownerPlayerId !== actorPlayerId) throw new GameOperationError('FORBIDDEN', 'Only the zone owner may reorder its cards.');
  if (!Number.isInteger(insertIndex) || insertIndex < 0 || insertIndex > zone.cardIds.length) throw new GameOperationError('INVALID_INDEX', 'insertIndex is outside the reordered zone.');
  const next = structuredClone(state);
  const nextZone = next.zones.find((candidate) => candidate.zoneId === zone.zoneId)!;
  nextZone.cardIds.splice(nextZone.cardIds.indexOf(cardId), 1);
  nextZone.cardIds.splice(insertIndex, 0, cardId);
  return finalize(next);
}

export function setCardTapped(state: GameState, actorPlayerId: PlayerId, cardId: GameCardId, tapped: boolean): GameState {
  ensurePlaying(state);
  const { card } = findCard(state, cardId);
  requireController(actorPlayerId, card.controllerPlayerId);
  const next = structuredClone(state);
  next.cards[cardId]!.tapped = tapped;
  return finalize(next);
}

export function turnFaceDown(state: GameState, actorPlayerId: PlayerId, cardId: GameCardId): GameState {
  return setCardFaceDown(state, actorPlayerId, cardId, true);
}

export function turnFaceUp(state: GameState, actorPlayerId: PlayerId, cardId: GameCardId): GameState {
  return setCardFaceDown(state, actorPlayerId, cardId, false);
}

function setCardFaceDown(state: GameState, actorPlayerId: PlayerId, cardId: GameCardId, faceDown: boolean): GameState {
  ensurePlaying(state);
  const { card } = findCard(state, cardId);
  requireController(actorPlayerId, card.controllerPlayerId);
  const next = structuredClone(state);
  next.cards[cardId]!.faceDown = faceDown;
  return finalize(next);
}

export function changeCounter(state: GameState, actorPlayerId: PlayerId, cardId: GameCardId, counterType: 'PLUS_ONE_PLUS_ONE' | 'OTHER', amount: number, action: 'ADD' | 'REMOVE'): GameState {
  ensurePlaying(state);
  if (!Number.isInteger(amount) || amount <= 0) throw new GameOperationError('INVALID_AMOUNT', 'Counter amount must be a positive integer.');
  const { card } = findCard(state, cardId);
  requireController(actorPlayerId, card.controllerPlayerId);
  const field = counterType === 'PLUS_ONE_PLUS_ONE' ? 'plusOnePlusOne' : 'other';
  const current = card.counters[field];
  if (action === 'REMOVE' && amount > current) throw new GameOperationError('COUNTER_UNDERFLOW', 'Cannot remove more counters than the card has.');
  const next = structuredClone(state);
  next.cards[cardId]!.counters[field] = current + (action === 'ADD' ? amount : -amount);
  return finalize(next);
}

export function changeController(state: GameState, actorPlayerId: PlayerId, cardId: GameCardId, controllerPlayerId: PlayerId): GameState {
  ensurePlaying(state);
  const { card, zone } = findCard(state, cardId);
  requireController(actorPlayerId, card.controllerPlayerId);
  if (zone.type !== 'BATTLEFIELD' || !state.players.some((player) => player.playerId === controllerPlayerId)) {
    throw new GameOperationError('INVALID_CONTROLLER', 'Controller changes require a battlefield card and a game player.');
  }
  const next = structuredClone(state);
  next.cards[cardId]!.controllerPlayerId = controllerPlayerId;
  return finalize(next);
}

export function changeVisibility(state: GameState, actorPlayerId: PlayerId, cardId: GameCardId, visibility: Visibility): GameState {
  ensurePlaying(state);
  const { card, zone } = findCard(state, cardId);
  requireController(actorPlayerId, card.controllerPlayerId);
  if (zone.type === 'LIBRARY' && visibility !== 'HIDDEN') throw new GameOperationError('INVALID_VISIBILITY', 'Library cards must remain hidden.');
  const next = structuredClone(state);
  next.cards[cardId]!.visibility = visibility;
  return finalize(next);
}

export function moveCardPosition(state: GameState, actorPlayerId: PlayerId, cardId: GameCardId, position: Position): GameState {
  ensurePlaying(state);
  const { card, zone } = findCard(state, cardId);
  requireController(actorPlayerId, card.controllerPlayerId);
  if (zone.type !== 'BATTLEFIELD') throw new GameOperationError('INVALID_ZONE', 'Only battlefield cards have a position.');
  const next = structuredClone(state);
  next.cards[cardId]!.position = position;
  return finalize(next);
}

export function changeLife(state: GameState, actorPlayerId: PlayerId, amount: number): GameState {
  ensurePlaying(state);
  if (!Number.isInteger(amount) || amount === 0) throw new GameOperationError('INVALID_AMOUNT', 'Life change must be a non-zero integer.');
  const player = state.players.find(({ playerId }) => playerId === actorPlayerId);
  if (!player) throw new GameOperationError('FORBIDDEN', 'Actor is not a player in this game.');
  const next = structuredClone(state);
  next.players.find(({ playerId }) => playerId === actorPlayerId)!.life += amount;
  return finalize(next);
}

const allowedSteps: Record<GamePhase, Array<GameStep | null>> = {
  BEGINNING: ['UNTAP', 'UPKEEP', 'DRAW'], PRECOMBAT_MAIN: [null],
  COMBAT: ['BEGIN_COMBAT', 'DECLARE_ATTACKERS', 'DECLARE_BLOCKERS', 'COMBAT_DAMAGE', 'END_COMBAT'],
  POSTCOMBAT_MAIN: [null], ENDING: ['END', 'CLEANUP'],
};

export function changeTurnPosition(state: GameState, actorPlayerId: PlayerId, phase: GamePhase, step: GameStep | null): GameState {
  ensurePlaying(state);
  if (state.activePlayerId !== actorPlayerId) throw new GameOperationError('FORBIDDEN', 'Only the active player may change phase or step.');
  if (!allowedSteps[phase].includes(step)) throw new GameOperationError('INVALID_TURN_POSITION', 'Step is not valid for the selected phase.');
  const next = structuredClone(state);
  next.phase = phase;
  next.step = step;
  return finalize(next);
}

export function endTurn(state: GameState, actorPlayerId: PlayerId): GameState {
  ensurePlaying(state);
  if (state.activePlayerId !== actorPlayerId) throw new GameOperationError('FORBIDDEN', 'Only the active player may end the turn.');
  if (state.phase !== 'ENDING') throw new GameOperationError('INVALID_TURN_POSITION', 'Turn can only end during the ending phase.');
  const next = structuredClone(state);
  next.activePlayerId = state.players.find(({ playerId }) => playerId !== state.activePlayerId)!.playerId;
  next.turnNumber += 1;
  next.phase = 'BEGINNING';
  next.step = 'UNTAP';
  return finalize(next);
}

export function concede(state: GameState, actorPlayerId: PlayerId): GameState {
  ensurePlaying(state);
  if (!state.players.some(({ playerId }) => playerId === actorPlayerId)) throw new GameOperationError('FORBIDDEN', 'Actor is not a player in this game.');
  const next = structuredClone(state);
  next.status = 'FINISHED';
  return finalize(next);
}

export function shuffleZone(state: GameState, actorPlayerId: PlayerId, zoneId: string, randomIndex: (maxExclusive: number) => number): GameState {
  ensurePlaying(state);
  const zone = state.zones.find((candidate) => candidate.zoneId === zoneId);
  if (!zone) throw new GameOperationError('ZONE_NOT_FOUND', 'Zone does not exist.');
  if (zone.type === 'BATTLEFIELD' || zone.ownerPlayerId !== actorPlayerId) throw new GameOperationError('FORBIDDEN', 'Only the owner may shuffle a private zone.');
  const next = structuredClone(state);
  const nextZone = next.zones.find((candidate) => candidate.zoneId === zoneId)!;
  for (let index = nextZone.cardIds.length - 1; index > 0; index -= 1) {
    const otherIndex = randomIndex(index + 1);
    if (!Number.isInteger(otherIndex) || otherIndex < 0 || otherIndex > index) throw new GameOperationError('INVALID_RANDOM_SOURCE', 'Random source returned an invalid index.');
    [nextZone.cardIds[index], nextZone.cardIds[otherIndex]] = [nextZone.cardIds[otherIndex]!, nextZone.cardIds[index]!];
  }
  return finalize(next);
}

function visibilityForZone(type: Zone['type']): Visibility {
  if (type === 'LIBRARY') return 'HIDDEN';
  if (type === 'HAND' || type === 'SIDEBOARD') return 'CONTROLLER_ONLY';
  return 'PUBLIC';
}
