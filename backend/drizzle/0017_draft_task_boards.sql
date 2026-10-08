CREATE TABLE "draft_board_cards" (
	"learning_path_version_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "draft_board_cards_pk" PRIMARY KEY("learning_path_version_id","task_id"),
	CONSTRAINT "draft_board_cards_position_key" UNIQUE("column_id","position")
);
--> statement-breakpoint
CREATE TABLE "draft_board_columns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"learning_path_version_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "draft_board_columns_id_board_key" UNIQUE("id","learning_path_version_id","skill_id"),
	CONSTRAINT "draft_board_columns_position_key" UNIQUE("learning_path_version_id","skill_id","position"),
	CONSTRAINT "draft_board_columns_name" CHECK (length(trim("draft_board_columns"."name")) > 0 AND length("draft_board_columns"."name") <= 60)
);
--> statement-breakpoint
CREATE TABLE "draft_task_boards" (
	"learning_path_version_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_task_boards_pk" PRIMARY KEY("learning_path_version_id","skill_id"),
	CONSTRAINT "draft_task_boards_revision_nonnegative" CHECK ("draft_task_boards"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "draft_board_cards" ADD CONSTRAINT "draft_board_cards_task_fk" FOREIGN KEY ("learning_path_version_id","task_id") REFERENCES "public"."version_tasks"("learning_path_version_id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_board_cards" ADD CONSTRAINT "draft_board_cards_task_skill_fk" FOREIGN KEY ("task_id","skill_id") REFERENCES "public"."tasks"("id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_board_cards" ADD CONSTRAINT "draft_board_cards_column_fk" FOREIGN KEY ("column_id","learning_path_version_id","skill_id") REFERENCES "public"."draft_board_columns"("id","learning_path_version_id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_board_columns" ADD CONSTRAINT "draft_board_columns_board_fk" FOREIGN KEY ("learning_path_version_id","skill_id") REFERENCES "public"."draft_task_boards"("learning_path_version_id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_task_boards" ADD CONSTRAINT "draft_task_boards_skill_fk" FOREIGN KEY ("learning_path_version_id","skill_id") REFERENCES "public"."version_skills"("learning_path_version_id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A Draft's preparation board is part of that Draft: once the Version is published
-- its board can no longer change (ADR 0029), like the rest of the Version's rows.
-- Board writes lock the Version FOR SHARE, so they serialize with a publication.
CREATE TRIGGER draft_task_boards_published_immutable BEFORE INSERT OR UPDATE OR DELETE ON draft_task_boards
FOR EACH ROW EXECUTE FUNCTION protect_published_version_content();
--> statement-breakpoint
CREATE TRIGGER draft_board_columns_published_immutable BEFORE INSERT OR UPDATE OR DELETE ON draft_board_columns
FOR EACH ROW EXECUTE FUNCTION protect_published_version_content();
--> statement-breakpoint
CREATE TRIGGER draft_board_cards_published_immutable BEFORE INSERT OR UPDATE OR DELETE ON draft_board_cards
FOR EACH ROW EXECUTE FUNCTION protect_published_version_content();
--> statement-breakpoint
-- A preparation board keeps at least one column, so its Tasks always have a place.
CREATE FUNCTION check_draft_board_shape() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM draft_task_boards WHERE learning_path_version_id = OLD.learning_path_version_id AND skill_id = OLD.skill_id)
    AND NOT EXISTS (SELECT 1 FROM draft_board_columns WHERE learning_path_version_id = OLD.learning_path_version_id AND skill_id = OLD.skill_id) THEN
    RAISE EXCEPTION 'A Draft Task Board keeps at least one column' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER draft_board_columns_shape AFTER DELETE ON draft_board_columns
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_draft_board_shape();
