import {
  LearningPathCheckpointSchema,
  CameraStateSchema,
  type LearningPathCheckpoint,
  type CameraState,
} from './protocol'

export class CheckpointMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CheckpointMismatchError'
  }
}

/**
 * Validates the semantic integrity and bi-directional consistency between
 * editor canvas state (cards, positions, connections) and application learning domain payload (tasks, outcomes).
 *
 * Invariants enforced (ADR-0016, Ticket T04 AC 3):
 * 1. The set of Skill IDs in editor cards must exactly match the set of Skill IDs in application payload.
 * 2. Every prerequisite connection in editor must link valid Skill IDs.
 * 3. Every Task in the application payload must belong to its designated Skill with valid contents.
 * 4. Fails fast with CheckpointMismatchError on any corruption, preventing silent corrupted restoration.
 */
export function validateCheckpointIntegrity(
  rawCheckpoint: unknown,
  expectedPathId?: string
): LearningPathCheckpoint {
  let parsed: LearningPathCheckpoint
  try {
    parsed = LearningPathCheckpointSchema.parse(rawCheckpoint)
  } catch (err: unknown) {
    throw new CheckpointMismatchError(
      `Checkpoint schema validation failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // 0. Verify learning_path_id matches expected context if specified (ADR-0016, Ticket T04 AC 3)
  if (expectedPathId !== undefined && parsed.application.learning_path_id !== expectedPathId) {
    throw new CheckpointMismatchError(
      `Checkpoint learning_path_id '${parsed.application.learning_path_id}' does not match expected path '${expectedPathId}'.`
    )
  }

  const editorSkillIds = new Set(parsed.editor.cards.map((c) => c.id))
  const appSkillIds = new Set(parsed.application.skills.map((s) => s.id))

  // 1. Check for cards in editor missing corresponding application payload
  const missingInApp: string[] = []
  for (const id of editorSkillIds) {
    if (!appSkillIds.has(id)) {
      missingInApp.push(id)
    }
  }
  if (missingInApp.length > 0) {
    throw new CheckpointMismatchError(
      `Editor snapshot references Skill ID(s) [${missingInApp.join(', ')}] missing from application payload.`
    )
  }

  // 2. Check for skills in application payload missing from editor snapshot
  const missingInEditor: string[] = []
  for (const id of appSkillIds) {
    if (!editorSkillIds.has(id)) {
      missingInEditor.push(id)
    }
  }
  if (missingInEditor.length > 0) {
    throw new CheckpointMismatchError(
      `Application payload contains Skill ID(s) [${missingInEditor.join(', ')}] not found in editor snapshot.`
    )
  }

  // 3. Check that all connections reference existent Skill IDs
  for (const conn of parsed.editor.connections) {
    if (!editorSkillIds.has(conn.from_id)) {
      throw new CheckpointMismatchError(
        `Prerequisite connection from_id '${conn.from_id}' does not exist in editor cards.`
      )
    }
    if (!editorSkillIds.has(conn.to_id)) {
      throw new CheckpointMismatchError(
        `Prerequisite connection to_id '${conn.to_id}' does not exist in editor cards.`
      )
    }
  }

  return parsed
}

/** Returns the account- and Learning Path-scoped key for a full checkpoint. */
export function getCheckpointKey(accountId: string, pathId: string): string {
  return `gurow:checkpoint:${accountId}:${pathId}`
}

/** Returns the account- and Learning Path-scoped key for camera view state. */
export function getCameraKey(accountId: string, pathId: string): string {
  return `gurow:camera:${accountId}:${pathId}`
}

/** Validates and persists the editor/application checkpoint atomically. */
export function saveCheckpoint(
  storage: Storage,
  accountId: string,
  pathId: string,
  checkpoint: LearningPathCheckpoint
): void {
  const validated = validateCheckpointIntegrity(checkpoint, pathId)
  const key = getCheckpointKey(accountId, pathId)
  storage.setItem(key, JSON.stringify(validated))
}

/** Loads and validates a checkpoint, returning null when none exists. */
export function loadCheckpoint(
  storage: Storage,
  accountId: string,
  pathId: string
): LearningPathCheckpoint | null {
  const key = getCheckpointKey(accountId, pathId)
  const raw = storage.getItem(key)
  if (!raw) {
    return null
  }

  try {
    const json = JSON.parse(raw)
    return validateCheckpointIntegrity(json, pathId)
  } catch (err: unknown) {
    if (err instanceof CheckpointMismatchError) {
      throw err
    }
    throw new CheckpointMismatchError(
      `Failed to parse local checkpoint: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** Validates and persists camera state separately from the editor checkpoint. */
export function saveCameraState(
  storage: Storage,
  accountId: string,
  pathId: string,
  camera: CameraState
): void {
  const validated = CameraStateSchema.parse(camera)
  const key = getCameraKey(accountId, pathId)
  storage.setItem(key, JSON.stringify(validated))
}

/** Loads camera state; malformed or absent local state is treated as missing. */
export function loadCameraState(
  storage: Storage,
  accountId: string,
  pathId: string
): CameraState | null {
  const key = getCameraKey(accountId, pathId)
  const raw = storage.getItem(key)
  if (!raw) {
    return null
  }

  try {
    const json = JSON.parse(raw)
    return CameraStateSchema.parse(json)
  } catch {
    return null
  }
}

/** Removes both the checkpoint and camera state for one account and path. */
export function clearLocalScene(
  storage: Storage,
  accountId: string,
  pathId: string
): void {
  storage.removeItem(getCheckpointKey(accountId, pathId))
  storage.removeItem(getCameraKey(accountId, pathId))
}
