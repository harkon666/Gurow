type SkillName = { id: string; title: string }

const duplicate = /^Prerequisite connection from '(.*)' to '(.*)' already exists$/s
const missing = /^(Source|Target) skill card '(.*)' not found$/s
const selfCycle = /^Cannot connect '(.*)' to itself: self-prerequisite creates an immediate cycle$/s
const cyclePrefix = 'Cannot connect: creates a cycle ('

/** Recognize connection diagnostics even after the active rejection is dismissed. */
export function isConnectionRejection(reason: string): boolean {
  return duplicate.test(reason) || missing.test(reason) || selfCycle.test(reason) || reason.startsWith(cyclePrefix)
}

export type ConnectionRejectionKind = 'duplicate' | 'cycle' | 'self' | 'missing' | 'other'

/**
 * The kind of refusal, for the `data-kind` state checks read instead of wording.
 * 'other' is any refusal that is not an engine connection diagnostic, such as a Draft rule.
 */
export function connectionRejectionKind(reason: string): ConnectionRejectionKind {
  if (duplicate.test(reason)) return 'duplicate'
  if (reason.startsWith(cyclePrefix)) return 'cycle'
  if (selfCycle.test(reason)) return 'self'
  if (missing.test(reason)) return 'missing'
  return 'other'
}

/** Presentation only: never mutate or render the engine's raw diagnostic payload. */
export function connectionRejectionMessage(reason: string, skills: readonly SkillName[]): string {
  const name = (id: string) => {
    const skill = skills.find((candidate) => candidate.id === id)
    return skill ? `“${skill.title}”` : 'that Skill'
  }
  const repeated = duplicate.exec(reason)
  if (repeated) return `The prerequisite connection from ${name(repeated[1])} to ${name(repeated[2])} already exists.`

  if (reason.startsWith(cyclePrefix)) {
    // Titles may contain parentheses, quotes or arrows: identify complete engine
    // labels, rather than splitting/replacing arbitrary substrings in user text.
    const involved = skills.filter((skill) => reason.includes(`${skill.title} (${skill.id})`))
    const names = involved.map((skill) => `“${skill.title}”`).join(', ')
    return `This connection would create a cycle${names ? ` involving ${names}` : ''}. A Skill cannot depend on itself, directly or indirectly.`
  }

  const self = selfCycle.exec(reason)
  if (self) return `Cannot connect ${name(self[1])} to itself: a Skill cannot be its own prerequisite.`
  const absent = missing.exec(reason)
  if (absent) return `Cannot connect: ${name(absent[2])} is no longer available. Refresh the Skill list and try again.`

  // Unknown/stale diagnostics can contain identities unavailable in this view.
  return 'This prerequisite connection could not be added. Refresh the Skill list and try again.'
}
