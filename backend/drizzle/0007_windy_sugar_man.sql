CREATE TABLE "task_starts" (
	"enrollment_id" uuid NOT NULL,
	"learning_path_version_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_starts_enrollment_id_task_id_pk" PRIMARY KEY("enrollment_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "task_starts" ADD CONSTRAINT "task_starts_enrollment_id_learning_path_version_id_enrollments_id_learning_path_version_id_fk" FOREIGN KEY ("enrollment_id","learning_path_version_id") REFERENCES "public"."enrollments"("id","learning_path_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_starts" ADD CONSTRAINT "task_starts_learning_path_version_id_task_id_version_tasks_learning_path_version_id_task_id_fk" FOREIGN KEY ("learning_path_version_id","task_id") REFERENCES "public"."version_tasks"("learning_path_version_id","task_id") ON DELETE no action ON UPDATE no action;