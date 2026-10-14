import { randomInt, randomUUID } from 'node:crypto';
import type { DeckEntry, PlayerId } from '@easymtg/shared';
import { CardDefinitionIdSchema, GameCardIdSchema, GameIdSchema, MatchIdSchema, PlayerIdSchema, ZoneIdSchema } from '@easymtg/shared';
import { GameStateSchema, type CardInstance, type GameState, type Zone, type ZoneType } from './model.js';

export type InitialDeck = { playerId: string; mainboard: DeckEntry[]; sideboard: DeckEntry[] };
export type ResolvedDefinition = { version: number; status: 'ENABLED' | 'DISABLED' };

export type InitialGameOptions = {
  gameId: string;
  matchId: string;
  playerIds: [string, string];
  hostPlayerId: string;
  decks: [InitialDeck, InitialDeck];
  definitions: Record<string, ResolvedDefinition>;
  createId?: () => string;
  randomIndex?: (maxExclusive: number) => number;
};

const PRIVATE_ZONE_TYPES: ZoneType[] = ['LIBRARY', 'HAND', 'GRAVEYARD', 'EXILE', 'SIDEBOARD'];

function shuffle<T>(values: T[], randomIndex: (maxExclusive: number) => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const otherIndex = randomIndex(index + 1);
    if (!Number.isInteger(otherIndex) || otherIndex < 0 || otherIndex > index) throw new Error('Random source returned an invalid index.');
    [result[index], result[otherIndex]] = [result[otherIndex]!, result[index]!];
  }
  return result;
}

export function createInitialGameState(options: InitialGameOptions): GameState {
  const gameId = GameIdSchema.parse(options.gameId);
  const matchId = MatchIdSchema.parse(options.matchId);
  const playerIds = options.playerIds.map((id) => PlayerIdSchema.parse(id)) as [PlayerId, PlayerId];
  const hostPlayerId = PlayerIdSchema.parse(options.hostPlayerId);
  if (playerIds[0] === playerIds[1] || !playerIds.includes(hostPlayerId)) throw new Error('Game requires two distinct players and a host from those players.');
  if (options.decks.some((deck, index) => deck.playerId !== playerIds[index])) throw new Error('Each deck must match its player.');
  for (const deck of options.decks) {
    const mainCount = deck.mainboard.reduce((total, entry) => total + entry.quantity, 0);
    if (mainCount < 60) throw new Error('A game requires at least 60 mainboard cards per player.');
    const sideboardCount = deck.sideboard.reduce((total, entry) => total + entry.quantity, 0);
    if (sideboardCount > 15) throw new Error('A game allows at most 15 sideboard cards per player.');
  }

  const createId = options.createId ?? randomUUID;
  const random = options.randomIndex ?? randomInt;
  const zones: Zone[] = [];
  const cards: Record<string, CardInstance> = {};
  const zoneByPlayer = new Map<string, Partial<Record<ZoneType, Zone>>>();

  for (const playerId of playerIds) {
    const playerZones: Partial<Record<ZoneType, Zone>> = {};
    for (const type of PRIVATE_ZONE_TYPES) {
      const zone = { zoneId: ZoneIdSchema.parse(createId()), type, ownerPlayerId: playerId, cardIds: [] } satisfies Zone;
      zones.push(zone);
      playerZones[type] = zone;
    }
    zoneByPlayer.set(playerId, playerZones);
  }
  zones.push({ zoneId: ZoneIdSchema.parse(createId()), type: 'BATTLEFIELD', ownerPlayerId: null, cardIds: [] });

  for (const deck of options.decks) {
    const playerId = PlayerIdSchema.parse(deck.playerId);
    const playerZones = zoneByPlayer.get(playerId)!;
    const mainZone = playerZones.LIBRARY!;
    const sideZone = playerZones.SIDEBOARD!;
    const createCards = (entries: DeckEntry[], targetZone: Zone, initialVisibility: CardInstance['visibility']) => {
      for (const entry of entries) {
        const cardDefinitionId = CardDefinitionIdSchema.parse(entry.cardDefinitionId);
        const definition = options.definitions[cardDefinitionId];
        if (!definition || !Number.isInteger(definition.version) || definition.version < 1 || definition.status !== 'ENABLED') {
          throw new Error(`Card definition is missing, disabled, or has an invalid version: ${cardDefinitionId}`);
        }
        for (let count = 0; count < entry.quantity; count += 1) {
          const cardId = GameCardIdSchema.parse(createId());
          if (cards[cardId]) throw new Error('ID generator returned a duplicate card ID.');
          targetZone.cardIds.push(cardId);
          cards[cardId] = {
            cardId, cardDefinitionId, cardDefinitionVersion: definition.version,
            ownerPlayerId: playerId, controllerPlayerId: playerId, tapped: false,
            faceDown: false, position: null, counters: { plusOnePlusOne: 0, other: 0 }, visibility: initialVisibility,
          };
        }
      }
    };
    createCards(deck.mainboard, mainZone, 'HIDDEN');
    createCards(deck.sideboard, sideZone, 'CONTROLLER_ONLY');
    const shuffled = shuffle(mainZone.cardIds, random);
    mainZone.cardIds.splice(0, mainZone.cardIds.length, ...shuffled);
    const hand = playerZones.HAND!;
    hand.cardIds.push(...mainZone.cardIds.splice(0, 7));
    for (const cardId of hand.cardIds) cards[cardId]!.visibility = 'CONTROLLER_ONLY';
  }

  return GameStateSchema.parse({
    gameId, matchId, status: 'PLAYING', turnNumber: 1, activePlayerId: hostPlayerId,
    phase: 'BEGINNING', step: 'UNTAP',
    players: playerIds.map((playerId) => ({ playerId, life: 20 })),
    cards, zones, sequence: 0,
  });
}
