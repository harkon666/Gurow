import { describe, it, expect, beforeEach } from 'bun:test'
import {
  validateCheckpointIntegrity,
  saveCheckpoint,
  loadCheckpoint,
  saveCameraState,
  loadCameraState,
  clearLocalScene,
  CheckpointMismatchError,
} from './checkpoint'
import type { LearningPathCheckpoint, CameraState } from './protocol'

function createMockStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  }
}

describe('Checkpoint Integrity & Storage (ADR-0016, Ticket T04 SDD)', () => {
  let storage: Storage
  const accountId = 'test-account'
  const pathId = 'lp-test'

  const sampleValidCheckpoint: LearningPathCheckpoint = {
    version: 1,
    saved_at: '2026-09-10T10:00:00.000Z',
    editor: {
      format_version: 1,
      revision: 1,
      cards: [
        {
          id: 'skill-1',
          title: 'Skill One',
          position: { x: 50, y: 100 },
          size: { width: 180, height: 80 },
        },
        {
          id: 'skill-2',
          title: 'Skill Two',
          position: { x: 300, y: 100 },
          size: { width: 180, height: 80 },
        },
      ],
      connections: [{ from_id: 'skill-1', to_id: 'skill-2' }],
    },
    application: {
      learning_path_id: pathId,
      skills: [
        {
          id: 'skill-1',
          outcome: 'Master Skill One',
          tasks: [
            {
              id: 'task-1',
              title: 'Task One',
              description: 'Complete initial setup',
              required: true,
            },
          ],
        },
        {
          id: 'skill-2',
          outcome: 'Master Skill Two',
          tasks: [
            {
              id: 'task-2',
              title: 'Task Two',
              description: 'Build downstream feature',
              required: false,
            },
          ],
        },
      ],
    },
  }

  beforeEach(() => {
    storage = createMockStorage()
  })

  describe('validateCheckpointIntegrity', () => {
    it('passes for coherent checkpoint with matching skills, valid connections, and tasks', () => {
      const result = validateCheckpointIntegrity(sampleValidCheckpoint)
      expect(result).toEqual(sampleValidCheckpoint)
    })

    it('rejects with CheckpointMismatchError when editor has a card missing from application payload', () => {
      const mismatched: LearningPathCheckpoint = {
        ...sampleValidCheckpoint,
        editor: {
          ...sampleValidCheckpoint.editor,
          cards: [
            ...sampleValidCheckpoint.editor.cards,
            {
              id: 'orphan-card',
              title: 'Orphan',
              position: { x: 0, y: 0 },
              size: { width: 180, height: 80 },
            },
          ],
        },
      }

      expect(() => validateCheckpointIntegrity(mismatched)).toThrow(
        CheckpointMismatchError
      )
      expect(() => validateCheckpointIntegrity(mismatched)).toThrow(
        /missing from application payload/
      )
    })

    it('rejects with CheckpointMismatchError when application has a skill missing from editor snapshot', () => {
      const mismatched: LearningPathCheckpoint = {
        ...sampleValidCheckpoint,
        application: {
          ...sampleValidCheckpoint.application,
          skills: [
            ...sampleValidCheckpoint.application.skills,
            {
              id: 'extra-skill',
              outcome: 'Unrepresented',
              tasks: [],
            },
          ],
        },
      }

      expect(() => validateCheckpointIntegrity(mismatched)).toThrow(
        CheckpointMismatchError
      )
      expect(() => validateCheckpointIntegrity(mismatched)).toThrow(
        /not found in editor snapshot/
      )
    })

    it('rejects with CheckpointMismatchError when connection references non-existent card', () => {
      const mismatched: LearningPathCheckpoint = {
        ...sampleValidCheckpoint,
        editor: {
          ...sampleValidCheckpoint.editor,
          connections: [
            { from_id: 'skill-1', to_id: 'non-existent-skill' },
          ],
        },
      }

      expect(() => validateCheckpointIntegrity(mismatched)).toThrow(
        CheckpointMismatchError
      )
      expect(() => validateCheckpointIntegrity(mismatched)).toThrow(
        /does not exist in editor cards/
      )
    })

    it('rejects with CheckpointMismatchError when application learning_path_id does not match expectedPathId', () => {
      expect(() =>
        validateCheckpointIntegrity(sampleValidCheckpoint, 'other-path-id')
      ).toThrow(CheckpointMismatchError)
      expect(() =>
        validateCheckpointIntegrity(sampleValidCheckpoint, 'other-path-id')
      ).toThrow(/does not match expected path 'other-path-id'/)
    })
  })

  describe('saveCheckpoint and loadCheckpoint', () => {
    it('persists and restores coherent checkpoint without data loss', () => {
      saveCheckpoint(storage, accountId, pathId, sampleValidCheckpoint)
      const loaded = loadCheckpoint(storage, accountId, pathId)
      expect(loaded).toEqual(sampleValidCheckpoint)
    })

    it('rejects saving checkpoint when pathId does not match checkpoint payload', () => {
      expect(() =>
        saveCheckpoint(storage, accountId, 'foreign-path-id', sampleValidCheckpoint)
      ).toThrow(CheckpointMismatchError)
      expect(() =>
        saveCheckpoint(storage, accountId, 'foreign-path-id', sampleValidCheckpoint)
      ).toThrow(/does not match expected path 'foreign-path-id'/)
    })

    it('rejects loading checkpoint when stored payload has mismatched learning_path_id', () => {
      const foreignCheckpoint = {
        ...sampleValidCheckpoint,
        application: {
          ...sampleValidCheckpoint.application,
          learning_path_id: 'foreign-path',
        },
      }
      const key = `gurow:checkpoint:${accountId}:${pathId}`
      storage.setItem(key, JSON.stringify(foreignCheckpoint))

      expect(() => loadCheckpoint(storage, accountId, pathId)).toThrow(
        CheckpointMismatchError
      )
      expect(() => loadCheckpoint(storage, accountId, pathId)).toThrow(
        /does not match expected path 'lp-test'/
      )
    })

    it('returns null if no checkpoint exists in storage', () => {
      const loaded = loadCheckpoint(storage, accountId, pathId)
      expect(loaded).toBeNull()
    })

    it('throws CheckpointMismatchError on corrupted or mismatched stored payload', () => {
      const key = `gurow:checkpoint:${accountId}:${pathId}`
      storage.setItem(key, '{"invalid": true}')
      expect(() => loadCheckpoint(storage, accountId, pathId)).toThrow(
        CheckpointMismatchError
      )
    })
  })

  describe('saveCameraState and loadCameraState (session view vs scene)', () => {
    it('persists and loads camera state scoped to account and path context', () => {
      const camera: CameraState = { offset_x: 250, offset_y: -120, zoom: 1.75 }
      saveCameraState(storage, accountId, pathId, camera)
      const loaded = loadCameraState(storage, accountId, pathId)
      expect(loaded).toEqual(camera)
    })

    it('returns null if no camera state exists', () => {
      expect(loadCameraState(storage, accountId, pathId)).toBeNull()
    })

    it('returns null on invalid camera state', () => {
      const key = `gurow:camera:${accountId}:${pathId}`
      storage.setItem(key, '{"offset_x": "not-a-number"}')
      expect(loadCameraState(storage, accountId, pathId)).toBeNull()
    })
  })

  describe('clearLocalScene', () => {
    it('removes both checkpoint and camera keys', () => {
      saveCheckpoint(storage, accountId, pathId, sampleValidCheckpoint)
      saveCameraState(storage, accountId, pathId, { offset_x: 0, offset_y: 0, zoom: 1 })

      clearLocalScene(storage, accountId, pathId)

      expect(loadCheckpoint(storage, accountId, pathId)).toBeNull()
      expect(loadCameraState(storage, accountId, pathId)).toBeNull()
    })
  })
})
