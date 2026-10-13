import { z } from 'zod';
import { GameCardIdSchema, PlayerIdSchema, ViewIdSchema, ZoneIdSchema } from './ids.js';

const PositionPayloadSchema = z.object({ x: z.number().int(), y: z.number().int() }).strict();
const CardIdPayloadSchema = z.object({ cardId: GameCardIdSchema }).strict();
export const ViewTypeSchema = z.enum(['LIBRARY_TOP', 'LIBRARY_SEARCH', 'ZONE_VIEW']);

export const MoveCardPayloadSchema = z.object({
  cardId: GameCardIdSchema,
  destinationZoneId: ZoneIdSchema,
  position: PositionPayloadSchema.optional(),
  insertIndex: z.number().int().nonnegative().optional(),
}).strict().superRefine((payload, context) => {
  if (payload.position !== undefined && payload.insertIndex !== undefined) {
    context.addIssue({ code: 'custom', path: ['insertIndex'], message: 'position and insertIndex cannot be supplied together.' });
  }
});

export const ReorderCardPayloadSchema = z.object({
  cardId: GameCardIdSchema,
  insertIndex: z.number().int().nonnegative(),
}).strict();

export const TapCardPayloadSchema = CardIdPayloadSchema;
export const UntapCardPayloadSchema = CardIdPayloadSchema;
export const TurnFaceDownPayloadSchema = CardIdPayloadSchema;
export const TurnFaceUpPayloadSchema = CardIdPayloadSchema;

export const CounterTypeSchema = z.enum(['PLUS_ONE_PLUS_ONE', 'OTHER']);
export const AddCounterPayloadSchema = z.object({
  cardId: GameCardIdSchema,
  counterType: CounterTypeSchema,
  amount: z.number().int().positive(),
}).strict();
export const RemoveCounterPayloadSchema = AddCounterPayloadSchema;

export const ChangeControllerPayloadSchema = z.object({
  cardId: GameCardIdSchema,
  controllerPlayerId: PlayerIdSchema,
}).strict();
export const ChangeVisibilityPayloadSchema = z.object({
  cardId: GameCardIdSchema,
  visibility: z.enum(['PUBLIC', 'CONTROLLER_ONLY', 'HIDDEN']),
}).strict();
export const MoveCardPositionPayloadSchema = z.object({
  cardId: GameCardIdSchema,
  position: PositionPayloadSchema,
}).strict();
export const ChangeLifePayloadSchema = z.object({ amount: z.number().int() }).strict();
export const ShuffleZonePayloadSchema = z.object({ zoneId: ZoneIdSchema }).strict();
export const ChangeTurnPositionPayloadSchema = z.object({
  phase: z.enum(['BEGINNING', 'PRECOMBAT_MAIN', 'COMBAT', 'POSTCOMBAT_MAIN', 'ENDING']),
  step: z.enum(['UNTAP', 'UPKEEP', 'DRAW', 'BEGIN_COMBAT', 'DECLARE_ATTACKERS', 'DECLARE_BLOCKERS', 'COMBAT_DAMAGE', 'END_COMBAT', 'END', 'CLEANUP']).nullable(),
}).strict();

// The envelope omits payload for commands that have no user-supplied parameters.
export const NoCommandPayloadSchema = z.undefined();

export const StartViewPayloadSchema = z.object({
  sourceZoneId: ZoneIdSchema,
  viewType: ViewTypeSchema,
  count: z.number().int().positive().optional(),
}).strict().superRefine((payload, context) => {
  if (payload.viewType === 'LIBRARY_TOP' && payload.count === undefined) {
    context.addIssue({ code: 'custom', path: ['count'], message: 'LIBRARY_TOP requires a positive count.' });
  }
  if (payload.viewType !== 'LIBRARY_TOP' && payload.count !== undefined) {
    context.addIssue({ code: 'custom', path: ['count'], message: 'count is only valid for LIBRARY_TOP.' });
  }
});

