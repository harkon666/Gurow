# Review immutable Submission Revisions

Each Submission belongs to exactly one task, each sending produces an immutable Submission Revision, and each Review refers to exactly one revision so approval remains tied to the task and contents the coach assessed. Corrections require a new revision rather than replacing submitted content; within the same Submission, a newer revision supersedes earlier undecided revisions, which can no longer receive a Review decision. This preserves assessment history and keeps pending reviews focused on current work, at the cost of retaining multiple versions, requiring resubmission for small corrections, and potentially repeating review work when a new revision arrives during assessment.

For MVP coach mode, a Task within an Enrollment has at most one Submission, with successive attempts represented by its Submission Revisions. This keeps corrections in one history, at the cost of not supporting separate parallel attempt histories for the same Task and Enrollment.

Learners may save and edit Submission Drafts whose contents are visible only to themselves. The Coach sees the contents sent as a Submission Revision. This gives learners private working space, at the cost of the Coach being unable to read work in progress before it is sent.

For the MVP, Submission contents are text and URLs; direct file uploads are deferred to limit file-management requirements. Photos, PDFs, and videos therefore need external hosting and a link. The immutable Revision preserves the submitted text and URLs, not a frozen copy of content at those URLs. When stable evidence is needed, the Coach requests version-specific links or important content copied into the Submission. External content may still change or become unavailable; revision immutability does not guarantee external evidence integrity or continued availability.

MVP coach mode has two Review decisions: Approval and Changes Requested. Changes Requested requires feedback, and corrections are sent as a new Revision when the learner has Access. This gives learners a clear next step, at the cost of deferring numeric grading and permanent rejection.

The same project evidence may be reused for another task through a separate Submission and Review; Approval does not transfer across tasks. This keeps each task's assessment explicit at the cost of repeated submission and review work for projects covering several tasks.

Once a revision has been approved, a learner with Access may send a newer revision without invalidating the existing Approval or its contribution to Mastery. The newer revision requires its own Review and does not inherit Approval, so the latest revision can be pending while earlier approved work continues to support Mastery.

An authorized coach may explicitly revoke an Approval for a specific revision with a mandatory recorded reason. The original decision remains in the review history, while the revoked Approval ceases to count as valid evidence for Mastery, allowing assessment errors to be corrected without erasing the earlier decision.

After an Approval Revocation, coach-mode Mastery is automatically reevaluated using the remaining valid Approvals: it is retained if its requirements are still satisfied and revoked otherwise, while the history of its award is preserved. This keeps Mastery grounded in valid evidence but allows a coach's correction to remove Mastery without a separate revocation decision.
