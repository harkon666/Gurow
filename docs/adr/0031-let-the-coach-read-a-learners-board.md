# Let the Coach read a learner's board

[ADR 0030](0030-keep-a-learners-board-with-their-enrollment.md) keeps a learner's Task Boards with their Enrollment and refuses the owning Coach any access, so the Coach sees only what a learner sent. This decision lets that Coach read the arrangement and changes nothing else about the board.

The owning Coach of the Enrollment's Workspace reads a learner's board for one Skill exactly as the learner left it: the learner's own columns and where each Task sits. The read is only a read. It takes no Enrollment lock, creates no board, and writes nothing, so a board the learner has never opened answers as absent rather than being created with a first placement the learner did not ask for. Every save by the Coach is still refused (`learner_only`), and any other Account is still told the Enrollment does not exist ([ADR 0013](0013-limit-enrollment-data-visibility.md)). The board still carries no Task definition, Submission Draft or evidence, so reading it shows the Coach nothing of a learner's unsent work.

Placement remains organization, not evidence ([ADR 0027](0027-separate-task-board-organization-from-assessment.md)). The Coach's view says so, shows each Task's review state beside its card as the learner sees it, and offers no way to move a card. Review, Approval, XP and Mastery still follow only from sent revisions.

This was chosen over keeping the board private because a Coach who sees only sent work cannot tell a learner who has not started from one who is midway, and over a board the Coach can also arrange because that would let placement look like assessment and make two people edit one arrangement. The cost is that a learner's working organization is no longer private from their Coach; it stays private from other learners.
