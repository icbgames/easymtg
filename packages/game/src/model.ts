import { z, GameIdSchema, GameCardIdSchema, MatchIdSchema, PlayerIdSchema, ZoneIdSchema, CardDefinitionIdSchema, ViewTypeSchema } from '@easymtg/shared';

export const GameStatusSchema = z.enum(['WAITING', 'PLAYING', 'FINISHED', 'ABANDONED']);
export const GamePhaseSchema = z.enum(['BEGINNING', 'PRECOMBAT_MAIN', 'COMBAT', 'POSTCOMBAT_MAIN', 'ENDING']);
export const GameStepSchema = z.enum(['UNTAP', 'UPKEEP', 'DRAW', 'BEGIN_COMBAT', 'DECLARE_ATTACKERS', 'DECLARE_BLOCKERS', 'COMBAT_DAMAGE', 'END_COMBAT', 'END', 'CLEANUP']);
export const ZoneTypeSchema = z.enum(['LIBRARY', 'HAND', 'BATTLEFIELD', 'GRAVEYARD', 'EXILE', 'SIDEBOARD']);
export const VisibilitySchema = z.enum(['PUBLIC', 'CONTROLLER_ONLY', 'HIDDEN']);
export const PositionSchema = z.object({ x: z.number().int(), y: z.number().int() });
export const CountersSchema = z.object({ plusOnePlusOne: z.number().int().nonnegative(), other: z.number().int().nonnegative() });

export const ZoneSchema = z.object({
  zoneId: ZoneIdSchema,
  type: ZoneTypeSchema,
  ownerPlayerId: PlayerIdSchema.nullable(),
  cardIds: z.array(GameCardIdSchema),
}).superRefine((zone, context) => {
  if ((zone.type === 'BATTLEFIELD') !== (zone.ownerPlayerId === null)) {
    context.addIssue({ code: 'custom', path: ['ownerPlayerId'], message: 'Only the shared battlefield has no owner.' });
  }
});

export const PlayerStateSchema = z.object({ playerId: PlayerIdSchema, life: z.number().int() });

export const CardInstanceSchema = z.object({
  cardId: GameCardIdSchema,
  cardDefinitionId: CardDefinitionIdSchema,
  cardDefinitionVersion: z.number().int().positive(),
  ownerPlayerId: PlayerIdSchema,
  controllerPlayerId: PlayerIdSchema,
  tapped: z.boolean(),
  faceDown: z.boolean(),
  position: PositionSchema.nullable(),
  counters: CountersSchema,
  visibility: VisibilitySchema,
});

export const GameStateSchema = z.object({
  gameId: GameIdSchema,
  matchId: MatchIdSchema,
  status: GameStatusSchema,
  turnNumber: z.number().int().positive(),
  activePlayerId: PlayerIdSchema,
  phase: GamePhaseSchema,
  step: GameStepSchema.nullable(),
  players: z.array(PlayerStateSchema).length(2),
  cards: z.record(z.string(), CardInstanceSchema),
  zones: z.array(ZoneSchema),
  sequence: z.number().int().nonnegative(),
}).superRefine((state, context) => {
  const players = state.players.map(({ playerId }) => playerId);
  if (new Set(players).size !== 2 || !players.includes(state.activePlayerId)) {
    context.addIssue({ code: 'custom', path: ['players'], message: 'Game must have two distinct players and an active player from that set.' });
  }
  const validStepByPhase: Record<z.infer<typeof GamePhaseSchema>, Array<z.infer<typeof GameStepSchema> | null>> = {
    BEGINNING: ['UNTAP', 'UPKEEP', 'DRAW'], PRECOMBAT_MAIN: [null],
    COMBAT: ['BEGIN_COMBAT', 'DECLARE_ATTACKERS', 'DECLARE_BLOCKERS', 'COMBAT_DAMAGE', 'END_COMBAT'],
    POSTCOMBAT_MAIN: [null], ENDING: ['END', 'CLEANUP'],
  };
  if (!validStepByPhase[state.phase].includes(state.step)) {
    context.addIssue({ code: 'custom', path: ['step'], message: 'Step is not valid for the current phase.' });
  }

  const zones = new Map(state.zones.map((zone) => [zone.zoneId, zone]));
  if (zones.size !== state.zones.length) {
    context.addIssue({ code: 'custom', path: ['zones'], message: 'Zone IDs must be unique.' });
  }
  const expectedZoneTypes = ['LIBRARY', 'HAND', 'GRAVEYARD', 'EXILE', 'SIDEBOARD'] as const;
  if (state.zones.length !== 11 || state.zones.filter(({ type }) => type === 'BATTLEFIELD').length !== 1 ||
      expectedZoneTypes.some((type) => state.players.some(({ playerId }) => state.zones.filter((zone) => zone.type === type && zone.ownerPlayerId === playerId).length !== 1))) {
    context.addIssue({ code: 'custom', path: ['zones'], message: 'Game must contain one battlefield and one of each private zone per player.' });
  }
  const references = new Set<string>();
  for (const zone of state.zones) {
    for (const cardId of zone.cardIds) {
      if (references.has(cardId)) context.addIssue({ code: 'custom', path: ['zones'], message: 'A card may occur in only one zone.' });
      references.add(cardId);
      const card = state.cards[cardId];
      if (!card) context.addIssue({ code: 'custom', path: ['zones'], message: `Zone references missing card ${cardId}.` });
      else if (zone.type !== 'BATTLEFIELD' && zone.ownerPlayerId !== card.ownerPlayerId) {
        context.addIssue({ code: 'custom', path: ['zones'], message: 'Non-battlefield cards must be in their owner’s zone.' });
      }
      if (card && ((zone.type === 'BATTLEFIELD') !== (card.position !== null))) {
        context.addIssue({ code: 'custom', path: ['cards', cardId, 'position'], message: 'Only battlefield cards have a position.' });
      }
    }
  }
  for (const [cardId, card] of Object.entries(state.cards)) {
    if (card.cardId !== cardId) context.addIssue({ code: 'custom', path: ['cards', cardId], message: 'Card map key must match cardId.' });
    if (!references.has(cardId)) context.addIssue({ code: 'custom', path: ['cards', cardId], message: 'Every card must belong to exactly one zone.' });
    if (!players.includes(card.ownerPlayerId) || !players.includes(card.controllerPlayerId)) {
      context.addIssue({ code: 'custom', path: ['cards', cardId], message: 'Card owner and controller must be game players.' });
    }
  }
  for (const zone of state.zones) {
    if (zone.ownerPlayerId !== null && !players.includes(zone.ownerPlayerId)) {
      context.addIssue({ code: 'custom', path: ['zones'], message: 'Zone owner must be a game player.' });
    }
  }
});

