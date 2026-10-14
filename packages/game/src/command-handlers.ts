import { randomInt } from 'node:crypto';
import {
  GameCommandPayloadSchemas,
  type PlayerId,
} from '@easymtg/shared';
import type { GameState } from './model.js';
import {
  changeController,
  changeLife,
  changeTurnPosition,
  changeVisibility,
  concede,
  endTurn,
  moveCard,
  moveCardPosition,
  reorderCard,
  setCardTapped,
  shuffleZone,
  turnFaceDown,
  turnFaceUp,
  changeCounter,
} from './operations.js';
import { GameCommandProcessor, type CommandApplication } from './command-processor.js';
import { registerViewStateCommandHandlers } from './view-state.js';

type PayloadSchema<Payload> = {
  parse(value: unknown): Payload;
  safeParse(value: unknown): { success: true; data: Payload } | { success: false };
};

/** Registers the Phase 3 GameState operations against the finalized Phase 4 payload schemas. */
export function registerGameCommandHandlers(
  processor: GameCommandProcessor,
  randomIndex: (maxExclusive: number) => number = randomInt,
) {
  const register = <Payload>(
    type: string,
    schema: PayloadSchema<Payload>,
    apply: (state: GameState, actor: PlayerId, payload: Payload) => GameState,
    eventExtra?: (state: GameState, payload: Payload) => Record<string, unknown>,
  ) => {
    processor.registerHandler(type, {
      payloadSchema: schema,
      execute: (state, actorPlayerId, untrustedPayload): CommandApplication => {
        const payload = schema.parse(untrustedPayload);
        const next = apply(state, actorPlayerId, payload);
        return {
          state: next,
          eventType: `${type}Applied`,
          payload: {
            actorPlayerId,
            commandPayload: payload ?? null,
            ...eventExtra?.(next, payload),
          },
        };
      },
    });
  };

  register('MoveCard', GameCommandPayloadSchemas.MoveCard, (state, actor, payload) =>
    moveCard(state, actor, payload.cardId, payload.destinationZoneId, {
      ...(payload.position === undefined ? {} : { position: payload.position }),
      ...(payload.insertIndex === undefined ? {} : { insertIndex: payload.insertIndex }),
    }));
  register('ReorderCard', GameCommandPayloadSchemas.ReorderCard, (state, actor, payload) =>
    reorderCard(state, actor, payload.cardId, payload.insertIndex));
  register('TapCard', GameCommandPayloadSchemas.TapCard, (state, actor, payload) =>
    setCardTapped(state, actor, payload.cardId, true));
  register('UntapCard', GameCommandPayloadSchemas.UntapCard, (state, actor, payload) =>
    setCardTapped(state, actor, payload.cardId, false));
  register('TurnFaceDown', GameCommandPayloadSchemas.TurnFaceDown, (state, actor, payload) =>
    turnFaceDown(state, actor, payload.cardId));
  register('TurnFaceUp', GameCommandPayloadSchemas.TurnFaceUp, (state, actor, payload) =>
    turnFaceUp(state, actor, payload.cardId));
  register('AddCounter', GameCommandPayloadSchemas.AddCounter, (state, actor, payload) =>
    changeCounter(state, actor, payload.cardId, payload.counterType, payload.amount, 'ADD'));
  register('RemoveCounter', GameCommandPayloadSchemas.RemoveCounter, (state, actor, payload) =>
    changeCounter(state, actor, payload.cardId, payload.counterType, payload.amount, 'REMOVE'));
  register('ChangeController', GameCommandPayloadSchemas.ChangeController, (state, actor, payload) =>
    changeController(state, actor, payload.cardId, payload.controllerPlayerId));
  register('ChangeVisibility', GameCommandPayloadSchemas.ChangeVisibility, (state, actor, payload) =>
    changeVisibility(state, actor, payload.cardId, payload.visibility));
  register('MoveCardPosition', GameCommandPayloadSchemas.MoveCardPosition, (state, actor, payload) =>
    moveCardPosition(state, actor, payload.cardId, payload.position));
  register('ChangeLife', GameCommandPayloadSchemas.ChangeLife, (state, actor, payload) =>
    changeLife(state, actor, payload.amount));
  register('ShuffleZone', GameCommandPayloadSchemas.ShuffleZone,
    (state, actor, payload) => shuffleZone(state, actor, payload.zoneId, randomIndex),
    (state, payload) => ({ cardIds: state.zones.find(({ zoneId }) => zoneId === payload.zoneId)!.cardIds }));
  register('ChangeTurnPosition', GameCommandPayloadSchemas.ChangeTurnPosition, (state, actor, payload) =>
    changeTurnPosition(state, actor, payload.phase, payload.step));
  register('EndTurn', GameCommandPayloadSchemas.EndTurn, (state, actor) => endTurn(state, actor));
  register('Concede', GameCommandPayloadSchemas.Concede, (state, actor) => concede(state, actor));
  registerViewStateCommandHandlers(processor);
}

/** Creates a processor with all Phase 4 Game operation handlers registered. */
export function createGameCommandProcessor(randomIndex: (maxExclusive: number) => number = randomInt) {
  const processor = new GameCommandProcessor();
  registerGameCommandHandlers(processor, randomIndex);
  return processor;
}
