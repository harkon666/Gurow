-- A Version states the Path's title and goal itself, so editing a Draft never
-- changes what an earlier published Version says (ADR 0005). Existing Versions
-- take their Path's current values.
ALTER TABLE "learning_path_versions" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "learning_path_versions" ADD COLUMN "goal" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "learning_path_versions" SET "title" = p."title", "goal" = p."goal" FROM "learning_paths" p WHERE p."id" = "learning_path_versions"."learning_path_id";--> statement-breakpoint
ALTER TABLE "learning_path_versions" ALTER COLUMN "title" SET NOT NULL;--> statement-breakpoint
-- Content writes lock their Version FOR SHARE whether or not it is published, so
-- they serialize with a publication, which locks the Draft FOR UPDATE before
-- validating it: a write either commits before the publication reads the Draft,
-- or waits and then finds the Version published.
CREATE OR REPLACE FUNCTION protect_published_version_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  published timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT published_at INTO published FROM learning_path_versions WHERE id = OLD.learning_path_version_id FOR SHARE;
    IF published IS NOT NULL THEN
      RAISE EXCEPTION 'Published Learning Path Version content is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT published_at INTO published FROM learning_path_versions WHERE id = NEW.learning_path_version_id FOR SHARE;
    IF published IS NOT NULL THEN
      RAISE EXCEPTION 'Published Learning Path Version content is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_published_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'A published Learning Path Version cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.published_at IS NOT NULL AND (NEW.published_at IS DISTINCT FROM OLD.published_at
    OR NEW.learning_path_id <> OLD.learning_path_id OR NEW.version_number <> OLD.version_number OR NEW.id <> OLD.id
    OR NEW.title IS DISTINCT FROM OLD.title OR NEW.goal IS DISTINCT FROM OLD.goal) THEN
    RAISE EXCEPTION 'A published Learning Path Version is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
