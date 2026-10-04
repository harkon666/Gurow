CREATE TABLE "override_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" integer GENERATED ALWAYS AS IDENTITY (sequence name "override_records_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"enrollment_id" uuid NOT NULL,
	"learning_path_version_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"coach_account_id" uuid NOT NULL,
	"learner_account_id" uuid NOT NULL,
	"action" text NOT NULL,
	"grant_record_id" uuid,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "override_records_sequence_key" UNIQUE("sequence"),
	CONSTRAINT "override_records_action" CHECK (("override_records"."action" = 'grant' AND "override_records"."grant_record_id" IS NULL) OR ("override_records"."action" = 'revoke' AND "override_records"."grant_record_id" IS NOT NULL)),
	CONSTRAINT "override_records_reason" CHECK (length(trim("override_records"."reason")) > 0 AND length("override_records"."reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "override_records" ADD CONSTRAINT "override_records_coach_account_id_accounts_id_fk" FOREIGN KEY ("coach_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "override_records" ADD CONSTRAINT "override_records_learner_account_id_accounts_id_fk" FOREIGN KEY ("learner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "override_records" ADD CONSTRAINT "override_records_grant_record_id_override_records_id_fk" FOREIGN KEY ("grant_record_id") REFERENCES "public"."override_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "override_records" ADD CONSTRAINT "override_records_enrollment_id_learning_path_version_id_enrollments_id_learning_path_version_id_fk" FOREIGN KEY ("enrollment_id","learning_path_version_id") REFERENCES "public"."enrollments"("id","learning_path_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "override_records" ADD CONSTRAINT "override_records_learning_path_version_id_skill_id_version_skills_learning_path_version_id_skill_id_fk" FOREIGN KEY ("learning_path_version_id","skill_id") REFERENCES "public"."version_skills"("learning_path_version_id","skill_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Audit is append-only; grant and withdrawal records cannot be rewritten.
CREATE FUNCTION protect_override_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Override Records are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER override_records_immutable BEFORE UPDATE OR DELETE ON override_records
FOR EACH ROW EXECUTE FUNCTION protect_override_record();