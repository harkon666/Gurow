CREATE TABLE "personal_skill_cards" (
	"learning_path_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	CONSTRAINT "personal_skill_cards_pk" PRIMARY KEY("learning_path_id","skill_id"),
	CONSTRAINT "personal_skill_cards_bounds" CHECK (abs("personal_skill_cards"."x") <= 1000000 AND abs("personal_skill_cards"."y") <= 1000000)
);
--> statement-breakpoint
ALTER TABLE "learning_paths" ADD COLUMN "goal" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "learning_paths" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_skills" ADD COLUMN "ordinal" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_tasks" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_tasks" ADD COLUMN "ordinal" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_skill_cards" ADD CONSTRAINT "personal_skill_cards_skill_fk" FOREIGN KEY ("learning_path_id","skill_id") REFERENCES "public"."personal_skills"("learning_path_id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_paths" ADD CONSTRAINT "learning_paths_revision_nonnegative" CHECK ("learning_paths"."revision" >= 0);