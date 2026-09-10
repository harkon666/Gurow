import type { PrerequisiteConnection } from './protocol'
import type { FixtureSkill, FixtureTask } from '../../fixtures/learningPath'

export interface ResolvedPrerequisite {
  fromId: string
  fromTitle: string
}

export interface SkillListItem {
  id: string
  title: string
  outcome: string
  tasks: FixtureTask[]
  prerequisites: ResolvedPrerequisite[]
}

/**
 * Resolves skills with their incoming prerequisite connections from the DAG.
 * ADR-0017: Provides a keyboard-accessible Skill/Prerequisite list.
 */
export function resolveSkillPrerequisites(
  skills: FixtureSkill[],
  connections: PrerequisiteConnection[]
): SkillListItem[] {
  const skillTitleMap = new Map<string, string>()
  for (const s of skills) {
    skillTitleMap.set(s.id, s.title)
  }

  return skills.map((skill) => {
    const incoming = connections.filter((c) => c.to_id === skill.id)
    const prerequisites: ResolvedPrerequisite[] = incoming.map((c) => ({
      fromId: c.from_id,
      fromTitle: skillTitleMap.get(c.from_id) ?? c.from_id,
    }))

    return {
      id: skill.id,
      title: skill.title,
      outcome: skill.outcome,
      tasks: skill.tasks,
      prerequisites,
    }
  })
}

/**
 * Computes the target index for keyboard navigation in the skill list.
 */
export function getNextSkillIndex(
  currentIndex: number,
  totalCount: number,
  direction: 'next' | 'prev' | 'first' | 'last'
): number {
  if (totalCount <= 0) return -1
  if (currentIndex < 0) return 0

  switch (direction) {
    case 'next':
      return currentIndex + 1 < totalCount ? currentIndex + 1 : 0
    case 'prev':
      return currentIndex - 1 >= 0 ? currentIndex - 1 : totalCount - 1
    case 'first':
      return 0
    case 'last':
      return totalCount - 1
    default:
      return currentIndex
  }
}
