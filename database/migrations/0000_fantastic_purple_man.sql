CREATE TABLE "admin_request_results" (
	"admin_id" text NOT NULL,
	"request_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"http_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_request_results_admin_id_request_id_pk" PRIMARY KEY("admin_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "card_definition_versions" (
	"card_definition_id" text NOT NULL,
	"version" integer NOT NULL,
	"english_name" text NOT NULL,
	"japanese_name" text,
	"back_name" text,
	"has_back" boolean NOT NULL,
	"front_image_url" text NOT NULL,
	"back_image_url" text,
	"change_description" text,
	"rules_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_definition_versions_card_definition_id_version_pk" PRIMARY KEY("card_definition_id","version")
);
--> statement-breakpoint
CREATE TABLE "card_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"current_version" integer NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "card_definitions_status_check" CHECK ("card_definitions"."status" in ('ENABLED', 'DISABLED'))
);
--> statement-breakpoint
CREATE TABLE "command_results" (
	"command_id" text PRIMARY KEY NOT NULL,
	"game_id" text NOT NULL,
	"actor_player_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deck_snapshots" (
	"game_id" text NOT NULL,
	"player_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "deck_snapshots_game_id_player_id_pk" PRIMARY KEY("game_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "decks" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mainboard" jsonb NOT NULL,
	"sideboard" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_card_definition_refs" (
	"game_id" text NOT NULL,
	"card_definition_id" text NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "game_card_definition_refs_game_id_card_definition_id_version_pk" PRIMARY KEY("game_id","card_definition_id","version")
);
--> statement-breakpoint
CREATE TABLE "game_event_views" (
	"event_id" uuid NOT NULL,
	"recipient_player_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "game_event_views_event_id_recipient_player_id_pk" PRIMARY KEY("event_id","recipient_player_id")
);
--> statement-breakpoint
CREATE TABLE "game_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"game_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_events_game_sequence_uq" UNIQUE("game_id","sequence"),
	CONSTRAINT "game_events_sequence_check" CHECK ("game_events"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "game_states" (
	"game_id" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"game_number" integer NOT NULL,
	"status" text NOT NULL,
	"current_sequence" integer DEFAULT 0 NOT NULL,
	"all_players_disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "games_match_number_uq" UNIQUE("match_id","game_number"),
	CONSTRAINT "games_number_check" CHECK ("games"."game_number" between 1 and 5),
	CONSTRAINT "games_status_check" CHECK ("games"."status" in ('WAITING', 'PLAYING', 'FINISHED', 'ABANDONED')),
	CONSTRAINT "games_sequence_check" CHECK ("games"."current_sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "match_players" (
	"match_id" text NOT NULL,
	"room_id" text NOT NULL,
	"player_id" text NOT NULL,
	"seat_order" integer NOT NULL,
	CONSTRAINT "match_players_match_id_player_id_pk" PRIMARY KEY("match_id","player_id"),
	CONSTRAINT "match_players_seat_uq" UNIQUE("match_id","seat_order"),
	CONSTRAINT "match_players_seat_check" CHECK ("match_players"."seat_order" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"status" text NOT NULL,
	"current_game_number" integer NOT NULL,
	"active_game_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_room_id_unique" UNIQUE("room_id"),
	CONSTRAINT "matches_status_check" CHECK ("matches"."status" in ('ACTIVE', 'ENDED')),
	CONSTRAINT "matches_game_number_check" CHECK ("matches"."current_game_number" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "room_players" (
	"room_id" text NOT NULL,
	"player_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"deck_id" text NOT NULL,
	"seat_order" integer NOT NULL,
	CONSTRAINT "room_players_room_id_player_id_pk" PRIMARY KEY("room_id","player_id"),
	CONSTRAINT "room_players_player_id_uq" UNIQUE("player_id"),
	CONSTRAINT "room_players_room_seat_uq" UNIQUE("room_id","seat_order"),
	CONSTRAINT "room_players_seat_check" CHECK ("room_players"."seat_order" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_player_id" text NOT NULL,
	"status" text NOT NULL,
	"match_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_status_check" CHECK ("rooms"."status" in ('WAITING', 'IN_MATCH'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "view_states" (
	"game_id" text NOT NULL,
	"viewer_player_id" text NOT NULL,
	"view_id" text NOT NULL,
	"state" jsonb NOT NULL,
	CONSTRAINT "view_states_game_id_viewer_player_id_pk" PRIMARY KEY("game_id","viewer_player_id"),
	CONSTRAINT "view_states_view_id_unique" UNIQUE("view_id")
);
--> statement-breakpoint
ALTER TABLE "card_definition_versions" ADD CONSTRAINT "card_definition_versions_card_definition_id_card_definitions_id_fk" FOREIGN KEY ("card_definition_id") REFERENCES "public"."card_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_results" ADD CONSTRAINT "command_results_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deck_snapshots" ADD CONSTRAINT "deck_snapshots_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_card_definition_refs" ADD CONSTRAINT "game_card_definition_refs_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_card_definition_refs" ADD CONSTRAINT "game_card_definition_refs_card_definition_id_version_card_definition_versions_card_definition_id_version_fk" FOREIGN KEY ("card_definition_id","version") REFERENCES "public"."card_definition_versions"("card_definition_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_event_views" ADD CONSTRAINT "game_event_views_event_id_game_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."game_events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_states" ADD CONSTRAINT "game_states_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_room_id_player_id_room_players_room_id_player_id_fk" FOREIGN KEY ("room_id","player_id") REFERENCES "public"."room_players"("room_id","player_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_players" ADD CONSTRAINT "room_players_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_players" ADD CONSTRAINT "room_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_players" ADD CONSTRAINT "room_players_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_states" ADD CONSTRAINT "view_states_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_request_results_created_at_idx" ON "admin_request_results" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "card_definitions_status_id_idx" ON "card_definitions" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "decks_owner_id_idx" ON "decks" USING btree ("owner_user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_players_user_id_uq" ON "room_players" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
-- Cross-aggregate references are deferred so lifecycle graphs can be created
-- and removed atomically within their documented transactions.
ALTER TABLE "card_definitions" ADD CONSTRAINT "card_definitions_current_version_fk"
  FOREIGN KEY ("id", "current_version") REFERENCES "card_definition_versions" ("card_definition_id", "version")
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_room_id_fk"
  FOREIGN KEY ("room_id") REFERENCES "rooms" ("id") DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_match_id_fk"
  FOREIGN KEY ("match_id") REFERENCES "matches" ("id") DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_owner_participant_fk"
  FOREIGN KEY ("id", "owner_player_id") REFERENCES "room_players" ("room_id", "player_id")
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_match_presence_check"
  CHECK (("status" = 'IN_MATCH') = ("match_id" IS NOT NULL));
