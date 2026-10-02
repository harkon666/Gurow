import { useCallback, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WebGpuEditor, type WebGpuEditorActions } from '../../src/components/editor/WebGpuEditor'
import { SkillPrerequisiteList } from '../../src/components/editor/SkillPrerequisiteList'
import { INITIAL_LEARNING_PATH_FIXTURE } from '../../src/fixtures/learningPath'
import type { SelectedSkillInfo } from '../../src/components/editor/types'
import type { PrerequisiteConnection } from '../../src/components/editor/protocol'
import { WasmEditor } from '../../src/pkg/editor_wasm'
import '../../src/components/editor/gpuDeviceCapture'
import '../../src/styles.css'

// Observe real serialized protocol output; never fabricate a GPU event.
;(window as any).__gpuEvents = []
const reportError = WasmEditor.prototype.report_renderer_error
if (reportError) WasmEditor.prototype.report_renderer_error = function (message: string) {
  const json = reportError.call(this, message)
  ;(window as any).__gpuEvents.push(...JSON.parse(json))
  return json
}

const skills = INITIAL_LEARNING_PATH_FIXTURE.skills.slice(0, 2)
const cards = skills.map(s => ({ id: s.id, title: s.title, position: s.initialPosition }))
const initialConnections = [{ from_id: skills[0].id, to_id: skills[1].id }]
function Fixture() {
  const actions = useRef<WebGpuEditorActions | null>(null)
  const [status, setStatus] = useState('initializing')
  const [statuses, setStatuses] = useState<string[]>([])
  const statusChanged = useCallback((value: string) => { setStatus(value); setStatuses(old => [...old, value]) }, [])
  const [selected, setSelected] = useState<SelectedSkillInfo | null>(null)
  const [connections, setConnections] = useState<PrerequisiteConnection[]>([])
  const [snapshot, setSnapshot] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const select = (value: SelectedSkillInfo | null) => { setSelected(value); actions.current?.selectCard(value?.id ?? null) }
  return <>
    <output id="status">{status}</output><output id="statuses">{JSON.stringify(statuses)}</output>
    <button id="snapshot" onClick={() => setSnapshot(JSON.stringify(actions.current?.exportSnapshot()))}>Inspect document</button>
    <output id="document">{snapshot}</output>
    <div style={{ display: 'flex' }}>
      <div style={{ height: 650, width: 900 }}>
        <WebGpuEditor initialCards={cards} initialConnections={initialConnections}
          onSelectSkill={setSelected} onConnectionsChange={setConnections}
          onGpuStatusChange={statusChanged}
          onActionsReady={value => { actions.current = value }} />
      </div>
      <div style={{ width: 300 }}>
        <SkillPrerequisiteList skills={skills} connections={connections} selectedSkillId={selected?.id ?? null} onSelectSkill={select} />
        <output id="selected">{selected?.id}</output>
        {selected && <input id="task-draft" aria-label="Task draft" value={drafts[selected.id] ?? ''}
          onChange={event => setDrafts(old => ({ ...old, [selected.id]: event.target.value }))} />}
      </div>
    </div>
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
