import { and, eq, inArray, ne } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { GameStateSchema } from '@easymtg/game';
import {
  DeckSchema, DeckSnapshotSchema, MatchIdSchema, NextGameDeckSchema, PlayerIdSchema, RoomIdSchema, RoomSchema, UserIdSchema,
  type Deck, type PlayerId, type Room, type UserId,
} from '@easymtg/shared';
import type { Database } from './client.js';
import { deckSnapshots, gameStates, games, matchPlayers, matches, cardDefinitionVersions, cardDefinitions, decks, roomPlayers, rooms } from './schema.js';

export class PersistedRoomError extends Error {
  constructor(readonly code: 'ACTIVE_ROOM_EXISTS' | 'ROOM_NOT_FOUND' | 'ROOM_NOT_WAITING' | 'ROOM_FULL' | 'ROOM_IN_MATCH' | 'PLAYER_ALREADY_IN_ROOM' | 'PLAYER_NOT_IN_ROOM' | 'DECK_NOT_FOUND' | 'DECK_INVALID' | 'CARD_UNAVAILABLE' | 'GAME_STILL_ACTIVE' | 'MATCH_NOT_ACTIVE' | 'PLAYERS_NOT_READY' | 'INVALID_SIDEBOARD' | 'ALL_GAMES_COMPLETE', message = code) {
    super(message);
    this.name = 'PersistedRoomError';
  }
}

function sameMultiset(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const id of left) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of right) {
    const count = counts.get(id) ?? 0;
    if (count === 0) return false;
    counts.set(id, count - 1);
  }
  return [...counts.values()].every((count) => count === 0);
}

