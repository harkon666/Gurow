# Own coach-mode Learning Paths through Coach Workspaces

Each coach-mode Learning Path belongs to exactly one Coach Workspace. A Coach Workspace can contain multiple Learning Paths and provides their ownership and management-authority boundary. Each contained Path still defines its own learning goal, Prerequisite Graph, and Learning Path Versions.

This lets several Paths be managed within one administrative space with a clear ownership boundary, at the cost of an additional management layer even when a coach manages only one Path. The Workspace groups administration; it does not introduce a separate curriculum concept above Learning Paths.

For the MVP, each Coach Workspace has exactly one Coach who is also its owner. That Coach manages all Learning Paths and reviews learner work within the Workspace. Additional Coaches are deferred until after the MVP, simplifying ownership, permission administration, and review responsibility at the cost of not supporting co-teaching or distributing a Workspace's review queue among several Coaches.

The owning Account cannot hold a learner Enrollment in any Learning Path within its own Coach Workspace during the MVP. Coach-mode self-approval is prohibited, and with one Coach there would be no other reviewer to assess that Account's work. This separates the learner and approving Coach at the cost of the owner being unable to participate in their own Workspace's Paths with formal learner progress.
