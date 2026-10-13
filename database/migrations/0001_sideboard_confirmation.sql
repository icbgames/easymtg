ALTER TABLE "room_players" ADD COLUMN "next_game_deck" jsonb;
--> statement-breakpoint
ALTER TABLE "room_players" ADD COLUMN "next_game_confirmed" boolean DEFAULT false NOT NULL;
