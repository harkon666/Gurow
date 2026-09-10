import { describe, it, expect } from 'bun:test'
import {
  resolveSkillPrerequisites,
  getNextSkillIndex,
} from './skillListModel'
import { INITIAL_LEARNING_PATH_FIXTURE, type FixtureSkill } from '../../fixtures/learningPath'
import type { PrerequisiteConnection } from './protocol'

describe('Skill/Prerequisite List Model (ADR-0017, Ticket T05 SDD)', () => {
  const sampleSkills: FixtureSkill[] = [
    {
      id: 'skill-1',
      title: 'Rust Basics',
      outcome: 'Understand Rust syntax and ownership',
      initialPosition: { x: 100, y: 100 },
      tasks: [
        { id: 'task-1a', title: 'Ownership & Borrowing', description: 'Practice lifetimes', required: true },
      ],
    },
    {
      id: 'skill-2',
      title: 'Wasm Tooling',
      outcome: 'Compile Rust to WebAssembly',
      initialPosition: { x: 300, y: 100 },
      tasks: [
        { id: 'task-2a', title: 'Setup wasm-pack', description: 'Configure package', required: true },
      ],
    },
    {
      id: 'skill-3',
      title: 'WebGPU Pipeline',
      outcome: 'Render 3D graphics in browser',
      initialPosition: { x: 500, y: 100 },
      tasks: [
        { id: 'task-3a', title: 'Shader WGSL', description: 'Write vertex shader', required: true },
      ],
    },
  ]

  it('resolves skills without prerequisites as root skills', () => {
    const resolved = resolveSkillPrerequisites(sampleSkills, [])
    expect(resolved.length).toBe(3)
    expect(resolved[0].prerequisites).toEqual([])
    expect(resolved[1].prerequisites).toEqual([])
    expect(resolved[2].prerequisites).toEqual([])
  })

  it('resolves incoming prerequisite connections to source skill titles', () => {
    const connections: PrerequisiteConnection[] = [
      { from_id: 'skill-1', to_id: 'skill-2' },
      { from_id: 'skill-1', to_id: 'skill-3' },
      { from_id: 'skill-2', to_id: 'skill-3' },
    ]

    const resolved = resolveSkillPrerequisites(sampleSkills, connections)

    // skill-1 has no prerequisites
    expect(resolved[0].prerequisites).toEqual([])

    // skill-2 requires skill-1 (Rust Basics)
    expect(resolved[1].prerequisites).toEqual([
      { fromId: 'skill-1', fromTitle: 'Rust Basics' },
    ])

    // skill-3 requires both skill-1 and skill-2 (branching DAG)
    expect(resolved[2].prerequisites).toEqual([
      { fromId: 'skill-1', fromTitle: 'Rust Basics' },
      { fromId: 'skill-2', fromTitle: 'Wasm Tooling' },
    ])
  })

  it('preserves task data and outcome in resolved skill list items (AC1)', () => {
    const resolved = resolveSkillPrerequisites(sampleSkills, [])
    expect(resolved[0].tasks).toEqual(sampleSkills[0].tasks)
    expect(resolved[0].outcome).toBe(sampleSkills[0].outcome)
    expect(resolved[1].tasks[0].id).toBe('task-2a')
  })

  describe('Keyboard navigation index calculation (AC1)', () => {
    it('moves to next index and wraps at the end', () => {
      expect(getNextSkillIndex(0, 3, 'next')).toBe(1)
      expect(getNextSkillIndex(1, 3, 'next')).toBe(2)
      expect(getNextSkillIndex(2, 3, 'next')).toBe(0) // wraps to first
    })

    it('moves to previous index and wraps at the beginning', () => {
      expect(getNextSkillIndex(2, 3, 'prev')).toBe(1)
      expect(getNextSkillIndex(1, 3, 'prev')).toBe(0)
      expect(getNextSkillIndex(0, 3, 'prev')).toBe(2) // wraps to last
    })

    it('moves to first and last indices', () => {
      expect(getNextSkillIndex(1, 5, 'first')).toBe(0)
      expect(getNextSkillIndex(1, 5, 'last')).toBe(4)
    })

    it('handles boundary condition when count is 0 or index is unselected (-1)', () => {
      expect(getNextSkillIndex(-1, 3, 'next')).toBe(0)
      expect(getNextSkillIndex(0, 0, 'next')).toBe(-1)
    })
  })

  it('resolves all initial learning path fixture skills properly', () => {
    const fixtureSkills = INITIAL_LEARNING_PATH_FIXTURE.skills
    const resolved = resolveSkillPrerequisites(fixtureSkills, [])
    expect(resolved.length).toBe(fixtureSkills.length)
    expect(resolved[0].title).toBe('Rust Fundamentals')
    expect(resolved[0].tasks.length).toBeGreaterThan(0)
  })
})
