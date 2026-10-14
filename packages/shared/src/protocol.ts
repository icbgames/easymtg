import { z } from 'zod';
import { CardDefinitionIdSchema, DeckIdSchema, GameIdSchema, MatchIdSchema, PlayerIdSchema, RoomIdSchema } from './ids.js';

export const CommandErrorCodeSchema = z.enum([
  'INVALID_ENVELOPE',
  'COMMAND_ID_CONFLICT',
  'VIEW_NOT_FOUND',
  'VIEW_CARD_NOT_FOUND',
  'VIEW_ACCESS_DENIED',
  'INVALID_VIEW_ORDER',
  'INVALID_VIEW_SELECTION',
  'VIEW_STALE',
  'INVALID_PAYLOAD',
  'UNKNOWN_COMMAND',
  'GAME_NOT_FOUND',
  'GAME_NOT_PLAYING',
  'PLAYERS_NOT_CONNECTED',
  'FORBIDDEN',
  'CARD_NOT_FOUND',
  'ZONE_NOT_FOUND',
  'SAME_ZONE',
  'INVALID_DESTINATION',
  'INVALID_POSITION',
  'INVALID_INDEX',
  'INVALID_ZONE',
  'INVALID_AMOUNT',
  'COUNTER_UNDERFLOW',
  'INVALID_CONTROLLER',
  'INVALID_VISIBILITY',
  'INVALID_TURN_POSITION',
  'INVALID_STATE',
  'INVALID_STATE_TRANSITION',
  'INVALID_RANDOM_SOURCE',
  'INTERNAL_ERROR',
]);

export const CommandIdSchema = z.string().trim().min(1);

export const HttpErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'INVALID_PAGE',
  'INVALID_IMAGE_URL',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CARD_DEFINITION_NOT_FOUND',
  'CARD_DEFINITION_ID_ALREADY_EXISTS',
  'CARD_DEFINITION_VERSION_CONFLICT',
  'DECK_IN_USE',
  'REQUEST_ID_CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'ACTIVE_ROOM_EXISTS',
  'ROOM_NOT_FOUND',
  'ROOM_NOT_WAITING',
  'ROOM_FULL',
  'ROOM_IN_MATCH',
  'PLAYER_NOT_IN_ROOM',
  'DECK_NOT_FOUND',
  'DECK_INVALID',
  'CARD_UNAVAILABLE',
  'MATCH_NOT_ACTIVE',
  'GAME_STILL_ACTIVE',
  'GAME_NOT_ACTIVE',
  'ALL_GAMES_COMPLETE',
  'PLAYERS_NOT_READY',
  'INTERNAL_ERROR',
]);

export const HTTP_STATUS_BY_ERROR_CODE = {
  INVALID_REQUEST: 400,
  INVALID_PAGE: 400,
  INVALID_IMAGE_URL: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CARD_DEFINITION_NOT_FOUND: 404,
  CARD_DEFINITION_ID_ALREADY_EXISTS: 409,
  CARD_DEFINITION_VERSION_CONFLICT: 409,
  DECK_IN_USE: 409,
  REQUEST_ID_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  ACTIVE_ROOM_EXISTS: 409,
  ROOM_NOT_WAITING: 409,
  ROOM_FULL: 409,
  ROOM_IN_MATCH: 409,
  MATCH_NOT_ACTIVE: 409,
  GAME_STILL_ACTIVE: 409,
  GAME_NOT_ACTIVE: 409,
  ALL_GAMES_COMPLETE: 409,
  PLAYERS_NOT_READY: 409,
  ROOM_NOT_FOUND: 404,
  PLAYER_NOT_IN_ROOM: 404,
  DECK_NOT_FOUND: 404,
  DECK_INVALID: 400,
  CARD_UNAVAILABLE: 400,
  INTERNAL_ERROR: 500,
} as const satisfies Record<z.infer<typeof HttpErrorCodeSchema>, number>;

