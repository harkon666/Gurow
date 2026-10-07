import { describe, expect, it } from 'bun:test'
import { connectionRejectionMessage, isConnectionRejection } from './connectionRejection'

const skills = [{ id: 'private-a', title: 'Vectors' }, { id: 'private-b', title: 'Matrices' }]

describe('connection rejection presentation', () => {
  it('names duplicate endpoints without changing the diagnostic', () => {
    const reason = "Prerequisite connection from 'private-a' to 'private-b' already exists"
    expect(isConnectionRejection(reason)).toBe(true)
    expect(connectionRejectionMessage(reason, skills)).toBe('The prerequisite connection from “Vectors” to “Matrices” already exists.')
    expect(reason).toBe("Prerequisite connection from 'private-a' to 'private-b' already exists")
  })

  it('names a cycle without its internal IDs or engine terminology', () => {
    const reason = 'Cannot connect: creates a cycle (Matrices (private-b) → Vectors (private-a) → Matrices (private-b)). Prerequisite graph must remain acyclic (DAG).'
    const message = connectionRejectionMessage(reason, skills)
    expect(isConnectionRejection(reason)).toBe(true)
    expect(message).toContain('cycle involving “Vectors”, “Matrices”')
    expect(message).not.toContain('private-')
    expect(message).not.toContain('DAG')
    expect(reason).toContain('Matrices (private-b)')
  })

  it('preserves titles containing punctuation without replacement expansion', () => {
    const special = [{ id: 'internal-$1', title: "Maps (A → B), 'quotes' & $&" }]
    const reason = `Cannot connect: creates a cycle (${special[0].title} (${special[0].id})). Prerequisite graph must remain acyclic (DAG).`
    expect(connectionRejectionMessage(reason, special)).toContain(`“${special[0].title}”`)
    expect(connectionRejectionMessage(reason, special)).not.toContain(special[0].id)
  })

  it('handles self-prerequisites and unavailable endpoints without leaking IDs', () => {
    const self = "Cannot connect 'private-a' to itself: self-prerequisite creates an immediate cycle"
    expect(isConnectionRejection(self)).toBe(true)
    expect(connectionRejectionMessage(self, skills)).toContain('“Vectors” to itself')
    for (const reason of ["Source skill card 'missing-id' not found", "Target skill card 'missing-id' not found", "Prerequisite connection from 'missing-id' to 'private-b' already exists"]) {
      expect(isConnectionRejection(reason)).toBe(true)
      expect(connectionRejectionMessage(reason, skills)).not.toContain('missing-id')
      expect(connectionRejectionMessage(reason, skills)).not.toContain('private-b')
    }
  })

  it('does not expose unknown diagnostics or stale cycle IDs', () => {
    const unknown = 'Unexpected connection error for private-a'
    expect(isConnectionRejection(unknown)).toBe(false)
    expect(connectionRejectionMessage(unknown, skills)).not.toContain('private-a')
    expect(connectionRejectionMessage('Cannot connect: creates a cycle (secret-id).', [])).not.toContain('secret-id')
    expect(isConnectionRejection('Renderer unavailable')).toBe(false)
  })
})
