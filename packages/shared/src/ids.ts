import { z } from 'zod';

function opaqueId<Name extends string>() {
  return z.string().trim().min(1).brand<Name>();
}

export const UserIdSchema = opaqueId<'UserId'>();
export const PlayerIdSchema = opaqueId<'PlayerId'>();
export const SessionIdSchema = opaqueId<'SessionId'>();
export const RoomIdSchema = opaqueId<'RoomId'>();
export const MatchIdSchema = opaqueId<'MatchId'>();
export const GameIdSchema = opaqueId<'GameId'>();
export const GameCardIdSchema = opaqueId<'GameCardId'>();
export const ZoneIdSchema = opaqueId<'ZoneId'>();
export const DeckIdSchema = opaqueId<'DeckId'>();
export const ViewIdSchema = opaqueId<'ViewId'>();

export const CardDefinitionIdSchema = z.string().regex(/^[A-Z0-9]{3}\d{3}$/, {
  message: 'Card definition IDs must contain three uppercase alphanumeric characters and three digits.',
}).brand<'CardDefinitionId'>();

export const CardDefinitionIdInputSchema = z.string().regex(/^[A-Za-z0-9]{3}\d{3}$/);

export type UserId = z.infer<typeof UserIdSchema>;
export type PlayerId = z.infer<typeof PlayerIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type RoomId = z.infer<typeof RoomIdSchema>;
export type MatchId = z.infer<typeof MatchIdSchema>;
export type GameId = z.infer<typeof GameIdSchema>;
export type GameCardId = z.infer<typeof GameCardIdSchema>;
export type ZoneId = z.infer<typeof ZoneIdSchema>;
export type DeckId = z.infer<typeof DeckIdSchema>;
export type ViewId = z.infer<typeof ViewIdSchema>;
export type CardDefinitionId = z.infer<typeof CardDefinitionIdSchema>;
