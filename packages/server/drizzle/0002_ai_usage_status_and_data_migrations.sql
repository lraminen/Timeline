CREATE TABLE "data_migrations" (
	"name" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "status" text DEFAULT 'completed' NOT NULL;