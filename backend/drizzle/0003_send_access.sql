CREATE TYPE "public"."review_decision" AS ENUM('approval', 'changes_requested');--> statement-breakpoint
CREATE TABLE "submission_reviews" (
	"revision_id" uuid PRIMARY KEY NOT NULL,
	"coach_account_id" uuid NOT NULL,
	"decision" "review_decision" NOT NULL,
	"feedback" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "submission_reviews_changes_feedback" CHECK ("submission_reviews"."decision" <> 'changes_requested' OR length(trim("submission_reviews"."feedback")) > 0 AND "submission_reviews"."feedback" IS NOT NULL),
	CONSTRAINT "submission_reviews_revocation" CHECK (("submission_reviews"."revoked_at" IS NULL AND "submission_reviews"."revocation_reason" IS NULL) OR ("submission_reviews"."decision" = 'approval' AND "submission_reviews"."revoked_at" IS NOT NULL AND "submission_reviews"."revocation_reason" IS NOT NULL AND length(trim("submission_reviews"."revocation_reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "version_prerequisites" (
	"learning_path_version_id" uuid NOT NULL,
	"prerequisite_skill_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	CONSTRAINT "version_prerequisites_pk" PRIMARY KEY("learning_path_version_id","prerequisite_skill_id","skill_id"),
	CONSTRAINT "version_prerequisites_no_self_edge" CHECK ("version_prerequisites"."prerequisite_skill_id" <> "version_prerequisites"."skill_id")
);
--> statement-breakpoint
ALTER TABLE "version_skills" ADD COLUMN "xp_threshold" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "version_tasks" ADD COLUMN "xp_reward" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_reviews" ADD CONSTRAINT "submission_reviews_revision_id_submission_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."submission_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_reviews" ADD CONSTRAINT "submission_reviews_coach_account_id_accounts_id_fk" FOREIGN KEY ("coach_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_prerequisites" ADD CONSTRAINT "version_prerequisites_source_fk" FOREIGN KEY ("learning_path_version_id","prerequisite_skill_id") REFERENCES "public"."version_skills"("learning_path_version_id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_prerequisites" ADD CONSTRAINT "version_prerequisites_target_fk" FOREIGN KEY ("learning_path_version_id","skill_id") REFERENCES "public"."version_skills"("learning_path_version_id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_skills" ADD CONSTRAINT "version_skills_xp_threshold_nonnegative" CHECK ("version_skills"."xp_threshold" >= 0);--> statement-breakpoint
ALTER TABLE "version_tasks" ADD CONSTRAINT "version_tasks_xp_reward_nonnegative" CHECK ("version_tasks"."xp_reward" >= 0);