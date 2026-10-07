import type { PathSkill, PathTask } from '../../lib/api'

/**
 * Reusing Skills and Tasks as independent copies (ADR 0004, 0025; CONTEXT.md: Skill, Task).
 * A copy takes a source's definitions as they were read and gives every copied
 * Skill and Task a new logical ID, so it is new content of the destination Path:
 * later edits on either side stay apart, and no learner work, Review, XP or
 * Mastery recorded under the source IDs can follow it. Prerequisites come along
 * only between Skills copied together; a link to a Skill left behind would cross
 * Paths or Versions, which the Prerequisite Graph does not allow.
 *
 * Draft rules (Required or Enrichment Tasks with rewards, Optional Skills and XP
 * Thresholds) are content only from one Coach's Draft or Version into another
 * Draft. A personal Path has none in its document, since there rewards and
 * thresholds are the owner's own learning records; content copied into a Draft
 * from a personal Path starts with the Draft's rules for a new Skill or Task.
 */

/** Which kind of Path a definition comes from or goes to. */
export type ContentKind = 'personal' | 'coach'

/** A source as read: its Skills with their Tasks, their cards, and its Prerequisites. */
export interface ReuseContent {
  kind: ContentKind
  skills: PathSkill[]
  cards: { id: string; position: { x: number; y: number } }[]
  connections: { from_id: string; to_id: string }[]
}

/** How the destination starts a new Skill or Task: the editor's mode. */
export interface Destination {
  kind: ContentKind
  newSkill: (id: string, title: string, outcome: string) => PathSkill
  newTask: (id: string) => PathTask
}

export interface SkillCopy {
  skills: PathSkill[]
  cards: { id: string; title: string; position: { x: number; y: number } }[]
  connections: { from_id: string; to_id: string }[]
}

const keepsRules = (from: ContentKind, to: Destination) => from === 'coach' && to.kind === 'coach'

/** A copy of one Task with a new ID, for a Skill of the destination. */
export function copyTask(task: PathTask, from: ContentKind, to: Destination, newId: () => string): PathTask {
  const blank = to.newTask(newId())
  const copy = { ...blank, title: task.title, description: task.description }
  if (!keepsRules(from, to)) return copy
  return { ...copy, required: task.required ?? blank.required, xpReward: task.xpReward ?? blank.xpReward }
}

/** How many Prerequisites of the chosen Skills come along (both ends chosen) and how many stay behind. */
export function prerequisitesOf(source: ReuseContent, skillIds: Iterable<string>) {
  const chosen = new Set(skillIds)
  const touching = source.connections.filter((edge) => chosen.has(edge.from_id) || chosen.has(edge.to_id))
  const kept = touching.filter((edge) => chosen.has(edge.from_id) && chosen.has(edge.to_id))
  return { kept, left: touching.length - kept.length }
}

const CARD_GAP = 280
const COORDINATE_LIMIT = 1_000_000

/**
 * Copies the chosen Skills, in the source's order, with their Tasks and the
 * Prerequisites among them. The cards keep their arrangement and are placed to the
 * right of the destination's cards, where they cover none of them.
 */
export function copySkills(source: ReuseContent, skillIds: Iterable<string>, to: Destination, destinationCards: { position: { x: number; y: number } }[], newId: () => string): SkillCopy {
  const chosen = new Set(skillIds)
  const picked = source.skills.filter((skill) => chosen.has(skill.id))
  if (picked.length === 0) return { skills: [], cards: [], connections: [] }
  const ids = new Map(picked.map((skill) => [skill.id, newId()]))
  const sourceCards = new Map(source.cards.map((card) => [card.id, card.position]))
  const at = (id: string, index: number) => sourceCards.get(id) ?? { x: index * CARD_GAP, y: 0 }

  const minX = Math.min(...picked.map((skill, index) => at(skill.id, index).x))
  const minY = Math.min(...picked.map((skill, index) => at(skill.id, index).y))
  const left = destinationCards.length === 0 ? 80 : Math.max(...destinationCards.map((card) => card.position.x)) + CARD_GAP
  const top = destinationCards.length === 0 ? 100 : Math.min(...destinationCards.map((card) => card.position.y))
  const clamp = (value: number) => Math.max(-COORDINATE_LIMIT, Math.min(COORDINATE_LIMIT, value))

  const skills = picked.map((skill) => {
    const blank = to.newSkill(ids.get(skill.id)!, skill.title, skill.outcome)
    const rules = keepsRules(source.kind, to) ? { optional: skill.optional ?? blank.optional, xpThreshold: skill.xpThreshold ?? blank.xpThreshold } : {}
    return { ...blank, ...rules, tasks: skill.tasks.map((task) => copyTask(task, source.kind, to, newId)) }
  })
  const cards = picked.map((skill, index) => {
    const position = at(skill.id, index)
    return { id: ids.get(skill.id)!, title: skill.title, position: { x: clamp(position.x - minX + left), y: clamp(position.y - minY + top) } }
  })
  const connections = prerequisitesOf(source, chosen).kept.map((edge) => ({ from_id: ids.get(edge.from_id)!, to_id: ids.get(edge.to_id)! }))
  return { skills, cards, connections }
}
