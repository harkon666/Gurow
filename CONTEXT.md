# Gurow Learning Domain

Canonical vocabulary for learning in Gurow. Terms are recorded as their meanings are agreed during design.

## Language

**Account**:
An identity a user can use for personal learning and contextual Coach and Learner roles, without requiring a separate Account for each role. Coach and Learner are not permanent Account types; authority is checked for each action in the relevant Learning Path.

**Coach**:
A contextual role for managing learning content and reviewing learner work. In the MVP, this role is held by a Coach Workspace's owning Account and applies to all Learning Paths in that Workspace; the role grants no authority outside that Workspace.

**Learner**:
A contextual role in which an Account works through a Learning Path. In coach mode, participation is represented by an Enrollment; the same Account may also act as a Coach in a different Coach Workspace and use personal mode.

**Personal Workspace**:
A private learning space owned by one Account and containing all of that Account's personal-mode Learning Paths. In the MVP, each Account has exactly one Personal Workspace, accessible only by its owner; shared access and collaboration are deferred. A learner's Enrollment in a coach-mode Learning Path does not grant the Coach access to the learner's Personal Workspace.

**Coach Workspace**:
A management space for coach-mode Learning Paths, serving as their ownership and management-authority boundary. A Coach Workspace can contain multiple Learning Paths, and each coach-mode Learning Path belongs to exactly one Coach Workspace. In the MVP, it has exactly one Coach who is also its owner; support for additional Coaches is deferred. The owning Account cannot hold a learner Enrollment in any Learning Path within that Workspace during the MVP.

**Learning Path**:
A learning package directed toward a specific goal, containing Skills, a Prerequisite Graph, Tasks, and progression rules. It represents the same concept in personal and coach modes; the MVP has no separate curriculum container grouping several Learning Paths.
_Avoid_: Curriculum, kurikulum (synonyms for Learning Path).

**Learning Path Draft**:
Editable, unpublished learning content and rules prepared for a coach-mode Learning Path Version. Changes to published learning content, including typo corrections, are prepared in a Draft and published as a new Version.

**Learning Path Version**:
A published, immutable edition of a coach-mode Learning Path's learning outcomes, Tasks, Prerequisites, and progression rules. All changes to its learning content or rules, including typo corrections, require a new Version while existing Enrollments remain on the Version they joined. Publication requires rules that allow all required Skills to be completed using only Required Tasks on required Skills, without depending on Optional Skills, Enrichment Tasks, or Access Overrides. XP from a locked Skill cannot count toward making that Skill accessible.

**Enrollment Closure**:
A Coach's closure of a published Learning Path Version to new Enrollments, independently of its publication status. While closed, invitations not yet accepted cannot create new Enrollments; existing Enrollments continue under their current status. The Coach may reopen the Version to new Enrollments.

**Canvas Document**:
The editable canvas representation of a Learning Path's Skill cards, Prerequisite connections, and spatial arrangement. In the MVP, it has one card per Skill in a flat structure with manual positioning; nested groups and automatic layout are deferred.

**Canvas Layout**:
The spatial arrangement of Skill cards on a Learning Path's canvas, maintained independently of its learning requirements. In MVP coach mode, each Learning Path Version has one shared Canvas Layout whose card positions are controlled by the coach; learners see its latest layout when reopening the Learning Path.

**Enrollment Invitation**:
An offer from an authorized Coach to join exactly one published Learning Path Version, addressed to a specific email address and redeemable only by an Account whose matching email is verified. Acceptance enrolls the learner in that Version only and does not automatically enroll them in other Learning Paths within the same Coach Workspace. Accepting another invitation does not reactivate an existing inactive Enrollment, and invitations cannot create new Enrollments while an Enrollment Closure applies.

**Enrollment**:
A learner's participation in one coach-mode Learning Path Version. In the MVP, each Account has at most one Enrollment per Learning Path Version; repeated invitation acceptance uses the existing Enrollment without resetting progress or creating a separate XP total. An Enrollment stays on its version throughout its learning process; migration of an Enrollment and its progress between versions is deferred. Its progress, XP, Mastery, Submissions, and Review results are visible only to its learner and the Coach who owns the relevant Coach Workspace.

**Enrollment Deactivation**:
An action making an Enrollment inactive, performed either by the owning Coach with a mandatory recorded reason or by the learner concerned without a required reason. While inactive, the learner cannot start new Tasks or send new Submissions or Submission Revisions. Existing work, Reviews, XP, and Mastery remain stored under their visibility rules: submitted work and learning history remain readable by the learner and owning Coach, while unsent Submission Draft contents remain private to the learner. Deactivation itself does not revoke Approvals or Mastery or remove XP; reactivation remains reserved for the owning Coach even when the learner chose to deactivate.

