import { sql } from 'drizzle-orm';
import {
  boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp,
  unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const id = (name: string) => text(name).primaryKey();

export const users = pgTable('users', {
  id: uuid('id').primaryKey(), displayName: text('display_name').notNull(), createdAt: createdAt(),
});
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(), userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [index('sessions_user_id_idx').on(t.userId), index('sessions_expires_at_idx').on(t.expiresAt)]);
export const decks = pgTable('decks', {
  id: id('id'), ownerUserId: uuid('owner_user_id').notNull().references(() => users.id), name: text('name').notNull(),
  mainboard: jsonb('mainboard').$type<string[]>().notNull(), sideboard: jsonb('sideboard').$type<string[]>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('decks_owner_id_idx').on(t.ownerUserId, t.id)]);
export const cardDefinitions = pgTable('card_definitions', {
  id: text('id').primaryKey(), currentVersion: integer('current_version').notNull(), status: text('status').notNull(),
}, (t) => [
  check('card_definitions_status_check', sql`${t.status} in ('ENABLED', 'DISABLED')`),
  index('card_definitions_status_id_idx').on(t.status, t.id),
]);
export const cardDefinitionVersions = pgTable('card_definition_versions', {
  cardDefinitionId: text('card_definition_id').notNull().references(() => cardDefinitions.id), version: integer('version').notNull(),
  englishName: text('english_name').notNull(), japaneseName: text('japanese_name'), backName: text('back_name'),
  hasBack: boolean('has_back').notNull(), frontImageUrl: text('front_image_url').notNull(), backImageUrl: text('back_image_url'),
  changeDescription: text('change_description'), rulesData: jsonb('rules_data').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.cardDefinitionId, t.version] })]);
