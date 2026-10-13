import { z } from 'zod';
import { DeckIdSchema, GameIdSchema, MatchIdSchema, PlayerIdSchema, RoomIdSchema, SessionIdSchema, UserIdSchema } from './ids.js';

export const ConnectionStateSchema = z.enum(['CONNECTED', 'DISCONNECTED']);
export const RoomStatusSchema = z.enum(['WAITING', 'IN_MATCH']);
export const GameStatusSchema = z.enum(['WAITING', 'PLAYING', 'FINISHED', 'ABANDONED']);
export const GameNumberSchema = z.number().int().min(1).max(5);

export const UserSchema = z.object({
  id: UserIdSchema,
  displayName: z.string().trim().min(1),
  createdAt: z.string().datetime({ offset: true }),
});

export const PlayerSchema = z.object({
  id: PlayerIdSchema,
  userId: UserIdSchema,
  displayName: z.string().trim().min(1),
});

export const SessionSchema = z.object({
  id: SessionIdSchema,
  userId: UserIdSchema,
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
});

export const RoomParticipantSchema = z.object({
  playerId: PlayerIdSchema,
  deckId: DeckIdSchema,
  connectionState: ConnectionStateSchema,
});

export const RoomSchema = z.object({
  id: RoomIdSchema,
  ownerPlayerId: PlayerIdSchema,
  status: RoomStatusSchema,
  matchId: MatchIdSchema.optional(),
  participants: z.array(RoomParticipantSchema).max(2),
  createdAt: z.string().datetime({ offset: true }),
}).superRefine((room, context) => {
  const playerIds = room.participants.map(({ playerId }) => playerId);
  if (new Set(playerIds).size !== playerIds.length) {
    context.addIssue({ code: 'custom', path: ['participants'], message: 'Room participants must be unique.' });
  }
  if (!playerIds.includes(room.ownerPlayerId)) {
    context.addIssue({ code: 'custom', path: ['ownerPlayerId'], message: 'Room owner must be a participant.' });
  }
  if ((room.status === 'IN_MATCH') !== (room.matchId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['matchId'], message: 'matchId must be present exactly while the Room is in a Match.' });
  }
});

export const MatchStatusSchema = z.enum(['ACTIVE', 'ENDED']);

export const MatchSchema = z.object({
  id: MatchIdSchema,
  roomId: RoomIdSchema,
  playerIds: z.array(PlayerIdSchema).length(2),
  status: MatchStatusSchema,
  currentGameNumber: GameNumberSchema,
  activeGameId: GameIdSchema.optional(),
  createdAt: z.string().datetime({ offset: true }),
});

export const GameSchema = z.object({
  id: GameIdSchema,
  matchId: MatchIdSchema,
  number: GameNumberSchema,
  status: GameStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
});

export function derivePlayerConnectionState(hasActiveSession: boolean) {
  return hasActiveSession ? 'CONNECTED' as const : 'DISCONNECTED' as const;
}

export type ConnectionState = z.infer<typeof ConnectionStateSchema>;
export type RoomStatus = z.infer<typeof RoomStatusSchema>;
export type GameStatus = z.infer<typeof GameStatusSchema>;
export type User = z.infer<typeof UserSchema>;
export type Player = z.infer<typeof PlayerSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type RoomParticipant = z.infer<typeof RoomParticipantSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type MatchStatus = z.infer<typeof MatchStatusSchema>;
export type Match = z.infer<typeof MatchSchema>;
export type Game = z.infer<typeof GameSchema>;
