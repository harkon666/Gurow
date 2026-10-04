CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learning_path_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	CONSTRAINT "tasks_id_skill_key" UNIQUE("id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "version_skills" (
	"learning_path_version_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"title" text NOT NULL,
	"learning_outcome" text NOT NULL,
	CONSTRAINT "version_skills_learning_path_version_id_skill_id_pk" PRIMARY KEY("learning_path_version_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "version_tasks" (
	"learning_path_version_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"title" text NOT NULL,
	"required" boolean NOT NULL,
	CONSTRAINT "version_tasks_learning_path_version_id_task_id_pk" PRIMARY KEY("learning_path_version_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_learning_path_id_learning_paths_id_fk" FOREIGN KEY ("learning_path_id") REFERENCES "public"."learning_paths"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_skills" ADD CONSTRAINT "version_skills_learning_path_version_id_learning_path_versions_id_fk" FOREIGN KEY ("learning_path_version_id") REFERENCES "public"."learning_path_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_skills" ADD CONSTRAINT "version_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_tasks" ADD CONSTRAINT "version_tasks_task_id_skill_id_tasks_id_skill_id_fk" FOREIGN KEY ("task_id","skill_id") REFERENCES "public"."tasks"("id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_tasks" ADD CONSTRAINT "version_tasks_learning_path_version_id_skill_id_version_skills_learning_path_version_id_skill_id_fk" FOREIGN KEY ("learning_path_version_id","skill_id") REFERENCES "public"."version_skills"("learning_path_version_id","skill_id") ON DELETE no action ON UPDATE no action;