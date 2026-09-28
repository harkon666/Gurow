import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WebGpuEditor, type WebGpuEditorActions } from '../../src/components/editor/WebGpuEditor'
import '../../src/styles.css'

// Fixture drives only the real component's public props, never the engine.
const cards = [{ id: 'lifecycle-skill', title: 'Lifecycle Skill', position: { x: 100, y: 100 } }]
const empty: typeof cards = []
const connections: [] = []
const camera = { offset_x: 20, offset_y: 30, zoom: 1 }
function Fixture() {
  const [loaded, setLoaded] = useState(new URLSearchParams(location.search).get('arrival') === 'before')
  const [generation, setGeneration] = useState(0)
  const [renders, setRenders] = useState(0)
  const [status, setStatus] = useState('initializing')
  const actions = useRef<WebGpuEditorActions | null>(null)
  const [observeCamera, setObserveCamera] = useState(false)
  return <>
    <button id="deliver" onClick={() => setLoaded(true)}>Deliver document</button>
    <button id="rerender" onClick={() => setRenders(renders + 1)}>Rerender {renders}</button>
    <button id="remount" onClick={() => setGeneration(generation + 1)}>Remount</button>
    <button id="observe-camera" onClick={() => setObserveCamera(true)}>Observe camera with snapshot</button>
    <output id="status">{status}</output>
    <div style={{ height: 650, width: 900 }}>
      <WebGpuEditor key={generation} initialCards={loaded ? cards : empty}
        initialConnections={connections} initialCamera={camera}
        onSelectSkill={() => {}} onGpuStatusChange={setStatus}
        onActionsReady={value => { actions.current = value }}
        onCameraChanged={() => { if (observeCamera) actions.current?.exportSnapshot() }} />
    </div>
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
