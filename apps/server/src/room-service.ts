import { randomUUID } from 'node:crypto';
import {
  RoomIdSchema, RoomSchema,
  type DeckId, type GameStatus, type MatchId, type PlayerId, type Room, type UserId,
} from '@easymtg/shared';
import { DeckService } from './deck-service.js';

export type LifecycleEvent = {
  eventId: string;
  type: 'RoomPlayerJoined' | 'RoomPlayerLeft' | 'RoomOwnerChanged' | 'GameStarted' | 'GameEnded' | 'MatchEnded';
  roomId: string;
  playerId?: string;
  ownerPlayerId?: string;
  matchId?: string;
  gameId?: string;
  gameNumber?: number;
  gameStatus?: GameStatus;
};
export type AutoStartRoom = (room: Room) => { matchId: MatchId; events: LifecycleEvent[] };

export class RoomServiceError extends Error {
  constructor(readonly code: 'ACTIVE_ROOM_EXISTS' | 'ROOM_NOT_FOUND' | 'ROOM_NOT_WAITING' | 'ROOM_FULL' | 'PLAYER_ALREADY_IN_ROOM' | 'PLAYER_NOT_IN_ROOM' | 'ROOM_IN_MATCH' | 'AUTO_START_UNAVAILABLE') {
    super(code);
    this.name = 'RoomServiceError';
  }
}

/** In-memory Room aggregate. Session aggregation and transport delivery are Phase 7. */
export class RoomService {
  private readonly rooms = new Map<string, Room>();
  private readonly activeRoomByUser = new Map<UserId, string>();
  private readonly participantUserByPlayer = new Map<PlayerId, UserId>();
  private autoStartRoom: AutoStartRoom | undefined;

  constructor(
    private readonly decks: DeckService,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = randomUUID,
  ) {}

  setAutoStartRoom(handler: AutoStartRoom) {
    this.autoStartRoom = handler;
  }

  create(userId: UserId, playerId: PlayerId, deckId: DeckId): { room: Room; events: LifecycleEvent[] } {
    this.assertNoActiveRoom(userId);
    this.decks.validateForUse(userId, deckId);
    const room = RoomSchema.parse({
      id: RoomIdSchema.parse(this.createId()), ownerPlayerId: playerId, status: 'WAITING',
      participants: [{ playerId, deckId, connectionState: 'CONNECTED' }], createdAt: this.now(),
    });
    this.rooms.set(room.id, room);
    this.activeRoomByUser.set(userId, room.id);
    this.participantUserByPlayer.set(playerId, userId);
    return { room: structuredClone(room), events: [] };
  }

  join(userId: UserId, playerId: PlayerId, roomId: string, deckId: DeckId): { room: Room; events: LifecycleEvent[] } {
    this.assertNoActiveRoom(userId);
    const room = this.getMutableRoom(roomId);
    if (room.status !== 'WAITING') throw new RoomServiceError('ROOM_NOT_WAITING');
    if (room.participants.some((participant) => participant.playerId === playerId)) throw new RoomServiceError('PLAYER_ALREADY_IN_ROOM');
    if (room.participants.length >= 2) throw new RoomServiceError('ROOM_FULL');
    this.decks.validateForUse(userId, deckId);
    const withPlayer = RoomSchema.parse({ ...room, participants: [...room.participants, { playerId, deckId, connectionState: 'CONNECTED' }] });
    let updated = withPlayer;
    let lifecycleEvents: LifecycleEvent[] = [this.event({ type: 'RoomPlayerJoined', roomId, playerId })];
    if (withPlayer.participants.length === 2) {
      if (!this.autoStartRoom) throw new RoomServiceError('AUTO_START_UNAVAILABLE');
      this.participantUserByPlayer.set(playerId, userId);
      let started: ReturnType<AutoStartRoom>;
      try {
        started = this.autoStartRoom(withPlayer);
      } catch (error) {
        this.participantUserByPlayer.delete(playerId);
        throw error;
      }
      updated = RoomSchema.parse({ ...withPlayer, status: 'IN_MATCH', matchId: started.matchId });
      lifecycleEvents = [...lifecycleEvents, ...started.events];
    }
    this.rooms.set(roomId, updated);
    this.activeRoomByUser.set(userId, roomId);
    this.participantUserByPlayer.set(playerId, userId);
    return {
      room: structuredClone(updated),
      events: lifecycleEvents,
    };
  }

