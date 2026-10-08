CREATE TABLE "enrollment_board_cards" (
	"enrollment_id" uuid NOT NULL,
	"learning_path_version_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "enrollment_board_cards_pk" PRIMARY KEY("enrollment_id","task_id"),
	CONSTRAINT "enrollment_board_cards_position_key" UNIQUE("column_id","position")
);
--> statement-breakpoint
CREATE TABLE "enrollment_board_columns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "enrollment_board_columns_id_board_key" UNIQUE("id","enrollment_id","skill_id"),
	CONSTRAINT "enrollment_board_columns_position_key" UNIQUE("enrollment_id","skill_id","position"),
	CONSTRAINT "enrollment_board_columns_name" CHECK (length(trim("enrollment_board_columns"."name")) > 0 AND length("enrollment_board_columns"."name") <= 60)
);
--> statement-breakpoint
CREATE TABLE "enrollment_task_boards" (
	"enrollment_id" uuid NOT NULL,
	"learning_path_version_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollment_task_boards_pk" PRIMARY KEY("enrollment_id","skill_id"),
	CONSTRAINT "enrollment_task_boards_revision_nonnegative" CHECK ("enrollment_task_boards"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "enrollment_board_cards" ADD CONSTRAINT "enrollment_board_cards_enrollment_fk" FOREIGN KEY ("enrollment_id","learning_path_version_id") REFERENCES "public"."enrollments"("id","learning_path_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_board_cards" ADD CONSTRAINT "enrollment_board_cards_task_fk" FOREIGN KEY ("learning_path_version_id","task_id") REFERENCES "public"."version_tasks"("learning_path_version_id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_board_cards" ADD CONSTRAINT "enrollment_board_cards_task_skill_fk" FOREIGN KEY ("task_id","skill_id") REFERENCES "public"."tasks"("id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_board_cards" ADD CONSTRAINT "enrollment_board_cards_column_fk" FOREIGN KEY ("column_id","enrollment_id","skill_id") REFERENCES "public"."enrollment_board_columns"("id","enrollment_id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_board_columns" ADD CONSTRAINT "enrollment_board_columns_board_fk" FOREIGN KEY ("enrollment_id","skill_id") REFERENCES "public"."enrollment_task_boards"("enrollment_id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_task_boards" ADD CONSTRAINT "enrollment_task_boards_enrollment_fk" FOREIGN KEY ("enrollment_id","learning_path_version_id") REFERENCES "public"."enrollments"("id","learning_path_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_task_boards" ADD CONSTRAINT "enrollment_task_boards_skill_fk" FOREIGN KEY ("learning_path_version_id","skill_id") REFERENCES "public"."version_skills"("learning_path_version_id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A learner's board keeps at least one column, so its official Tasks always have a place (ADR 0030).
CREATE FUNCTION check_enrollment_board_shape() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM enrollment_task_boards WHERE enrollment_id = OLD.enrollment_id AND skill_id = OLD.skill_id)
    AND NOT EXISTS (SELECT 1 FROM enrollment_board_columns WHERE enrollment_id = OLD.enrollment_id AND skill_id = OLD.skill_id) THEN
    RAISE EXCEPTION 'A learner Task Board keeps at least one column' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER enrollment_board_columns_shape AFTER DELETE ON enrollment_board_columns
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_enrollment_board_shape();
