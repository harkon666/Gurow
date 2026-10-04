CREATE TABLE "mastery_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mastery_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"enrollment_id" uuid NOT NULL,
	"learning_path_version_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"actor_account_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"action" text NOT NULL,
	CONSTRAINT "mastery_events_action" CHECK ("mastery_events"."action" IN ('award', 'revocation'))
);
--> statement-breakpoint
CREATE TABLE "xp_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "xp_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"enrollment_id" uuid NOT NULL,
	"learning_path_version_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"actor_account_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"amount" integer NOT NULL,
	CONSTRAINT "xp_events_kind" CHECK ("xp_events"."kind" IN ('award', 'correction')),
	CONSTRAINT "xp_events_nonzero" CHECK ("xp_events"."amount" <> 0)
);
--> statement-breakpoint
ALTER TABLE "submission_reviews" ADD COLUMN "revoked_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "mastery_events" ADD CONSTRAINT "mastery_events_revision_id_submission_reviews_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."submission_reviews"("revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery_events" ADD CONSTRAINT "mastery_events_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery_events" ADD CONSTRAINT "mastery_events_enrollment_id_learning_path_version_id_enrollments_id_learning_path_version_id_fk" FOREIGN KEY ("enrollment_id","learning_path_version_id") REFERENCES "public"."enrollments"("id","learning_path_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery_events" ADD CONSTRAINT "mastery_events_learning_path_version_id_skill_id_version_skills_learning_path_version_id_skill_id_fk" FOREIGN KEY ("learning_path_version_id","skill_id") REFERENCES "public"."version_skills"("learning_path_version_id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_revision_id_submission_reviews_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."submission_reviews"("revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_enrollment_id_learning_path_version_id_enrollments_id_learning_path_version_id_fk" FOREIGN KEY ("enrollment_id","learning_path_version_id") REFERENCES "public"."enrollments"("id","learning_path_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_learning_path_version_id_task_id_version_tasks_learning_path_version_id_task_id_fk" FOREIGN KEY ("learning_path_version_id","task_id") REFERENCES "public"."version_tasks"("learning_path_version_id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_reviews" ADD CONSTRAINT "submission_reviews_revoked_by_account_id_accounts_id_fk" FOREIGN KEY ("revoked_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Replay known historical evidence. Unknown revocation actors remain NULL; no
-- migration-time event or fictional Coach/time is substituted. Equal timestamps
-- form one coherent snapshot because their original ordering is unknowable.
CREATE TEMP TABLE t10_evidence ON COMMIT DROP AS
SELECT s.enrollment_id, s.learning_path_version_id, s.task_id, r.revision_id,
       r.coach_account_id, r.decided_at, r.revoked_at, r.revoked_by_account_id
FROM submissions s JOIN submission_revisions v ON v.submission_id = s.id
JOIN submission_reviews r ON r.revision_id = v.id
JOIN learning_path_versions pv ON pv.id = s.learning_path_version_id
JOIN learning_paths p ON p.id = pv.learning_path_id
JOIN coach_workspaces w ON w.id = p.coach_workspace_id
WHERE r.decision = 'approval' AND r.coach_account_id = w.owner_account_id AND v.superseded_at IS NULL;
--> statement-breakpoint
CREATE TEMP TABLE t10_snapshots ON COMMIT DROP AS
WITH moments AS (
  SELECT enrollment_id, learning_path_version_id, decided_at AS occurred_at FROM t10_evidence
  UNION
  SELECT enrollment_id, learning_path_version_id, revoked_at FROM t10_evidence WHERE revoked_at IS NOT NULL
)
SELECT m.*, t.task_id, t.skill_id, t.required, t.xp_reward,
  EXISTS (SELECT 1 FROM t10_evidence e WHERE e.enrollment_id = m.enrollment_id AND e.learning_path_version_id = m.learning_path_version_id AND e.task_id = t.task_id
    AND e.decided_at <= m.occurred_at AND (e.revoked_at IS NULL OR e.revoked_at > m.occurred_at)) AS approved,
  EXISTS (SELECT 1 FROM t10_evidence e WHERE e.enrollment_id = m.enrollment_id AND e.learning_path_version_id = m.learning_path_version_id AND e.task_id = t.task_id
    AND e.decided_at < m.occurred_at AND (e.revoked_at IS NULL OR e.revoked_at >= m.occurred_at)) AS approved_before
FROM moments m JOIN version_tasks t ON t.learning_path_version_id = m.learning_path_version_id;
--> statement-breakpoint
-- Grouping simultaneous state changes does not erase their known Task ownership.
-- Select a cause only from evidence that actually changed this Task's contribution.
INSERT INTO xp_events (enrollment_id, learning_path_version_id, task_id, revision_id, actor_account_id, occurred_at, kind, amount)
SELECT transitions.enrollment_id, transitions.learning_path_version_id, transitions.task_id, cause.revision_id,
       CASE WHEN contribution > prior THEN cause.coach_account_id ELSE cause.revoked_by_account_id END,
       transitions.occurred_at,
       CASE WHEN prior = 0 AND row_number() OVER (PARTITION BY transitions.enrollment_id, transitions.task_id ORDER BY transitions.occurred_at) = 1 THEN 'award' ELSE 'correction' END,
       contribution - prior
FROM (
  SELECT *, lag(contribution, 1, 0) OVER (PARTITION BY enrollment_id, task_id ORDER BY occurred_at) AS prior
  FROM (SELECT *, CASE WHEN approved THEN xp_reward ELSE 0 END AS contribution FROM t10_snapshots) c
) transitions
CROSS JOIN LATERAL (
  SELECT e.* FROM t10_evidence e
  WHERE e.enrollment_id = transitions.enrollment_id AND e.learning_path_version_id = transitions.learning_path_version_id AND e.task_id = transitions.task_id
    AND ((contribution > prior AND e.decided_at = transitions.occurred_at AND (e.revoked_at IS NULL OR e.revoked_at > transitions.occurred_at))
      OR (contribution < prior AND e.revoked_at = transitions.occurred_at AND e.decided_at < transitions.occurred_at))
  ORDER BY e.revision_id LIMIT 1
) cause
WHERE contribution <> prior ORDER BY transitions.occurred_at, transitions.enrollment_id, transitions.task_id;
--> statement-breakpoint
-- Mastery causes must change a Required Task of this Skill; an Enrichment review
-- or a redundant Approval on an already qualifying Required Task is not a cause.
INSERT INTO mastery_events (enrollment_id, learning_path_version_id, skill_id, revision_id, actor_account_id, occurred_at, action)
SELECT transitions.enrollment_id, transitions.learning_path_version_id, transitions.skill_id, cause.revision_id,
       CASE WHEN mastered THEN cause.coach_account_id ELSE cause.revoked_by_account_id END,
       transitions.occurred_at, CASE WHEN mastered THEN 'award' ELSE 'revocation' END
FROM (
  SELECT *, lag(mastered, 1, false) OVER (PARTITION BY enrollment_id, skill_id ORDER BY occurred_at) AS prior
  FROM (
    SELECT enrollment_id, learning_path_version_id, skill_id, occurred_at, bool_and(approved) AS mastered
    FROM t10_snapshots WHERE required
    GROUP BY enrollment_id, learning_path_version_id, skill_id, occurred_at
  ) states
) transitions
CROSS JOIN LATERAL (
  SELECT e.* FROM t10_evidence e
  JOIN t10_snapshots task ON task.enrollment_id = e.enrollment_id AND task.learning_path_version_id = e.learning_path_version_id AND task.task_id = e.task_id
  WHERE task.enrollment_id = transitions.enrollment_id AND task.learning_path_version_id = transitions.learning_path_version_id
    AND task.skill_id = transitions.skill_id AND task.required AND task.occurred_at = transitions.occurred_at
    AND ((mastered AND task.approved AND NOT task.approved_before AND e.decided_at = transitions.occurred_at AND (e.revoked_at IS NULL OR e.revoked_at > transitions.occurred_at))
      OR (NOT mastered AND NOT task.approved AND task.approved_before AND e.revoked_at = transitions.occurred_at AND e.decided_at < transitions.occurred_at))
  ORDER BY e.revision_id LIMIT 1
) cause
WHERE mastered <> prior ORDER BY transitions.occurred_at, transitions.enrollment_id, transitions.skill_id;