**Enrollment Reactivation**:
An explicit action reserved for the Coach who owns the relevant Coach Workspace, making an inactive Enrollment active again with a mandatory recorded reason. It retains the same Enrollment, Learning Path Version, and existing progress; Skill Access is evaluated under the applicable current rules. Repeated invitation acceptance does not perform this action.

**Skill**:
A learnable ability with a clear learning outcome that can be assessed, owned by exactly one Learning Path in the MVP. Within a versioned Learning Path, its logical ID remains stable while its definition is specific to each Learning Path Version. Reuse in another Learning Path creates an independently editable copy of the Skill definition and its Tasks with new logical IDs; matching IDs across Versions do not transfer progress between Enrollments.

**Optional Skill**:
A Skill designated as enrichment within a Learning Path in coach mode, which a learner may skip without blocking the required route. An Optional Skill must not be a Prerequisite for a required Skill in that Learning Path.

**Task**:
A learning activity owned by exactly one Skill. Within a versioned Learning Path, its logical ID remains stable while its definition is specific to each Learning Path Version. In the MVP, reuse in another Skill creates an independent copy with a new logical ID and its own learner work and Reviews; changes to the source do not automatically update the copy, and matching IDs across Versions do not transfer progress between Enrollments.

**Task Board**:
An arrangement of one Skill's active Tasks into ordered columns: personal work belongs to the personal owner, material preparation belongs to the Coach's Learning Path Draft, and learner organization belongs to one Enrollment. Board placement does not itself represent Submission, Approval, or Mastery.

**Task Board Column**:
A user-named, ordered grouping of Tasks within one Task Board. Learner columns describe the learner's working organization, while Coach Draft columns describe material readiness rather than publication eligibility or learner progress.

**Completion Column**:
The single designated column on a personal Task Board whose membership represents personal Task completion, regardless of its display name. Moving a Task into or out of it follows existing XP Award and XP Correction rules without declaring or withdrawing Mastery; a learner's column named Done does not confer Approval.

**Archival**:
Retention of learning content with its existing progress history when it is removed from active use. Permanent deletion is allowed only for content without progress history; content with such history is archived instead. Archival preserves Submissions, Reviews, XP, and Mastery under their existing visibility rules, does not itself revoke XP or Mastery, and cannot change the content of an already published coach-mode Learning Path Version.

**Required Task**:
A Task the coach designates as mandatory evidence for Mastery of its Skill. In coach mode, Mastery requires at least one Required Task and is awarded automatically when every Required Task has at least one Submission Revision with a valid Approval.

**Enrichment Task**:
A Task that can be skipped without blocking Mastery of its Skill.

**Mastery**:
A recorded status indicating that a Skill's learning outcome is considered achieved, with a basis that depends on the mode. In personal mode, users may freely declare Mastery or leave it unclaimed regardless of actual proficiency, with no required evidence or review; in coach mode, Mastery requires evidence assessed and approved by an authorized coach. Completing a personal-mode Task does not automatically declare Mastery, and declaring personal Mastery does not award XP.

**XP**:
A gamification score that may be used in a Skill's Access rules, independently of Mastery. In personal mode, Access thresholds use only the user's XP from the same Learning Path, excluding XP from other Learning Paths and coach mode. In coach mode, Access thresholds use only the learner's XP from the relevant Enrollment, excluding personal-mode XP and XP from other Enrollments.

**XP Award**:
The XP reward associated with a Task, earned under the applicable mode's rules. In MVP personal mode, users set their own Task rewards and earn them by marking Tasks complete, with evidence and self-review optional; a completed Task contributes its current configured reward, an incomplete Task contributes zero, and repeated actions on the same Task do not multiply its reward. In coach mode, the coach sets the reward for one Task within one Enrollment: it contributes its full amount while at least one of the Task's submitted revisions within that Enrollment has a valid Approval and contributes zero otherwise; additional approved revisions do not multiply the reward.

**XP Correction**:
A recorded automatic adjustment of a Task's XP Award according to the applicable mode's rules. In personal mode, undoing completion removes the reward and completing the Task again restores its current configured reward, without changing personal Mastery; editing a completed Task's reward adjusts its contribution by the difference, while an incomplete Task still contributes zero. In coach mode, revoking the Task's last valid Approval removes its reward and a later valid Approval restores it. Restoration reinstates the Task's reward without multiplying it.

