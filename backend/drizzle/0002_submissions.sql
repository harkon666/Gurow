ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_id_version_key" UNIQUE("id","learning_path_version_id");--> statement-breakpoint
CREATE TABLE "submission_drafts" (
	"enrollment_id" uuid NOT NULL,
	"learning_path_version_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"text" text NOT NULL,
	"urls" text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_drafts_enrollment_id_task_id_pk" PRIMARY KEY("enrollment_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "submission_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"text" text NOT NULL,
	"urls" text[] NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "submission_revisions_submission_number_key" UNIQUE("submission_id","revision_number")
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"learning_path_version_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submissions_enrollment_task_key" UNIQUE("enrollment_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "submission_drafts" ADD CONSTRAINT "submission_drafts_enrollment_id_learning_path_version_id_enrollments_id_learning_path_version_id_fk" FOREIGN KEY ("enrollment_id","learning_path_version_id") REFERENCES "public"."enrollments"("id","learning_path_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_drafts" ADD CONSTRAINT "submission_drafts_learning_path_version_id_task_id_version_tasks_learning_path_version_id_task_id_fk" FOREIGN KEY ("learning_path_version_id","task_id") REFERENCES "public"."version_tasks"("learning_path_version_id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_revisions" ADD CONSTRAINT "submission_revisions_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_enrollment_id_learning_path_version_id_enrollments_id_learning_path_version_id_fk" FOREIGN KEY ("enrollment_id","learning_path_version_id") REFERENCES "public"."enrollments"("id","learning_path_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_learning_path_version_id_task_id_version_tasks_learning_path_version_id_task_id_fk" FOREIGN KEY ("learning_path_version_id","task_id") REFERENCES "public"."version_tasks"("learning_path_version_id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint--> statement-breakpoint
-- Sent contents are immutable (ADR 0002): a correction is a new revision. Only
-- superseded_at may change, once, from null to a time.
CREATE FUNCTION "submission_revisions_reject_edit"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.submission_id IS DISTINCT FROM OLD.submission_id
		OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
		OR NEW.text IS DISTINCT FROM OLD.text
		OR NEW.urls IS DISTINCT FROM OLD.urls
		OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
		OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
		RAISE EXCEPTION 'submission revision % is immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "submission_revisions_immutable" BEFORE UPDATE ON "submission_revisions" FOR EACH ROW EXECUTE FUNCTION "submission_revisions_reject_edit"();
