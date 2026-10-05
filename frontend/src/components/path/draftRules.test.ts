import { describe, expect, it } from 'bun:test'
import type { PathSkill } from '../../lib/api'
import { draftRuleProblem, optionalPrerequisiteProblem, optionalToggleProblem } from './DraftRules'

const skill = (id: string, optional: boolean): PathSkill => ({ id, title: id.toUpperCase(), outcome: '', optional, xpThreshold: 0, tasks: [] })
const skills = [skill('req', false), skill('opt', true), skill('opt2', true), skill('req2', false)]

describe('Draft rules: an Optional Skill is never a Prerequisite of a required Skill', () => {
  it('refuses only Optional → required connections', () => {
    expect(optionalPrerequisiteProblem(skills, 'opt', 'req')).toBe('Optional Skill “OPT” cannot be a Prerequisite of required Skill “REQ”.')
    expect(optionalPrerequisiteProblem(skills, 'req', 'opt')).toBeNull()
    expect(optionalPrerequisiteProblem(skills, 'opt', 'opt2')).toBeNull()
    expect(optionalPrerequisiteProblem(skills, 'req', 'req2')).toBeNull()
  })

  it('finds a forbidden connection already in the graph, e.g. after an undo', () => {
    expect(draftRuleProblem(skills, [{ from_id: 'req', to_id: 'opt' }])).toBeNull()
    expect(draftRuleProblem(skills, [{ from_id: 'req', to_id: 'opt' }, { from_id: 'opt2', to_id: 'req2' }])).toContain('“OPT2”')
  })

  it('refuses making a Skill Optional while it leads to a required one, or required while an Optional one leads to it', () => {
    const edges = [{ from_id: 'req', to_id: 'req2' }, { from_id: 'opt', to_id: 'opt2' }]
    expect(optionalToggleProblem(skills, edges, 'req', true)).toContain('cannot be a Prerequisite of required Skill “REQ2”')
    expect(optionalToggleProblem(skills, edges, 'req2', true)).toBeNull()
    expect(optionalToggleProblem(skills, edges, 'opt2', false)).toContain('Optional Skill “OPT”')
    expect(optionalToggleProblem(skills, edges, 'opt', false)).toBeNull()
  })
})
