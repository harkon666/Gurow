-- A published Learning Path Version's learning content and rules are immutable
-- (ADR 0005): its Skill, Task and Prerequisite definitions can be neither added,
-- changed nor removed, and the Version itself can be neither unpublished nor
-- deleted. Changes go into a Draft, published as a new Version. The Version's
-- Canvas Layout (version_skill_cards) stays editable, and so does its Enrollment
-- Closure. Migration 0013 also locks Drafts, so these writes serialize with publication.
CREATE FUNCTION protect_published_version_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM learning_path_versions WHERE id = OLD.learning_path_version_id AND published_at IS NOT NULL FOR SHARE) THEN
    RAISE EXCEPTION 'Published Learning Path Version content is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP <> 'DELETE' AND EXISTS (SELECT 1 FROM learning_path_versions WHERE id = NEW.learning_path_version_id AND published_at IS NOT NULL FOR SHARE) THEN
    RAISE EXCEPTION 'Published Learning Path Version content is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER version_skills_published_immutable BEFORE INSERT OR UPDATE OR DELETE ON version_skills
FOR EACH ROW EXECUTE FUNCTION protect_published_version_content();
--> statement-breakpoint
CREATE TRIGGER version_tasks_published_immutable BEFORE INSERT OR UPDATE OR DELETE ON version_tasks
FOR EACH ROW EXECUTE FUNCTION protect_published_version_content();
--> statement-breakpoint
CREATE TRIGGER version_prerequisites_published_immutable BEFORE INSERT OR UPDATE OR DELETE ON version_prerequisites
FOR EACH ROW EXECUTE FUNCTION protect_published_version_content();
--> statement-breakpoint
CREATE FUNCTION protect_published_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'A published Learning Path Version cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.published_at IS NOT NULL AND (NEW.published_at IS DISTINCT FROM OLD.published_at
    OR NEW.learning_path_id <> OLD.learning_path_id OR NEW.version_number <> OLD.version_number OR NEW.id <> OLD.id) THEN
    RAISE EXCEPTION 'A published Learning Path Version is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER learning_path_versions_published_immutable BEFORE UPDATE OR DELETE ON learning_path_versions
FOR EACH ROW EXECUTE FUNCTION protect_published_version();
