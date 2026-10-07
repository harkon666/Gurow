CREATE TABLE "personal_board_cards" (
	"learning_path_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "personal_board_cards_pk" PRIMARY KEY("learning_path_id","task_id"),
	CONSTRAINT "personal_board_cards_position_key" UNIQUE("column_id","position")
);
--> statement-breakpoint
CREATE TABLE "personal_board_columns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"learning_path_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"name" text NOT NULL,
	"completion" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "personal_board_columns_id_board_key" UNIQUE("id","learning_path_id","skill_id"),
	CONSTRAINT "personal_board_columns_position_key" UNIQUE("learning_path_id","skill_id","position"),
	CONSTRAINT "personal_board_columns_name" CHECK (length(trim("personal_board_columns"."name")) > 0 AND length("personal_board_columns"."name") <= 60)
);
--> statement-breakpoint
CREATE TABLE "personal_task_boards" (
	"learning_path_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_task_boards_pk" PRIMARY KEY("learning_path_id","skill_id"),
	CONSTRAINT "personal_task_boards_revision_nonnegative" CHECK ("personal_task_boards"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "personal_board_cards" ADD CONSTRAINT "personal_board_cards_task_fk" FOREIGN KEY ("learning_path_id","task_id") REFERENCES "public"."personal_tasks"("learning_path_id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_board_cards" ADD CONSTRAINT "personal_board_cards_task_skill_fk" FOREIGN KEY ("task_id","skill_id") REFERENCES "public"."tasks"("id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_board_cards" ADD CONSTRAINT "personal_board_cards_column_fk" FOREIGN KEY ("column_id","learning_path_id","skill_id") REFERENCES "public"."personal_board_columns"("id","learning_path_id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_board_columns" ADD CONSTRAINT "personal_board_columns_board_fk" FOREIGN KEY ("learning_path_id","skill_id") REFERENCES "public"."personal_task_boards"("learning_path_id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_task_boards" ADD CONSTRAINT "personal_task_boards_skill_fk" FOREIGN KEY ("learning_path_id","skill_id") REFERENCES "public"."personal_skills"("learning_path_id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "personal_board_columns_one_completion_key" ON "personal_board_columns" USING btree ("learning_path_id","skill_id") WHERE "personal_board_columns"."completion";--> statement-breakpoint
-- A personal Task Board's membership and its Tasks' completion are one truth (ADR 0027):
-- at commit, a Task's card is in the Completion Column exactly when the Task is
-- completed, and an archived Task has no card. Checked at commit, so one transaction
-- may move a card and change the completion together, in either order.
CREATE FUNCTION check_personal_board_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  in_completion boolean;
  completed boolean;
  archived boolean;
BEGIN
  SELECT c.completion INTO in_completion FROM personal_board_cards b JOIN personal_board_columns c ON c.id = b.column_id
    WHERE b.learning_path_id = NEW.learning_path_id AND b.task_id = NEW.task_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT t.completed_at IS NOT NULL, t.archived_at IS NOT NULL INTO completed, archived FROM personal_tasks t
    WHERE t.learning_path_id = NEW.learning_path_id AND t.task_id = NEW.task_id;
  IF archived THEN
    RAISE EXCEPTION 'An archived Task cannot be on a Task Board' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF in_completion <> completed THEN
    RAISE EXCEPTION 'A Task is in the Completion Column exactly when it is completed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER personal_board_cards_membership AFTER INSERT OR UPDATE ON personal_board_cards
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_personal_board_membership();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER personal_tasks_board_membership AFTER UPDATE OF completed_at, archived_at ON personal_tasks
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_personal_board_membership();
--> statement-breakpoint
-- A board keeps exactly one Completion Column and at least one other usable column.
CREATE FUNCTION check_personal_board_shape() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  path_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.learning_path_id ELSE NEW.learning_path_id END;
  board_skill_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.skill_id ELSE NEW.skill_id END;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM personal_task_boards WHERE learning_path_id = path_id AND skill_id = board_skill_id) THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM personal_board_columns WHERE learning_path_id = path_id AND skill_id = board_skill_id AND completion) <> 1
    OR NOT EXISTS (SELECT 1 FROM personal_board_columns WHERE learning_path_id = path_id AND skill_id = board_skill_id AND NOT completion) THEN
    RAISE EXCEPTION 'A personal Task Board needs one Completion Column and another column' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- The column's committed role, not this event's row: a save may change roles in several steps.
  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM personal_board_cards b JOIN personal_board_columns c ON c.id = b.column_id
    JOIN personal_tasks t ON t.learning_path_id = b.learning_path_id AND t.task_id = b.task_id
    WHERE c.id = NEW.id AND (t.completed_at IS NOT NULL) <> c.completion) THEN
    RAISE EXCEPTION 'A Task is in the Completion Column exactly when it is completed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER personal_board_columns_shape AFTER INSERT OR UPDATE OR DELETE ON personal_board_columns
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_personal_board_shape();