export const SelectViewCardPayloadSchema = z.object({
  viewId: ViewIdSchema,
  cardId: GameCardIdSchema,
  selected: z.boolean(),
}).strict();
export const ReorderViewCardsPayloadSchema = z.object({
  viewId: ViewIdSchema,
  cardIds: z.array(GameCardIdSchema),
}).strict();
export const ConfirmViewPayloadSchema = z.object({
  viewId: ViewIdSchema,
  moves: z.array(z.object({
    cardId: GameCardIdSchema,
    destinationZoneId: ZoneIdSchema,
    position: PositionPayloadSchema.optional(),
    insertIndex: z.number().int().nonnegative().optional(),
  }).strict()).default([]),
}).strict().superRefine((payload, context) => {
  payload.moves.forEach((move, index) => {
    if (move.position !== undefined && move.insertIndex !== undefined) {
      context.addIssue({ code: 'custom', path: ['moves', index, 'insertIndex'], message: 'position and insertIndex cannot be supplied together.' });
    }
  });
});
export const ViewIdPayloadSchema = z.object({ viewId: ViewIdSchema }).strict();

export const GameCommandPayloadSchemas = {
  MoveCard: MoveCardPayloadSchema,
  ReorderCard: ReorderCardPayloadSchema,
  TapCard: TapCardPayloadSchema,
  UntapCard: UntapCardPayloadSchema,
  TurnFaceDown: TurnFaceDownPayloadSchema,
  TurnFaceUp: TurnFaceUpPayloadSchema,
  AddCounter: AddCounterPayloadSchema,
  RemoveCounter: RemoveCounterPayloadSchema,
  ChangeController: ChangeControllerPayloadSchema,
  ChangeVisibility: ChangeVisibilityPayloadSchema,
  MoveCardPosition: MoveCardPositionPayloadSchema,
  ChangeLife: ChangeLifePayloadSchema,
  ShuffleZone: ShuffleZonePayloadSchema,
  ChangeTurnPosition: ChangeTurnPositionPayloadSchema,
  EndTurn: NoCommandPayloadSchema,
  Concede: NoCommandPayloadSchema,
  StartView: StartViewPayloadSchema,
  SelectViewCard: SelectViewCardPayloadSchema,
  ReorderViewCards: ReorderViewCardsPayloadSchema,
  ConfirmView: ConfirmViewPayloadSchema,
  CancelView: ViewIdPayloadSchema,
} as const;

export type MoveCardPayload = z.infer<typeof MoveCardPayloadSchema>;
export type ReorderCardPayload = z.infer<typeof ReorderCardPayloadSchema>;
export type AddCounterPayload = z.infer<typeof AddCounterPayloadSchema>;
export type RemoveCounterPayload = z.infer<typeof RemoveCounterPayloadSchema>;
export type ChangeControllerPayload = z.infer<typeof ChangeControllerPayloadSchema>;
export type ChangeVisibilityPayload = z.infer<typeof ChangeVisibilityPayloadSchema>;
export type MoveCardPositionPayload = z.infer<typeof MoveCardPositionPayloadSchema>;
export type ChangeLifePayload = z.infer<typeof ChangeLifePayloadSchema>;
export type ShuffleZonePayload = z.infer<typeof ShuffleZonePayloadSchema>;
export type ChangeTurnPositionPayload = z.infer<typeof ChangeTurnPositionPayloadSchema>;
export type StartViewPayload = z.infer<typeof StartViewPayloadSchema>;
export type ViewType = z.infer<typeof ViewTypeSchema>;
export type SelectViewCardPayload = z.infer<typeof SelectViewCardPayloadSchema>;
export type ReorderViewCardsPayload = z.infer<typeof ReorderViewCardsPayloadSchema>;
export type ConfirmViewPayload = z.infer<typeof ConfirmViewPayloadSchema>;