export const DeckWriteSchema = z.object({
  name: z.string().trim().min(1).max(100),
  mainboard: z.array(CardDefinitionIdSchema).min(60),
  sideboard: z.array(CardDefinitionIdSchema).max(15).default([]),
}).strict();
export const DeckListResponseSchema = z.array(z.object({
  id: DeckIdSchema,
  name: z.string().trim().min(1).max(100),
  mainboardCount: z.number().int().nonnegative(),
  sideboardCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict());
export const DeckResponseSchema = z.object({
  id: DeckIdSchema,
  name: z.string().trim().min(1).max(100),
  mainboard: z.array(CardDefinitionIdSchema).min(60),
  sideboard: z.array(CardDefinitionIdSchema).max(15),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export const NextGameDeckSchema = z.object({
  mainboard: z.array(CardDefinitionIdSchema).min(60),
  sideboard: z.array(CardDefinitionIdSchema).max(15),
}).strict();

export const HttpErrorResponseSchema = z.object({
  error: z.object({
    code: HttpErrorCodeSchema,
    message: z.string().min(1),
  }).strict(),
}).strict();

export const CommandEnvelopeSchema = z.object({
  type: z.string().trim().min(1),
  commandId: CommandIdSchema,
  payload: z.unknown().optional(),
}).strict();

export const CommandResultSchema = z.object({
  type: z.literal('CommandResult'),
  commandId: z.string().trim().min(1),
  success: z.boolean(),
  errorCode: CommandErrorCodeSchema.optional(),
}).superRefine((result, context) => {
  if (result.success === (result.errorCode !== undefined)) {
    context.addIssue({ code: 'custom', path: ['errorCode'], message: 'Successful results omit errorCode; failures require it.' });
  }
});

export const GameEventSchema = z.object({
  type: z.literal('GameEvent'),
  eventId: z.string().uuid(),
  gameId: GameIdSchema,
  sequence: z.number().int().positive(),
  eventType: z.string().trim().min(1),
  payload: z.unknown(),
});

export const HelloSchema = z.object({
  type: z.literal('Hello'), protocolVersion: z.literal(1),
  lastGameId: GameIdSchema.nullable(), lastSequence: z.number().int().nonnegative().nullable(),
}).strict().superRefine((hello, context) => {
  if ((hello.lastGameId === null) !== (hello.lastSequence === null)) {
    context.addIssue({ code: 'custom', path: ['lastSequence'], message: 'lastGameId and lastSequence must both be null or both be present.' });
  }
});

export const PongSchema = z.object({ type: z.literal('Pong'), nonce: z.string().uuid() }).strict();
export const ClientMessageSchema = z.union([HelloSchema, PongSchema, CommandEnvelopeSchema]);

export const WelcomeSchema = z.object({ type: z.literal('Welcome'), protocolVersion: z.literal(1) }).strict();
export const PingSchema = z.object({ type: z.literal('Ping'), nonce: z.string().uuid() }).strict();
export const RoomStateSyncSchema = z.object({
  type: z.literal('RoomStateSync'),
  room: z.object({
    roomId: RoomIdSchema, status: z.enum(['WAITING', 'IN_MATCH']), ownerPlayerId: PlayerIdSchema,
    participants: z.array(z.object({ playerId: PlayerIdSchema, connectionState: z.enum(['CONNECTED', 'DISCONNECTED']) }).strict()).min(1).max(2),
    matchId: MatchIdSchema.optional(),
  }).strict().nullable(),
}).strict();
export const MatchStateSyncSchema = z.object({
  type: z.literal('MatchStateSync'),
  match: z.object({
    matchId: MatchIdSchema, status: z.enum(['ACTIVE', 'ENDED']), currentGameNumber: z.number().int().min(1).max(5), activeGameId: GameIdSchema.optional(),
  }).strict().nullable(),
}).strict();
export const InitialStateSchema = z.object({ type: z.literal('InitialState'), gameId: GameIdSchema, sequence: z.number().int().nonnegative(), gameStateView: z.unknown() }).strict();

const LifecycleBase = { eventId: z.string().uuid(), roomId: RoomIdSchema };
export const LifecycleEventSchema = z.discriminatedUnion('type', [
  z.object({ ...LifecycleBase, type: z.literal('RoomPlayerJoined'), playerId: PlayerIdSchema }).strict(),
  z.object({ ...LifecycleBase, type: z.literal('RoomPlayerLeft'), playerId: PlayerIdSchema }).strict(),
  z.object({ ...LifecycleBase, type: z.literal('RoomOwnerChanged'), ownerPlayerId: PlayerIdSchema }).strict(),
  z.object({ ...LifecycleBase, type: z.literal('PlayerConnected'), playerId: PlayerIdSchema, connectionState: z.literal('CONNECTED') }).strict(),
  z.object({ ...LifecycleBase, type: z.literal('PlayerDisconnected'), playerId: PlayerIdSchema, connectionState: z.literal('DISCONNECTED') }).strict(),
  z.object({ ...LifecycleBase, type: z.literal('GameStarted'), matchId: MatchIdSchema, gameId: GameIdSchema, gameNumber: z.number().int().min(1).max(5) }).strict(),
  z.object({ ...LifecycleBase, type: z.literal('GameEnded'), matchId: MatchIdSchema, gameId: GameIdSchema, gameNumber: z.number().int().min(1).max(5), gameStatus: z.enum(['FINISHED', 'ABANDONED']) }).strict(),
  z.object({ ...LifecycleBase, type: z.literal('MatchEnded'), matchId: MatchIdSchema, gameNumber: z.literal(5) }).strict(),
]);
export const ViewStateMessageSchema = z.object({ type: z.enum(['ViewStateStarted', 'ViewStatePrivate', 'ViewStateEnded', 'ViewStateSync']), payload: z.unknown() }).strict();
export const ServerMessageSchema = z.union([
  WelcomeSchema, PingSchema, CommandResultSchema, GameEventSchema, LifecycleEventSchema,
  RoomStateSyncSchema, MatchStateSyncSchema, InitialStateSchema, ViewStateMessageSchema,
]);

export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;
export type CommandResult = z.infer<typeof CommandResultSchema>;
export type GameEvent = z.infer<typeof GameEventSchema>;
export type Hello = z.infer<typeof HelloSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type CommandErrorCode = z.infer<typeof CommandErrorCodeSchema>;
export type HttpErrorCode = z.infer<typeof HttpErrorCodeSchema>;
export type HttpErrorResponse = z.infer<typeof HttpErrorResponseSchema>;