/** Transactional persistence for the WAITING Room lifecycle. */
export class RoomRepository {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  async createWaitingRoom(input: { roomId: string; ownerPlayerId: PlayerId; userId: UserId; deckId: string }): Promise<Room> {
    const roomId = RoomIdSchema.parse(input.roomId);
    const ownerPlayerId = PlayerIdSchema.parse(input.ownerPlayerId);
    const userId = UserIdSchema.parse(input.userId);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 1))`);
      const [activeRoom] = await tx.select({ roomId: roomPlayers.roomId }).from(roomPlayers).where(eq(roomPlayers.userId, userId));
      if (activeRoom) throw new PersistedRoomError('ACTIVE_ROOM_EXISTS');

      const deck = await this.getUsableDeck(tx, userId, input.deckId);
      const createdAt = this.now();
      await tx.insert(rooms).values({ id: roomId, ownerPlayerId, status: 'WAITING', createdAt });
      await tx.insert(roomPlayers).values({ roomId, playerId: ownerPlayerId, userId, deckId: deck.id, seatOrder: 0 });
      return RoomSchema.parse({
        id: roomId, ownerPlayerId, status: 'WAITING', participants: [{ playerId: ownerPlayerId, deckId: deck.id, connectionState: 'CONNECTED' }],
        createdAt: createdAt.toISOString(),
      });
    });
  }

  /** The callback persists Match, Game 1, snapshots and Version refs inside this join transaction. */
  async joinAndStartMatch(input: { roomId: string; playerId: PlayerId; userId: UserId; deckId: string }, startMatch: (tx: Parameters<Parameters<Database['transaction']>[0]>[0], room: Room) => Promise<string>): Promise<Room> {
    const roomId = RoomIdSchema.parse(input.roomId);
    const playerId = PlayerIdSchema.parse(input.playerId);
    const userId = UserIdSchema.parse(input.userId);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 1))`);
      const [roomRow] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for('update');
      if (!roomRow) throw new PersistedRoomError('ROOM_NOT_FOUND');
      if (roomRow.status !== 'WAITING') throw new PersistedRoomError('ROOM_NOT_WAITING');
      const members = await tx.select().from(roomPlayers).where(eq(roomPlayers.roomId, roomId)).orderBy(roomPlayers.seatOrder);
      if (members.some((member) => member.playerId === playerId)) throw new PersistedRoomError('PLAYER_ALREADY_IN_ROOM');
      if (members.length >= 2) throw new PersistedRoomError('ROOM_FULL');
      const [activeRoom] = await tx.select({ roomId: roomPlayers.roomId }).from(roomPlayers).where(eq(roomPlayers.userId, userId));
      if (activeRoom) throw new PersistedRoomError('ACTIVE_ROOM_EXISTS');
      const deck = await this.getUsableDeck(tx, userId, input.deckId);
      await tx.insert(roomPlayers).values({ roomId, playerId, userId, deckId: deck.id, seatOrder: members.length });
      const candidate = RoomSchema.parse({
        id: roomId, ownerPlayerId: roomRow.ownerPlayerId, status: 'WAITING',
        participants: [...members.map((member) => ({ playerId: PlayerIdSchema.parse(member.playerId), deckId: member.deckId, connectionState: 'DISCONNECTED' as const })),
          { playerId, deckId: deck.id, connectionState: 'CONNECTED' as const }],
        createdAt: roomRow.createdAt.toISOString(),
      });
      const matchId = MatchIdSchema.parse(await startMatch(tx, candidate));
      const [match] = await tx.select().from(matches).where(and(eq(matches.id, matchId), eq(matches.roomId, roomId))).for('update');
      if (!match || match.status !== 'ACTIVE' || match.currentGameNumber !== 1 || !match.activeGameId) throw new Error('Match initialization did not persist an active Game 1.');
      const [game] = await tx.select().from(games).where(and(eq(games.id, match.activeGameId), eq(games.matchId, matchId), eq(games.gameNumber, 1))).for('update');
      if (!game || game.status !== 'PLAYING') throw new Error('Match initialization did not persist a playing Game 1.');
      const [state] = await tx.select().from(gameStates).where(eq(gameStates.gameId, game.id));
      if (!state) throw new Error('Match initialization did not persist the canonical GameState.');
      const canonicalState = GameStateSchema.parse(state.state);
      if (canonicalState.gameId !== game.id || canonicalState.matchId !== matchId || canonicalState.sequence !== 0 || canonicalState.status !== 'PLAYING' ||
          candidate.participants.some(({ playerId }) => !canonicalState.players.some((player) => player.playerId === playerId))) {
        throw new Error('Initial GameState disagrees with the persisted Room, Match or Game.');
      }
      const persistedMatchPlayers = await tx.select().from(matchPlayers).where(eq(matchPlayers.matchId, matchId));
      const persistedSnapshots = await tx.select().from(deckSnapshots).where(eq(deckSnapshots.gameId, game.id));
      if (persistedMatchPlayers.length !== 2 || candidate.participants.some(({ playerId }) => !persistedMatchPlayers.some((member) => member.playerId === playerId && member.roomId === roomId)) ||
          persistedSnapshots.length !== 2 || candidate.participants.some(({ playerId }) => !persistedSnapshots.some((snapshot) => snapshot.playerId === playerId))) {
        throw new Error('Match initialization did not persist both Player memberships and DeckSnapshots.');
      }
      for (const snapshot of persistedSnapshots) DeckSnapshotSchema.parse(snapshot.snapshot);
      const [updated] = await tx.update(rooms).set({ status: 'IN_MATCH', matchId }).where(eq(rooms.id, roomId)).returning();
      if (!updated) throw new PersistedRoomError('ROOM_NOT_FOUND');
      return RoomSchema.parse({ ...candidate, status: 'IN_MATCH', matchId });
    });
  }

  /** Applies the specified WAITING-room leave and owner-transfer rules atomically. */
  async leaveWaitingRoom(input: { roomId: string; playerId: PlayerId; userId: UserId }, connectionState: (playerId: PlayerId) => 'CONNECTED' | 'DISCONNECTED' = () => 'DISCONNECTED'): Promise<{ room: Room | null; deleted: boolean; ownerChanged: boolean }> {
    const roomId = RoomIdSchema.parse(input.roomId);
    const playerId = PlayerIdSchema.parse(input.playerId);
    const userId = UserIdSchema.parse(input.userId);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 1))`);
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for('update');
      if (!room) throw new PersistedRoomError('ROOM_NOT_FOUND');
      if (room.status !== 'WAITING') throw new PersistedRoomError('ROOM_IN_MATCH');
      const members = await tx.select().from(roomPlayers).where(eq(roomPlayers.roomId, roomId)).orderBy(roomPlayers.seatOrder);
      const leaving = members.find((member) => member.playerId === playerId && member.userId === userId);
      if (!leaving) throw new PersistedRoomError('PLAYER_NOT_IN_ROOM');
      const remaining = members.filter((member) => member.playerId !== playerId);
      if (remaining.length === 0) {
        await tx.delete(rooms).where(eq(rooms.id, roomId));
        return { room: null, deleted: true, ownerChanged: false };
      }
      await tx.delete(roomPlayers).where(and(eq(roomPlayers.roomId, roomId), eq(roomPlayers.playerId, playerId)));
      const ownerChanged = room.ownerPlayerId === playerId;
      const ownerPlayerId = ownerChanged ? PlayerIdSchema.parse(remaining[0]!.playerId) : PlayerIdSchema.parse(room.ownerPlayerId);
      if (ownerChanged) {
        await tx.update(roomPlayers).set({ seatOrder: 0 }).where(and(eq(roomPlayers.roomId, roomId), eq(roomPlayers.playerId, ownerPlayerId)));
        await tx.update(rooms).set({ ownerPlayerId }).where(eq(rooms.id, roomId));
      }
      const participants = await tx.select().from(roomPlayers).where(eq(roomPlayers.roomId, roomId)).orderBy(roomPlayers.seatOrder);
      return {
        room: RoomSchema.parse({
          id: room.id, ownerPlayerId, status: room.status,
          ...(room.matchId ? { matchId: room.matchId } : {}),
          participants: participants.map((member) => ({
            playerId: PlayerIdSchema.parse(member.playerId), deckId: member.deckId,
            connectionState: connectionState(PlayerIdSchema.parse(member.playerId)),
          })),
          createdAt: room.createdAt.toISOString(),
        }),
        deleted: false, ownerChanged,
      };
    });
  }

  /** Returns a caller's private next-Game composition and the opponent's confirmation state. */
  async getNextGameDeck(userId: UserId, playerId: PlayerId): Promise<{ mainboard: string[]; sideboard: string[]; confirmed: boolean; opponentConfirmed: boolean } | null> {
    const [member] = await this.db.select().from(roomPlayers).where(and(eq(roomPlayers.userId, userId), eq(roomPlayers.playerId, playerId)));
    if (!member) throw new PersistedRoomError('PLAYER_NOT_IN_ROOM');
    const [room] = await this.db.select().from(rooms).where(eq(rooms.id, member.roomId));
    if (!room?.matchId) return null;
    const [match] = await this.db.select().from(matches).where(eq(matches.id, room.matchId));
    if (!match || match.status !== 'ACTIVE' || match.activeGameId || match.currentGameNumber >= 5) return null;
    const [previous] = await this.db.select().from(games).where(and(eq(games.matchId, match.id), eq(games.gameNumber, match.currentGameNumber)));
    if (!previous || (previous.status !== 'FINISHED' && previous.status !== 'ABANDONED')) return null;
    const [snapshot] = await this.db.select().from(deckSnapshots).where(and(eq(deckSnapshots.gameId, previous.id), eq(deckSnapshots.playerId, playerId)));
    if (!snapshot) throw new Error('Previous Game DeckSnapshot is missing.');
    const snapshotDeck = DeckSnapshotSchema.parse(snapshot.snapshot);
    const baseline = NextGameDeckSchema.parse({ mainboard: snapshotDeck.mainboard, sideboard: snapshotDeck.sideboard });
    const composition = member.nextGameDeck ? NextGameDeckSchema.parse(member.nextGameDeck) : baseline;
    const [opponent] = await this.db.select({ confirmed: roomPlayers.nextGameConfirmed }).from(roomPlayers)
      .where(and(eq(roomPlayers.roomId, member.roomId), ne(roomPlayers.playerId, playerId)));
    return { ...composition, confirmed: member.nextGameConfirmed, opponentConfirmed: opponent?.confirmed ?? false };
  }

  /** Saves and confirms a Player's temporary sideboard composition. */
  async confirmNextGameDeck(input: { userId: UserId; playerId: PlayerId; composition: unknown }, connectionState: (playerId: PlayerId) => 'CONNECTED' | 'DISCONNECTED' = () => 'DISCONNECTED'): Promise<Room> {
    const userId = UserIdSchema.parse(input.userId);
    const playerId = PlayerIdSchema.parse(input.playerId);
    const composition = NextGameDeckSchema.safeParse(input.composition);
    if (!composition.success) throw new PersistedRoomError('DECK_INVALID');
    return this.db.transaction(async (tx) => {
      const [membership] = await tx.select({ roomId: roomPlayers.roomId }).from(roomPlayers).where(and(eq(roomPlayers.userId, userId), eq(roomPlayers.playerId, playerId)));
      if (!membership) throw new PersistedRoomError('PLAYER_NOT_IN_ROOM');
      const [initialRoom] = await tx.select().from(rooms).where(eq(rooms.id, membership.roomId));
      if (!initialRoom || !initialRoom.matchId) throw new PersistedRoomError('ROOM_NOT_FOUND');
      const [match] = await tx.select().from(matches).where(eq(matches.id, initialRoom.matchId)).for('update');
      if (!match || match.status !== 'ACTIVE') throw new PersistedRoomError('MATCH_NOT_ACTIVE');
      if (match.activeGameId) throw new PersistedRoomError('GAME_STILL_ACTIVE');
      if (match.currentGameNumber >= 5) throw new PersistedRoomError('ALL_GAMES_COMPLETE');
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, membership.roomId)).for('update');
      if (!room || room.status !== 'IN_MATCH' || room.matchId !== match.id) throw new PersistedRoomError('ROOM_NOT_FOUND');
      const [previous] = await tx.select().from(games).where(and(eq(games.matchId, match.id), eq(games.gameNumber, match.currentGameNumber))).for('update');
      if (!previous || (previous.status !== 'FINISHED' && previous.status !== 'ABANDONED')) throw new PersistedRoomError('GAME_STILL_ACTIVE');
      const [snapshot] = await tx.select().from(deckSnapshots).where(and(eq(deckSnapshots.gameId, previous.id), eq(deckSnapshots.playerId, playerId)));
      if (!snapshot) throw new Error('Previous Game DeckSnapshot is missing.');
      const snapshotDeck = DeckSnapshotSchema.parse(snapshot.snapshot);
      const baseline = NextGameDeckSchema.parse({ mainboard: snapshotDeck.mainboard, sideboard: snapshotDeck.sideboard });
      if (!sameMultiset([...baseline.mainboard, ...baseline.sideboard], [...composition.data.mainboard, ...composition.data.sideboard])) {
        throw new PersistedRoomError('INVALID_SIDEBOARD');
      }
      const ids = [...new Set([...composition.data.mainboard, ...composition.data.sideboard])];
      const available = ids.length ? await tx.select({ id: cardDefinitions.id, status: cardDefinitions.status }).from(cardDefinitions).where(inArray(cardDefinitions.id, ids)) : [];
      if (available.length !== ids.length) throw new PersistedRoomError('DECK_INVALID');
      if (available.some(({ status }) => status !== 'ENABLED')) throw new PersistedRoomError('CARD_UNAVAILABLE');
      await tx.update(roomPlayers).set({ nextGameDeck: composition.data, nextGameConfirmed: true })
        .where(and(eq(roomPlayers.roomId, room.id), eq(roomPlayers.playerId, playerId)));
      const participants = await tx.select().from(roomPlayers).where(eq(roomPlayers.roomId, room.id)).orderBy(roomPlayers.seatOrder);
      return RoomSchema.parse({
        id: room.id, ownerPlayerId: room.ownerPlayerId, status: room.status, matchId: match.id,
        participants: participants.map((member) => ({
          playerId: PlayerIdSchema.parse(member.playerId), deckId: member.deckId,
          connectionState: connectionState(PlayerIdSchema.parse(member.playerId)),
        })),
        createdAt: room.createdAt.toISOString(),
      });
    });
  }

  async unconfirmNextGameDeck(input: { userId: UserId; playerId: PlayerId }, connectionState: (playerId: PlayerId) => 'CONNECTED' | 'DISCONNECTED' = () => 'DISCONNECTED'): Promise<Room> {
    const userId = UserIdSchema.parse(input.userId);
    const playerId = PlayerIdSchema.parse(input.playerId);
    return this.db.transaction(async (tx) => {
      const [member] = await tx.select({ roomId: roomPlayers.roomId }).from(roomPlayers)
        .where(and(eq(roomPlayers.userId, userId), eq(roomPlayers.playerId, playerId)));
      if (!member) throw new PersistedRoomError('PLAYER_NOT_IN_ROOM');
      const [initialRoom] = await tx.select().from(rooms).where(eq(rooms.id, member.roomId));
      if (!initialRoom?.matchId) throw new PersistedRoomError('ROOM_NOT_FOUND');
      const [match] = await tx.select().from(matches).where(eq(matches.id, initialRoom.matchId)).for('update');
      if (!match || match.status !== 'ACTIVE') throw new PersistedRoomError('MATCH_NOT_ACTIVE');
      if (match.activeGameId) throw new PersistedRoomError('GAME_STILL_ACTIVE');
      if (match.currentGameNumber >= 5) throw new PersistedRoomError('ALL_GAMES_COMPLETE');
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, member.roomId)).for('update');
      if (!room?.matchId || room.matchId !== match.id || room.status !== 'IN_MATCH') throw new PersistedRoomError('ROOM_NOT_FOUND');
      const [previous] = await tx.select().from(games).where(and(eq(games.matchId, match.id), eq(games.gameNumber, match.currentGameNumber))).for('update');
      if (!previous || (previous.status !== 'FINISHED' && previous.status !== 'ABANDONED')) throw new PersistedRoomError('GAME_STILL_ACTIVE');
      await tx.update(roomPlayers).set({ nextGameConfirmed: false }).where(and(eq(roomPlayers.roomId, room.id), eq(roomPlayers.playerId, playerId)));
      const participants = await tx.select().from(roomPlayers).where(eq(roomPlayers.roomId, room.id)).orderBy(roomPlayers.seatOrder);
      return RoomSchema.parse({
        id: room.id, ownerPlayerId: room.ownerPlayerId, status: room.status, matchId: room.matchId,
        participants: participants.map((item) => ({ playerId: PlayerIdSchema.parse(item.playerId), deckId: item.deckId, connectionState: connectionState(PlayerIdSchema.parse(item.playerId)) })),
        createdAt: room.createdAt.toISOString(),
      });
    });
  }

  async getActiveRoom(userId: UserId, connectionState: (playerId: PlayerId) => 'CONNECTED' | 'DISCONNECTED' = () => 'DISCONNECTED'): Promise<Room | null> {
    const [participant] = await this.db.select({ room: rooms }).from(roomPlayers)
      .innerJoin(rooms, eq(rooms.id, roomPlayers.roomId)).where(eq(roomPlayers.userId, userId));
    if (!participant) return null;
    const members = await this.db.select().from(roomPlayers).where(eq(roomPlayers.roomId, participant.room.id)).orderBy(roomPlayers.seatOrder);
    return RoomSchema.parse({
      id: participant.room.id,
      ownerPlayerId: participant.room.ownerPlayerId,
      status: participant.room.status,
      ...(participant.room.matchId ? { matchId: participant.room.matchId } : {}),
      participants: members.map((member) => ({
        playerId: PlayerIdSchema.parse(member.playerId), deckId: member.deckId, connectionState: connectionState(PlayerIdSchema.parse(member.playerId)),
      })),
      createdAt: participant.room.createdAt.toISOString(),
    });
  }

  async getActivePlayerId(userId: UserId): Promise<PlayerId | null> {
    const [member] = await this.db.select({ playerId: roomPlayers.playerId }).from(roomPlayers).where(eq(roomPlayers.userId, userId));
    return member ? PlayerIdSchema.parse(member.playerId) : null;
  }

  async getRoom(roomId: string, connectionState: (playerId: PlayerId) => 'CONNECTED' | 'DISCONNECTED' = () => 'DISCONNECTED'): Promise<Room> {
    const id = RoomIdSchema.parse(roomId);
    const [room] = await this.db.select().from(rooms).where(eq(rooms.id, id));
    if (!room) throw new PersistedRoomError('ROOM_NOT_FOUND');
    const members = await this.db.select().from(roomPlayers).where(eq(roomPlayers.roomId, id)).orderBy(roomPlayers.seatOrder);
    return RoomSchema.parse({
      id: room.id, ownerPlayerId: room.ownerPlayerId, status: room.status,
      ...(room.matchId ? { matchId: room.matchId } : {}),
      participants: members.map((member) => ({
        playerId: PlayerIdSchema.parse(member.playerId), deckId: member.deckId, connectionState: connectionState(PlayerIdSchema.parse(member.playerId)),
      })),
      createdAt: room.createdAt.toISOString(),
    });
  }

  private async getUsableDeck(tx: Parameters<Parameters<Database['transaction']>[0]>[0], userId: UserId, deckId: string): Promise<Deck> {
    const [row] = await tx.select().from(decks).where(and(eq(decks.id, deckId), eq(decks.ownerUserId, userId))).for('share');
    if (!row) throw new PersistedRoomError('DECK_NOT_FOUND');
    const parsed = DeckSchema.safeParse({ ...row, updatedAt: row.updatedAt.toISOString() });
    if (!parsed.success) throw new PersistedRoomError('DECK_INVALID');
    const ids = [...new Set([...parsed.data.mainboard, ...parsed.data.sideboard])].sort();
    const definitions = await tx.select({ id: cardDefinitions.id, currentVersion: cardDefinitions.currentVersion, status: cardDefinitions.status })
      .from(cardDefinitions).where(inArray(cardDefinitions.id, ids)).orderBy(cardDefinitions.id).for('share', { of: cardDefinitions });
    if (definitions.length !== ids.length) throw new PersistedRoomError('DECK_INVALID');
    if (definitions.some(({ status }) => status !== 'ENABLED')) throw new PersistedRoomError('CARD_UNAVAILABLE');
    const versions = await tx.select({ id: cardDefinitionVersions.cardDefinitionId, version: cardDefinitionVersions.version })
      .from(cardDefinitionVersions).innerJoin(cardDefinitions, and(
        eq(cardDefinitions.id, cardDefinitionVersions.cardDefinitionId), eq(cardDefinitions.currentVersion, cardDefinitionVersions.version),
      )).where(inArray(cardDefinitionVersions.cardDefinitionId, ids)).orderBy(cardDefinitionVersions.cardDefinitionId).for('share', { of: cardDefinitionVersions });
    if (versions.length !== ids.length) throw new PersistedRoomError('DECK_INVALID');
    return parsed.data;
  }
}
