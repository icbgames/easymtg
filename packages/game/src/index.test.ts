import { describe, expect, it } from 'vitest';
import { CardDefinitionIdSchema, DeckEntrySchema, PlayerIdSchema } from '@easymtg/shared';
import {
  GameOperationError, GameStateSchema, ViewStateSchema, ZoneSchema,
  changeCounter, changeLife, changeTurnPosition, createInitialGameState,
  changeController, changeVisibility, concede, endTurn, moveCard, moveCardPosition, reorderCard, setCardTapped, shuffleZone, turnFaceDown, turnFaceUp,
} from './index.js';

const definitionId = CardDefinitionIdSchema.parse('ABC001');
const entry = DeckEntrySchema.parse({ cardDefinitionId: definitionId, quantity: 60 });
let idCounter = 0;
const makeState = (status: 'ENABLED' | 'DISABLED' = 'ENABLED') => createInitialGameState({
  gameId: 'game-1', matchId: 'match-1', playerIds: ['player-1', 'player-2'], hostPlayerId: 'player-1',
  decks: [
    { playerId: 'player-1', mainboard: [entry], sideboard: [] },
    { playerId: 'player-2', mainboard: [entry], sideboard: [] },
  ],
  definitions: { [definitionId]: { version: 1, status } },
  createId: () => `new-id-${idCounter++}`,
  randomIndex: () => 0,
});
const zoneFor = (state: ReturnType<typeof makeState>, type: string, ownerPlayerId: string | null) => state.zones.find((zone) => zone.type === type && zone.ownerPlayerId === ownerPlayerId)!;

