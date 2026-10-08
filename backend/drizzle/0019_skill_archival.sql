CREATE TABLE "archived_coach_skills" (
	"learning_path_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"archived_at" timestamp with time zone NOT NULL,
	"definition" jsonb NOT NULL,
	CONSTRAINT "archived_coach_skills_learning_path_id_skill_id_pk" PRIMARY KEY("learning_path_id","skill_id")
);
--> statement-breakpoint
ALTER TABLE "personal_skills" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "archived_coach_skills" ADD CONSTRAINT "archived_coach_skills_skill_id_learning_path_id_skills_id_learning_path_id_fk" FOREIGN KEY ("skill_id","learning_path_id") REFERENCES "public"."skills"("id","learning_path_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- The retained Draft snapshot is authoritative history, not an editable cache.
CREATE FUNCTION protect_archived_coach_skill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Archived Coach Skill definitions are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER archived_coach_skills_immutable BEFORE UPDATE OR DELETE ON archived_coach_skills
FOR EACH ROW EXECUTE FUNCTION protect_archived_coach_skill();