  leave(userId: UserId, playerId: PlayerId): { room?: Room; events: LifecycleEvent[]; deleted: boolean } {
    const roomId = this.activeRoomByUser.get(userId);
    if (!roomId) throw new RoomServiceError('PLAYER_NOT_IN_ROOM');
    const room = this.getMutableRoom(roomId);
    if (room.status !== 'WAITING') throw new RoomServiceError('ROOM_IN_MATCH');
    if (!room.participants.some((participant) => participant.playerId === playerId)) throw new RoomServiceError('PLAYER_NOT_IN_ROOM');

    this.activeRoomByUser.delete(userId);
    this.participantUserByPlayer.delete(playerId);
    const remaining = room.participants.filter((participant) => participant.playerId !== playerId);
    const events = [this.event({ type: 'RoomPlayerLeft', roomId, playerId })];
    if (remaining.length === 0) {
      this.rooms.delete(roomId);
      return { events, deleted: true };
    }
    const ownerPlayerId = room.ownerPlayerId === playerId ? remaining[0]!.playerId : room.ownerPlayerId;
    const updated = RoomSchema.parse({ ...room, ownerPlayerId, participants: remaining });
    this.rooms.set(roomId, updated);
    if (ownerPlayerId !== room.ownerPlayerId) events.push(this.event({ type: 'RoomOwnerChanged', roomId, ownerPlayerId }));
    return { room: structuredClone(updated), events, deleted: false };
  }

  get(roomId: string): Room {
    return structuredClone(this.getMutableRoom(roomId));
  }

  getSelectedDeck(roomId: string, playerId: PlayerId, candidateRoom?: Room): { userId: UserId; deckId: DeckId } {
    const room = candidateRoom?.id === roomId ? candidateRoom : this.getMutableRoom(roomId);
    const participant = room.participants.find((candidate) => candidate.playerId === playerId);
    const userId = this.participantUserByPlayer.get(playerId);
    if (!participant || !userId) throw new RoomServiceError('PLAYER_NOT_IN_ROOM');
    return { userId, deckId: participant.deckId };
  }

  updateSelectedDeck(roomId: string, userId: UserId, playerId: PlayerId, deckId: DeckId): Room {
    const room = this.getMutableRoom(roomId);
    if (this.activeRoomByUser.get(userId) !== roomId || this.participantUserByPlayer.get(playerId) !== userId) throw new RoomServiceError('PLAYER_NOT_IN_ROOM');
    this.decks.validateForUse(userId, deckId);
    const updated = RoomSchema.parse({ ...room, participants: room.participants.map((participant) => participant.playerId === playerId ? { ...participant, deckId } : participant) });
    this.rooms.set(roomId, updated);
    return structuredClone(updated);
  }

  deleteForMatchEnd(roomId: string) {
    const room = this.getMutableRoom(roomId);
    for (const participant of room.participants) {
      const userId = this.participantUserByPlayer.get(participant.playerId);
      if (userId && this.activeRoomByUser.get(userId) === roomId) this.activeRoomByUser.delete(userId);
      this.participantUserByPlayer.delete(participant.playerId);
    }
    this.rooms.delete(roomId);
  }

  private assertNoActiveRoom(userId: UserId) {
    if (this.activeRoomByUser.has(userId)) throw new RoomServiceError('ACTIVE_ROOM_EXISTS');
  }

  private getMutableRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomServiceError('ROOM_NOT_FOUND');
    return room;
  }

  private event(event: Omit<LifecycleEvent, 'eventId'>): LifecycleEvent {
    return { ...event, eventId: this.createId() };
  }
}
