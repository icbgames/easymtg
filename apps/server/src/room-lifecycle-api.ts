import { randomUUID } from 'node:crypto';
import { PlayerIdSchema, RoomIdSchema, type PlayerId, type Room, type UserId } from '@easymtg/shared';
import type { LifecycleEvent } from './room-service.js';
import { GameInitializer } from './db/game-initializer.js';
import { MatchRepository } from './db/match-repository.js';
import { RoomRepository } from './db/room-repository.js';
import type { Database } from './db/client.js';
import { matches, games } from './db/schema.js';
import { eq } from 'drizzle-orm';

export type RoomLifecycleResult = { room: Room | null; playerId: PlayerId; selectedDeckId?: string; events: LifecycleEvent[]; gameId?: string; gameNumber?: number };
export type CurrentRoomState = { room: Room; playerId: PlayerId; selectedDeckId: string; nextGameDeck?: { mainboard: string[]; sideboard: string[]; confirmed: boolean; opponentConfirmed: boolean } };

/** HTTP-facing orchestration for Room operations; persistence stays in repository transactions. */
export class RoomLifecycleApi {
  private readonly initializer = new GameInitializer();
  private readonly rooms: RoomRepository;
  private readonly matches: MatchRepository;

  constructor(
    private readonly db: Database,
    private readonly createId: () => string = randomUUID,
    private readonly connectionState: (playerId: PlayerId) => 'CONNECTED' | 'DISCONNECTED' = () => 'DISCONNECTED',
  ) {
    this.rooms = new RoomRepository(db);
    this.matches = new MatchRepository(db);
  }

  async getCurrent(userId: UserId): Promise<CurrentRoomState | null> {
    const room = await this.rooms.getActiveRoom(userId, this.connectionState);
    if (!room) return null;
    const playerId = await this.rooms.getActivePlayerId(userId);
    const participant = room.participants.find((item) => item.playerId === playerId);
    if (!playerId || !participant) throw new Error('Active Room membership is inconsistent.');
    const nextGameDeck = await this.rooms.getNextGameDeck(userId, playerId);
    return { room, playerId, selectedDeckId: participant.deckId, ...(nextGameDeck ? { nextGameDeck } : {}) };
  }

  async create(userId: UserId, deckId: string): Promise<RoomLifecycleResult> {
    const playerId = PlayerIdSchema.parse(`player-${this.createId()}`);
    const room = await this.rooms.createWaitingRoom({ roomId: `room-${this.createId()}`, ownerPlayerId: playerId, userId, deckId });
    return { room: this.withConnectionState(room), playerId, selectedDeckId: deckId, events: [] };
  }

  async join(userId: UserId, roomId: string, deckId: string): Promise<RoomLifecycleResult> {
    const playerId = PlayerIdSchema.parse(`player-${this.createId()}`);
    const room = await this.rooms.joinAndStartMatch({ roomId: RoomIdSchema.parse(roomId), playerId, userId, deckId }, (tx, candidate) => this.initializer.startFirst(tx, candidate));
    const currentRoom = this.withConnectionState(room);
    const events: LifecycleEvent[] = [{ eventId: this.createId(), type: 'RoomPlayerJoined', roomId: room.id, playerId }];
    if (room.matchId) {
      const [match] = await this.db.select().from(matches).where(eq(matches.id, room.matchId));
      const [game] = match?.activeGameId ? await this.db.select().from(games).where(eq(games.id, match.activeGameId)) : [];
      if (!match || !game) throw new Error('Joined Room has no persisted Game 1.');
      events.push({ eventId: this.createId(), type: 'GameStarted', roomId: room.id, matchId: room.matchId, gameId: game.id, gameNumber: 1 });
      return { room: currentRoom, playerId, selectedDeckId: deckId, events, gameId: game.id, gameNumber: 1 };
    }
    return { room: currentRoom, playerId, selectedDeckId: deckId, events };
  }

  async leave(userId: UserId): Promise<RoomLifecycleResult> {
    const room = await this.rooms.getActiveRoom(userId);
    if (!room) throw new Error('PLAYER_NOT_IN_ROOM');
    const playerId = await this.rooms.getActivePlayerId(userId);
    if (!playerId) throw new Error('PLAYER_NOT_IN_ROOM');
    const result = await this.rooms.leaveWaitingRoom({ roomId: room.id, playerId, userId }, this.connectionState);
    const events: LifecycleEvent[] = [{ eventId: this.createId(), type: 'RoomPlayerLeft', roomId: room.id, playerId }];
    if (result.ownerChanged && result.room) events.push({ eventId: this.createId(), type: 'RoomOwnerChanged', roomId: room.id, ownerPlayerId: result.room.ownerPlayerId });
    return { room: result.room ? this.withConnectionState(result.room) : null, playerId, events };
  }

  async confirmNextGameDeck(userId: UserId, composition: unknown, unconfirm = false): Promise<RoomLifecycleResult> {
    const room = await this.rooms.getActiveRoom(userId);
    if (!room) throw new Error('PLAYER_NOT_IN_ROOM');
    const playerId = await this.rooms.getActivePlayerId(userId);
    if (!playerId) throw new Error('PLAYER_NOT_IN_ROOM');
    const updated = unconfirm
      ? await this.rooms.unconfirmNextGameDeck({ userId, playerId }, this.connectionState)
      : await this.rooms.confirmNextGameDeck({ userId, playerId, composition }, this.connectionState);
    return { room: this.withConnectionState(updated), playerId, events: [] };
  }

  async startNextGame(userId: UserId): Promise<RoomLifecycleResult> {
    const room = await this.rooms.getActiveRoom(userId);
    if (!room?.matchId) throw new Error(room ? 'MATCH_NOT_ACTIVE' : 'PLAYER_NOT_IN_ROOM');
    const actorPlayerId = await this.rooms.getActivePlayerId(userId);
    if (!actorPlayerId) throw new Error('PLAYER_NOT_IN_ROOM');
    const started = await this.matches.startNextGame(room.id, actorPlayerId, (tx, gameRoom, match, number, decks) => this.initializer.startNext(tx, gameRoom, match, number, decks));
    const event: LifecycleEvent = { eventId: this.createId(), type: 'GameStarted', roomId: room.id, matchId: started.match.id, gameId: started.gameId, gameNumber: started.match.currentGameNumber };
    const updatedRoom = this.withConnectionState(await this.rooms.getRoom(room.id));
    const selectedDeckId = updatedRoom.participants.find((participant) => participant.playerId === actorPlayerId)?.deckId;
    return { room: updatedRoom, playerId: actorPlayerId, ...(selectedDeckId ? { selectedDeckId } : {}), events: [event], gameId: started.gameId, gameNumber: started.match.currentGameNumber };
  }

  private withConnectionState(room: Room): Room {
    return { ...room, participants: room.participants.map((participant) => ({ ...participant, connectionState: this.connectionState(participant.playerId) })) };
  }
}