describe('game state and operations', () => {
  it('creates 11 zones, deals seven cards to each player, and starts with host at 20 life', () => {
    idCounter = 0;
    const state = makeState();
    expect(GameStateSchema.safeParse(state).success).toBe(true);
    expect(state.zones).toHaveLength(11);
    expect(zoneFor(state, 'HAND', 'player-1').cardIds).toHaveLength(7);
    expect(zoneFor(state, 'HAND', 'player-2').cardIds).toHaveLength(7);
    expect(zoneFor(state, 'LIBRARY', 'player-1').cardIds).toHaveLength(53);
    expect(state.players.map(({ life }) => life)).toEqual([20, 20]);
    expect(state.activePlayerId).toBe('player-1');
    expect(state.sequence).toBe(0);
    expect(() => makeState('DISABLED')).toThrow(/disabled/);
  });

  it('rejects invalid zone ownership and phase/step combinations', () => {
    expect(ZoneSchema.safeParse({ zoneId: 'battlefield', ownerPlayerId: 'player-1', type: 'BATTLEFIELD', cardIds: [] }).success).toBe(false);
    const state = makeState();
    expect(GameStateSchema.safeParse({ ...state, phase: 'PRECOMBAT_MAIN', step: 'UNTAP' }).success).toBe(false);
    expect(() => createInitialGameState({ ...{
      gameId: 'g', matchId: 'm', playerIds: ['a', 'b'], hostPlayerId: 'a',
      decks: [{ playerId: 'a', mainboard: [DeckEntrySchema.parse({ cardDefinitionId: definitionId, quantity: 59 })], sideboard: [] }, { playerId: 'b', mainboard: [entry], sideboard: [] }],
      definitions: { [definitionId]: { version: 1, status: 'ENABLED' } }, createId: () => 'x', randomIndex: () => 0,
    } })).toThrow(/at least 60/);
    expect(() => createInitialGameState({
      gameId: 'g', matchId: 'm', playerIds: ['a', 'b'], hostPlayerId: 'a',
      decks: [{ playerId: 'a', mainboard: [entry], sideboard: [DeckEntrySchema.parse({ cardDefinitionId: definitionId, quantity: 16 })] }, { playerId: 'b', mainboard: [entry], sideboard: [] }],
      definitions: { [definitionId]: { version: 1, status: 'ENABLED' } }, createId: () => 'x', randomIndex: () => 0,
    })).toThrow(/at most 15/);
  });

  it('moves cards with zone resets and prevents sending a card to the other owner’s zone', () => {
    idCounter = 0;
    const state = makeState();
    const cardId = zoneFor(state, 'HAND', 'player-1').cardIds[0]!;
    const battlefield = zoneFor(state, 'BATTLEFIELD', null);
    const onBattlefield = moveCard(state, PlayerIdSchema.parse('player-1'), cardId, battlefield.zoneId, { position: { x: 2, y: -1 } });
    expect(onBattlefield.cards[cardId]!.position).toEqual({ x: 2, y: -1 });
    expect(onBattlefield.cards[cardId]!.visibility).toBe('PUBLIC');
    const graveyard = zoneFor(onBattlefield, 'GRAVEYARD', 'player-1');
    const inGraveyard = moveCard(onBattlefield, PlayerIdSchema.parse('player-1'), cardId, graveyard.zoneId);
    expect(inGraveyard.cards[cardId]!.position).toBeNull();
    expect(inGraveyard.cards[cardId]!.visibility).toBe('PUBLIC');
    expect(() => moveCard(state, PlayerIdSchema.parse('player-1'), cardId, zoneFor(state, 'HAND', 'player-2').zoneId)).toThrow(GameOperationError);
  });

  it('enforces controller operations, counter floors, life ownership, and turn positions', () => {
    idCounter = 0;
    const state = makeState();
    const cardId = zoneFor(state, 'HAND', 'player-1').cardIds[0]!;
    expect(() => setCardTapped(state, PlayerIdSchema.parse('player-2'), cardId, true)).toThrow(GameOperationError);
    const battlefield = zoneFor(state, 'BATTLEFIELD', null);
    const positioned = moveCard(state, PlayerIdSchema.parse('player-1'), cardId, battlefield.zoneId, { position: { x: 0, y: 0 } });
    const withCounter = changeCounter(positioned, PlayerIdSchema.parse('player-1'), cardId, 'PLUS_ONE_PLUS_ONE', 2, 'ADD');
    expect(withCounter.cards[cardId]!.counters.plusOnePlusOne).toBe(2);
    expect(() => changeCounter(withCounter, PlayerIdSchema.parse('player-1'), cardId, 'OTHER', 1, 'REMOVE')).toThrow(GameOperationError);
    expect(changeLife(withCounter, PlayerIdSchema.parse('player-1'), -25).players[0]!.life).toBe(-5);
    expect(() => changeTurnPosition(withCounter, PlayerIdSchema.parse('player-2'), 'ENDING', 'END')).toThrow(GameOperationError);
    const ending = changeTurnPosition(withCounter, PlayerIdSchema.parse('player-1'), 'ENDING', 'END');
    const nextTurn = endTurn(ending, PlayerIdSchema.parse('player-1'));
    expect(nextTurn.turnNumber).toBe(2);
    expect(nextTurn.activePlayerId).toBe('player-2');
  });

  it('reorders private zones and moves battlefield cards on the grid', () => {
    idCounter = 0;
    const state = makeState();
    const hand = zoneFor(state, 'HAND', 'player-1');
    const cardId = hand.cardIds[0]!;
    const reordered = reorderCard(state, PlayerIdSchema.parse('player-1'), cardId, hand.cardIds.length);
    expect(zoneFor(reordered, 'HAND', 'player-1').cardIds.at(-1)).toBe(cardId);
    const battlefield = zoneFor(state, 'BATTLEFIELD', null);
    const moved = moveCard(state, PlayerIdSchema.parse('player-1'), cardId, battlefield.zoneId, { position: { x: 1, y: 1 } });
    expect(moveCardPosition(moved, PlayerIdSchema.parse('player-1'), cardId, { x: 5, y: 6 }).cards[cardId]!.position).toEqual({ x: 5, y: 6 });
    expect(ViewStateSchema.safeParse({ viewId: 'view-1', viewerPlayerId: 'player-1', viewType: 'LIBRARY_TOP', sourceZoneId: 'zone-1', viewedCardIds: [], selectedCardIds: [] }).success).toBe(true);
  });

  it('changes controller and visibility, shuffles only owner zones, and records concession without a winner', () => {
    idCounter = 0;
    const state = makeState();
    const cardId = zoneFor(state, 'HAND', 'player-1').cardIds[0]!;
    const battlefield = zoneFor(state, 'BATTLEFIELD', null);
    const onBattlefield = moveCard(state, PlayerIdSchema.parse('player-1'), cardId, battlefield.zoneId, { position: { x: 0, y: 0 } });
    const controlled = changeController(onBattlefield, PlayerIdSchema.parse('player-1'), cardId, PlayerIdSchema.parse('player-2'));
    expect(controlled.cards[cardId]!.ownerPlayerId).toBe('player-1');
    expect(controlled.cards[cardId]!.controllerPlayerId).toBe('player-2');
    const ownerGraveyard = zoneFor(controlled, 'GRAVEYARD', 'player-1');
    const returned = moveCard(controlled, PlayerIdSchema.parse('player-2'), cardId, ownerGraveyard.zoneId);
    expect(returned.cards[cardId]!.controllerPlayerId).toBe('player-1');
    const privateCard = zoneFor(controlled, 'HAND', 'player-1').cardIds[0]!;
    expect(changeVisibility(controlled, PlayerIdSchema.parse('player-1'), privateCard, 'PUBLIC').cards[privateCard]!.visibility).toBe('PUBLIC');
    const faceDown = turnFaceDown(controlled, PlayerIdSchema.parse('player-2'), cardId);
    expect(faceDown.cards[cardId]!.faceDown).toBe(true);
    expect(turnFaceUp(faceDown, PlayerIdSchema.parse('player-2'), cardId).cards[cardId]!.faceDown).toBe(false);
    const library = zoneFor(controlled, 'LIBRARY', 'player-1');
    const shuffled = shuffleZone(controlled, PlayerIdSchema.parse('player-1'), library.zoneId, () => 0);
    expect(shuffled.zones.find(({ zoneId }) => zoneId === library.zoneId)!.cardIds).toHaveLength(53);
    expect(() => shuffleZone(controlled, PlayerIdSchema.parse('player-2'), library.zoneId, () => 0)).toThrow(GameOperationError);
    const finished = concede(controlled, PlayerIdSchema.parse('player-1'));
    expect(finished.status).toBe('FINISHED');
    expect('winnerPlayerId' in finished).toBe(false);
  });
});
