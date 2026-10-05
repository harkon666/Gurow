CREATE TYPE "public"."invitation_delivery_status" AS ENUM('pending', 'sent', 'logged', 'failed');--> statement-breakpoint
ALTER TABLE "enrollment_invitations" ADD COLUMN "delivery_status" "invitation_delivery_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollment_invitations" ADD COLUMN "delivery_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollment_invitations" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "enrollment_invitations_version_idx" ON "enrollment_invitations" USING btree ("learning_path_version_id");