// ViewState is temporary per-viewer state and never part of canonical GameState.
export const ViewStateSchema = z.object({
  viewId: z.string().trim().min(1),
  viewerPlayerId: PlayerIdSchema,
  viewType: ViewTypeSchema,
  sourceZoneId: ZoneIdSchema,
  viewedCardIds: z.array(GameCardIdSchema),
  selectedCardIds: z.array(GameCardIdSchema).optional(),
});

const CardViewStateSchema = z.object({
  ownerPlayerId: PlayerIdSchema,
  controllerPlayerId: PlayerIdSchema,
  tapped: z.boolean(),
  faceDown: z.boolean(),
  position: PositionSchema.nullable(),
  counters: CountersSchema,
}).strict();

export const IdentifiedGameCardViewSchema = CardViewStateSchema.extend({
  cardId: GameCardIdSchema,
  cardDefinitionId: CardDefinitionIdSchema,
  cardDefinitionVersion: z.number().int().positive(),
}).strict();

export const HiddenGameCardViewSchema = CardViewStateSchema.strict();
export const GameCardViewSchema = z.union([IdentifiedGameCardViewSchema, HiddenGameCardViewSchema]);

export const GameStateViewSchema = z.object({
  gameId: GameIdSchema,
  matchId: MatchIdSchema,
  status: GameStatusSchema,
  turnNumber: z.number().int().positive(),
  activePlayerId: PlayerIdSchema,
  phase: GamePhaseSchema,
  step: GameStepSchema.nullable(),
  sequence: z.number().int().nonnegative(),
  players: z.array(PlayerStateSchema).length(2),
  zones: z.array(z.object({
    zoneId: ZoneIdSchema,
    type: ZoneTypeSchema,
    ownerPlayerId: PlayerIdSchema.nullable(),
    cards: z.array(GameCardViewSchema),
  }).strict()),
}).strict();

export type GameStatus = z.infer<typeof GameStatusSchema>;
export type GamePhase = z.infer<typeof GamePhaseSchema>;
export type GameStep = z.infer<typeof GameStepSchema>;
export type ZoneType = z.infer<typeof ZoneTypeSchema>;
export type Visibility = z.infer<typeof VisibilitySchema>;
export type Position = z.infer<typeof PositionSchema>;
export type Counters = z.infer<typeof CountersSchema>;
export type Zone = z.infer<typeof ZoneSchema>;
export type PlayerState = z.infer<typeof PlayerStateSchema>;
export type CardInstance = z.infer<typeof CardInstanceSchema>;
export type GameState = z.infer<typeof GameStateSchema>;
export type ViewState = z.infer<typeof ViewStateSchema>;
export type GameCardView = z.infer<typeof GameCardViewSchema>;
export type IdentifiedGameCardView = z.infer<typeof IdentifiedGameCardViewSchema>;
export type GameStateView = z.infer<typeof GameStateViewSchema>;
