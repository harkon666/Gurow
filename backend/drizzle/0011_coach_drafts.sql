CREATE TABLE "version_skill_cards" (
	"learning_path_version_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	CONSTRAINT "version_skill_cards_pk" PRIMARY KEY("learning_path_version_id","skill_id"),
	CONSTRAINT "version_skill_cards_bounds" CHECK (abs("version_skill_cards"."x") <= 1000000 AND abs("version_skill_cards"."y") <= 1000000)
);
--> statement-breakpoint
ALTER TABLE "version_skills" ADD COLUMN "optional" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "version_skills" ADD COLUMN "ordinal" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "version_tasks" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "version_tasks" ADD COLUMN "ordinal" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "version_skill_cards" ADD CONSTRAINT "version_skill_cards_skill_fk" FOREIGN KEY ("learning_path_version_id","skill_id") REFERENCES "public"."version_skills"("learning_path_version_id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "learning_path_versions_one_draft_key" ON "learning_path_versions" USING btree ("learning_path_id") WHERE "learning_path_versions"."published_at" IS NULL;