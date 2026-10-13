import { randomUUID } from 'node:crypto';
import { createInitialGameState } from '@easymtg/game';
import { CardDefinitionIdSchema, DeckSchema, DeckSnapshotSchema, GameIdSchema, MatchIdSchema, PlayerIdSchema, type DeckEntry, type Match, type Room } from '@easymtg/shared';
import type { Database } from './client.js';
import { cardDefinitionVersions, cardDefinitions, deckSnapshots, decks, gameCardDefinitionRefs, gameStates, games, matchPlayers, matches } from './schema.js';
import { and, eq, inArray } from 'drizzle-orm';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Creates the first or next Game inside the caller's lifecycle transaction. */
export class GameInitializer {
  async startFirst(tx: Transaction, room: Room): Promise<string> {
    const matchId = MatchIdSchema.parse(`match-${randomUUID()}`);
    await tx.insert(matches).values({ id: matchId, roomId: room.id, status: 'ACTIVE', currentGameNumber: 1, activeGameId: null });
    await tx.insert(matchPlayers).values(room.participants.map((participant, seatOrder) => ({
      matchId, roomId: room.id, playerId: participant.playerId, seatOrder,
    })));
    const playerIds = room.participants.map(({ playerId }) => PlayerIdSchema.parse(playerId)) as [ReturnType<typeof PlayerIdSchema.parse>, ReturnType<typeof PlayerIdSchema.parse>];
    const match: Match = { id: matchId, roomId: room.id, playerIds, status: 'ACTIVE', currentGameNumber: 1, createdAt: new Date().toISOString() };
    const gameId = await this.createGame(tx, room, match, 1);
    await tx.update(matches).set({ activeGameId: gameId }).where(eq(matches.id, matchId));
    return matchId;
  }

  async startNext(tx: Transaction, room: Room, match: Match, gameNumber: number, temporaryDecks: Map<string, { mainboard: string[]; sideboard: string[] }>): Promise<string> {
    return this.createGame(tx, room, match, gameNumber, temporaryDecks);
  }

  private async createGame(tx: Transaction, room: Room, match: Match, gameNumber: number, temporaryDecks?: Map<string, { mainboard: string[]; sideboard: string[] }>): Promise<string> {
    const playerIds = room.participants.map(({ playerId }) => PlayerIdSchema.parse(playerId)) as [ReturnType<typeof PlayerIdSchema.parse>, ReturnType<typeof PlayerIdSchema.parse>];
    if (playerIds.length !== 2) throw new Error('A Game requires two Room participants.');
    const deckRows = await tx.select().from(decks).where(inArray(decks.id, [...new Set(room.participants.map(({ deckId }) => deckId))])).orderBy(decks.id).for('share');
    const parsedDecks = deckRows.map((deck) => DeckSchema.parse({ ...deck, updatedAt: deck.updatedAt.toISOString() }));
    const byDeckId = new Map(parsedDecks.map((deck) => [deck.id, deck]));
    const selected = room.participants.map((participant) => {
      const deck = byDeckId.get(participant.deckId);
      if (!deck) throw new Error(`Selected Deck ${participant.deckId} is missing.`);
      return deck;
    });
    const compositions = selected.map((deck, index) => {
      const override = temporaryDecks?.get(room.participants[index]!.playerId);
      return override ?? { mainboard: deck.mainboard, sideboard: deck.sideboard };
    });
    const cardIds = [...new Set(compositions.flatMap((deck) => [...deck.mainboard, ...deck.sideboard]))].sort();
    const definitionRows = await tx.select({ id: cardDefinitions.id, currentVersion: cardDefinitions.currentVersion, status: cardDefinitions.status })
      .from(cardDefinitions).where(inArray(cardDefinitions.id, cardIds)).orderBy(cardDefinitions.id).for('share', { of: cardDefinitions });
    if (definitionRows.length !== cardIds.length || definitionRows.some(({ status }) => status !== 'ENABLED')) throw new Error('A selected Deck contains unavailable cards.');
    const versions = await tx.select({ id: cardDefinitionVersions.cardDefinitionId, version: cardDefinitionVersions.version })
      .from(cardDefinitionVersions).innerJoin(cardDefinitions, and(eq(cardDefinitions.id, cardDefinitionVersions.cardDefinitionId), eq(cardDefinitions.currentVersion, cardDefinitionVersions.version)))
      .where(inArray(cardDefinitionVersions.cardDefinitionId, cardIds)).orderBy(cardDefinitionVersions.cardDefinitionId).for('share', { of: cardDefinitionVersions });
    if (versions.length !== cardIds.length) throw new Error('A selected Card Definition has no current Version.');
    const definitions = Object.fromEntries(definitionRows.map((definition) => [definition.id, { version: definition.currentVersion, status: definition.status as 'ENABLED' | 'DISABLED' }]));
    const gameId = GameIdSchema.parse(`game-${randomUUID()}`);
    const state = createInitialGameState({
      gameId, matchId: MatchIdSchema.parse(match.id), playerIds,
      hostPlayerId: PlayerIdSchema.parse(room.ownerPlayerId),
      decks: compositions.map((deck, index) => ({ playerId: playerIds[index]!, mainboard: entries(deck.mainboard), sideboard: entries(deck.sideboard) })) as [
        { playerId: typeof playerIds[number]; mainboard: DeckEntry[]; sideboard: DeckEntry[] },
        { playerId: typeof playerIds[number]; mainboard: DeckEntry[]; sideboard: DeckEntry[] },
      ], definitions,
    });
    await tx.insert(games).values({ id: gameId, matchId: match.id, gameNumber, status: 'PLAYING', currentSequence: 0 });
    await tx.insert(gameStates).values({ gameId, state });
    await tx.insert(deckSnapshots).values(selected.map((deck, index) => ({
      gameId, playerId: playerIds[index]!, snapshot: DeckSnapshotSchema.parse({ deckId: deck.id, deckName: deck.name, ...compositions[index]! }),
    })));
    await tx.insert(gameCardDefinitionRefs).values(versions.map(({ id, version }) => ({ gameId, cardDefinitionId: id, version })));
    return gameId;
  }
}

function entries(ids: string[]): DeckEntry[] {
  const quantities = new Map<string, number>();
  for (const id of ids) quantities.set(id, (quantities.get(id) ?? 0) + 1);
  return [...quantities].map(([cardDefinitionId, quantity]) => ({ cardDefinitionId: CardDefinitionIdSchema.parse(cardDefinitionId), quantity }));
}
