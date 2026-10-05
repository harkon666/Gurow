/**
 * Required progression before publication (ADR 0008). A Version is publishable only
 * when a learner can master every required Skill through Required Tasks on required
 * Skills alone, under ordinary rules: a Skill opens once all its Prerequisites are
 * mastered and the XP its threshold asks for is already reachable, and only then do
 * its own Required Task rewards become available. Optional Skills, Enrichment Tasks
 * and Access Overrides never count, and locked work never pays for its own unlock.
 */

export interface RouteTask { required: boolean; xpReward: number }
export interface RouteSkill { id: string; title: string; optional: boolean; xpThreshold: number; tasks: RouteTask[] }
export interface RouteEdge { prerequisiteSkillId: string; skillId: string }

/** Why one required Skill cannot be completed on the required route. */
export type UnmetRequirement =
  | { kind: 'required_task'; message: string }
  | { kind: 'prerequisite'; skillId: string; title: string; message: string }
  | { kind: 'xp_threshold'; xpThreshold: number; reachableXp: number; message: string }

export interface BlockedSkill { skillId: string; title: string; unmet: UnmetRequirement[] }

export type RouteCheck =
  | { publishable: true; reachableXp: number }
  | { publishable: false; reachableXp: number; blockedSkills: BlockedSkill[]; detail: string }

export function checkRequiredRoute(skills: RouteSkill[], edges: RouteEdge[]): RouteCheck {
  const required = skills.filter((skill) => !skill.optional)
  if (required.length === 0) {
    return { publishable: false, reachableXp: 0, blockedSkills: [], detail: 'A Version needs at least one required Skill for learners to complete' }
  }
  const titles = new Map(skills.map((skill) => [skill.id, skill.title]))
  const prerequisitesOf = (id: string) => edges.filter((edge) => edge.skillId === id).map((edge) => edge.prerequisiteSkillId)
  const requiredTasks = (skill: RouteSkill) => skill.tasks.filter((task) => task.required)

  // Open required Skills one at a time until nothing more opens; XP only grows, so the order does not matter.
  const mastered = new Set<string>()
  let reachableXp = 0
  for (let opened = true; opened;) {
    opened = false
    for (const skill of required) {
      if (mastered.has(skill.id) || requiredTasks(skill).length === 0) continue
      if (skill.xpThreshold > reachableXp || !prerequisitesOf(skill.id).every((id) => mastered.has(id))) continue
      mastered.add(skill.id)
      reachableXp += requiredTasks(skill).reduce((total, task) => total + task.xpReward, 0)
      opened = true
    }
  }

  const blockedSkills: BlockedSkill[] = required.filter((skill) => !mastered.has(skill.id)).map((skill) => {
    const unmet: UnmetRequirement[] = []
    if (requiredTasks(skill).length === 0) unmet.push({ kind: 'required_task', message: 'has no Required Task, so its Mastery can never be earned' })
    for (const id of prerequisitesOf(skill.id)) {
      if (!mastered.has(id)) unmet.push({ kind: 'prerequisite', skillId: id, title: titles.get(id)!, message: `needs Mastery of "${titles.get(id)}", which the required route cannot reach` })
    }
    if (skill.xpThreshold > reachableXp) {
      unmet.push({ kind: 'xp_threshold', xpThreshold: skill.xpThreshold, reachableXp, message: `needs ${skill.xpThreshold} XP, but Required Tasks on reachable required Skills award only ${reachableXp} XP` })
    }
    return { skillId: skill.id, title: skill.title, unmet }
  })
  if (blockedSkills.length === 0) return { publishable: true, reachableXp }
  const detail = blockedSkills.map((skill) => `"${skill.title}" ${skill.unmet.map((u) => u.message).join('; ')}`).join('. ')
  return { publishable: false, reachableXp, blockedSkills, detail: `The required route is blocked: ${detail}` }
}