export const rooms = pgTable('rooms', {
  id: id('id'), ownerPlayerId: text('owner_player_id').notNull(), status: text('status').notNull(), matchId: text('match_id'), createdAt: createdAt(),
}, (t) => [check('rooms_status_check', sql`${t.status} in ('WAITING', 'IN_MATCH')`)]);
export const roomPlayers = pgTable('room_players', {
  roomId: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }), playerId: text('player_id').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id), deckId: text('deck_id').notNull().references(() => decks.id), seatOrder: integer('seat_order').notNull(),
  nextGameDeck: jsonb('next_game_deck').$type<{ mainboard: string[]; sideboard: string[] }>(),
  nextGameConfirmed: boolean('next_game_confirmed').notNull().default(false),
}, (t) => [
  primaryKey({ columns: [t.roomId, t.playerId] }), unique('room_players_player_id_uq').on(t.playerId),
  uniqueIndex('room_players_user_id_uq').on(t.userId), unique('room_players_room_seat_uq').on(t.roomId, t.seatOrder),
  check('room_players_seat_check', sql`${t.seatOrder} in (0, 1)`),
]);
export const matches = pgTable('matches', {
  id: id('id'), roomId: text('room_id').notNull().unique(), status: text('status').notNull(),
  currentGameNumber: integer('current_game_number').notNull(), activeGameId: text('active_game_id'), createdAt: createdAt(),
}, (t) => [
  check('matches_status_check', sql`${t.status} in ('ACTIVE', 'ENDED')`),
  check('matches_game_number_check', sql`${t.currentGameNumber} between 1 and 5`),
]);
export const matchPlayers = pgTable('match_players', {
  matchId: text('match_id').notNull().references(() => matches.id, { onDelete: 'cascade' }), roomId: text('room_id').notNull(),
  playerId: text('player_id').notNull(), seatOrder: integer('seat_order').notNull(),
}, (t) => [
  primaryKey({ columns: [t.matchId, t.playerId] }), unique('match_players_seat_uq').on(t.matchId, t.seatOrder),
  foreignKey({ columns: [t.roomId, t.playerId], foreignColumns: [roomPlayers.roomId, roomPlayers.playerId] }).onDelete('cascade'),
  check('match_players_seat_check', sql`${t.seatOrder} in (0, 1)`),
]);
export const games = pgTable('games', {
  id: id('id'), matchId: text('match_id').notNull().references(() => matches.id, { onDelete: 'cascade' }), gameNumber: integer('game_number').notNull(),
  status: text('status').notNull(), currentSequence: integer('current_sequence').notNull().default(0),
  allPlayersDisconnectedAt: timestamp('all_players_disconnected_at', { withTimezone: true }), createdAt: createdAt(),
}, (t) => [
  unique('games_match_number_uq').on(t.matchId, t.gameNumber), check('games_number_check', sql`${t.gameNumber} between 1 and 5`),
  check('games_status_check', sql`${t.status} in ('WAITING', 'PLAYING', 'FINISHED', 'ABANDONED')`),
  check('games_sequence_check', sql`${t.currentSequence} >= 0`),
]);
export const gameStates = pgTable('game_states', {
  gameId: text('game_id').primaryKey().references(() => games.id, { onDelete: 'cascade' }), state: jsonb('state').$type<Record<string, unknown>>().notNull(),
});
export const deckSnapshots = pgTable('deck_snapshots', {
  gameId: text('game_id').notNull().references(() => games.id, { onDelete: 'cascade' }), playerId: text('player_id').notNull(),
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
}, (t) => [primaryKey({ columns: [t.gameId, t.playerId] })]);
export const gameEvents = pgTable('game_events', {
  eventId: uuid('event_id').primaryKey(), gameId: text('game_id').notNull().references(() => games.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(), event: jsonb('event').$type<Record<string, unknown>>().notNull(), createdAt: createdAt(),
}, (t) => [unique('game_events_game_sequence_uq').on(t.gameId, t.sequence), check('game_events_sequence_check', sql`${t.sequence} > 0`)]);
export const gameEventViews = pgTable('game_event_views', {
  eventId: uuid('event_id').notNull().references(() => gameEvents.eventId, { onDelete: 'cascade' }), recipientPlayerId: text('recipient_player_id').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
}, (t) => [primaryKey({ columns: [t.eventId, t.recipientPlayerId] })]);
export const gameCardDefinitionRefs = pgTable('game_card_definition_refs', {
  gameId: text('game_id').notNull().references(() => games.id, { onDelete: 'cascade' }), cardDefinitionId: text('card_definition_id').notNull(), version: integer('version').notNull(),
}, (t) => [
  primaryKey({ columns: [t.gameId, t.cardDefinitionId, t.version] }),
  foreignKey({ columns: [t.cardDefinitionId, t.version], foreignColumns: [cardDefinitionVersions.cardDefinitionId, cardDefinitionVersions.version] }),
]);
export const commandResults = pgTable('command_results', {
  commandId: text('command_id').primaryKey(), gameId: text('game_id').notNull().references(() => games.id, { onDelete: 'cascade' }),
  actorPlayerId: text('actor_player_id').notNull(), fingerprint: text('fingerprint').notNull(), result: jsonb('result').$type<Record<string, unknown>>().notNull(), createdAt: createdAt(),
});
export const viewStates = pgTable('view_states', {
  gameId: text('game_id').notNull().references(() => games.id, { onDelete: 'cascade' }), viewerPlayerId: text('viewer_player_id').notNull(),
  viewId: text('view_id').notNull().unique(), state: jsonb('state').$type<Record<string, unknown>>().notNull(),
}, (t) => [primaryKey({ columns: [t.gameId, t.viewerPlayerId] })]);
export const adminRequestResults = pgTable('admin_request_results', {
  adminId: text('admin_id').notNull(), requestId: text('request_id').notNull(), fingerprint: text('fingerprint').notNull(),
  httpStatus: integer('http_status').notNull(), responseBody: jsonb('response_body').$type<Record<string, unknown>>().notNull(), createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.adminId, t.requestId] }), index('admin_request_results_created_at_idx').on(t.createdAt)]);