**XP Threshold**:
An optional minimum XP requirement for Access to a Skill, checked against current XP from the user's Learning Path in personal mode or the learner's Enrollment in coach mode. Gaining Access does not spend or subtract XP. In both modes, falling below the threshold locks the Skill even if it was previously accessible or already started, unless an active Access Override applies.

**Access**:
A learner's ability to start a Skill's tasks and submit work, independent of Mastery. Current Prerequisite requirements and applicable XP Thresholds apply even after work has begun, except for requirements waived by an active Access Override. In coach mode, an inactive Enrollment prevents Access even when an Access Override exists.

**Locked Skill**:
A Skill for which the learner does not currently have Access. Its title, learning outcome, and reason for being locked remain visible within the Learning Path the learner follows. In personal mode, becoming locked preserves existing work and declared Mastery.

**Prerequisite Graph**:
The directed acyclic structure of Skills and their Prerequisites within one Learning Path; in coach mode, it is confined to one Learning Path Version. Both modes allow branching and multiple Prerequisites per Skill, while additions that create a cycle are rejected immediately.

**Prerequisite**:
A directed requirement linking two Skills in the same Prerequisite Graph, satisfied when the learner has Mastery of the required Skill; for A → B, A is the prerequisite for B. In the MVP, all of a Skill's Prerequisites must be satisfied together to meet its prerequisite condition for Access (ALL).

**Access Override**:
An explicit exception waiving both Prerequisite requirements and the XP Threshold for one Skill, without changing XP, Mastery, or other learners' rules. In personal mode, users may grant it for themselves without a required reason or review. In coach mode, an authorized coach grants it within one Enrollment with a mandatory Override Record; other Enrollments are unaffected.

**Override Record**:
A record of the grant or revocation of a coach-granted Access Override, identifying the action, acting coach, learner, Enrollment, Skill, event time, and mandatory reason. The coach supplies a brief reason, while the action, participants, target Enrollment and Skill, and time are recorded automatically.

**Override Revocation**:
The withdrawal of a coach-granted Access Override by an authorized coach, with a mandatory recorded reason. Access returns to the ordinary rules and the Skill becomes locked if its Prerequisite requirements or XP Threshold are unmet, while existing learner work, XP, and awarded Mastery are preserved.

**Submission Draft**:
A learner's saved, editable work for a Task before it is sent as a Submission Revision. Its contents are visible only to the learner; the Coach can see submitted contents once the learner sends a Revision.

**Submission**:
Learner work sent for review for exactly one Task. In MVP coach mode, each Task within an Enrollment has at most one Submission containing its successive Submission Revisions; reusing the same project evidence for another Task requires a separate Submission and Review. Losing Access because of unmet Prerequisites, an unmet XP Threshold, an Override Revocation, or an Enrollment Deactivation does not itself remove review eligibility or potential contribution to Mastery from work sent with valid Access. In coach mode, pending revisions sent while the Enrollment was active and Access valid remain reviewable after deactivation unless superseded; their Approvals can contribute to XP and Mastery under the ordinary rules.

**Submission Revision**:
An immutable version of a Submission's contents captured at the time of sending. For the MVP, it captures text and URLs, with direct file uploads deferred; linked external content is not automatically archived or frozen. When stable external evidence is needed, the Coach requests a version-specific link or important content copied into the Submission. Corrections are sent as new revisions; a newer revision of the same Submission supersedes earlier revisions that have not received a Review decision.

**Review**:
An assessment of exactly one Submission Revision, whose result applies only to that revision. In MVP coach mode, the decision is either Approval or Changes Requested; numeric grading and permanent rejection are deferred. A decision cannot be recorded for a revision that was superseded while awaiting a decision.

**Changes Requested**:
A Review decision asking the learner to correct the assessed Submission Revision, with mandatory feedback. Corrections are sent as a new Submission Revision when the learner has Access.

**Approval**:
A Review decision accepting the work in one Submission Revision for that Submission's Task only. A learner with Access may send a newer revision without invalidating an existing Approval or its contribution to Mastery, but the newer revision requires its own Review and does not inherit Approval.

**Approval Revocation**:
The withdrawal of an Approval for a specific Submission Revision by an authorized coach, with a mandatory recorded reason. The original decision remains in the review history, but the revoked Approval no longer counts as valid evidence for Mastery.

**Mastery Reevaluation**:
The automatic reassessment of coach-mode Mastery after an Approval Revocation, using the remaining valid Approvals. Mastery is retained if its requirements remain satisfied; otherwise it is automatically revoked while the history of its award is preserved.
