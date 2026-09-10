import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { WebGpuEditor } from '../components/editor/WebGpuEditor'
import { SkillDetailPanel } from '../components/editor/SkillDetailPanel'
import type { SelectedSkillInfo } from '../components/editor/types'
import { INITIAL_LEARNING_PATH_FIXTURE } from '../fixtures/learningPath'


export const Route = createFileRoute('/')({ component: LearningPathEditorPage })

function LearningPathEditorPage() {
  const [mounted, setMounted] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<SelectedSkillInfo | null>(null)

  useEffect(() => {
    setMounted(true)
  }, [])

  return (
    <main className="px-4 py-6 max-w-7xl mx-auto flex flex-col gap-5">
      {/* Learning Path Header Info */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900/50 p-5 rounded-2xl border border-slate-800/80 backdrop-blur-sm">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              P1 Slice: WebGPU Editor
            </span>
            <span className="text-xs text-slate-500 font-mono">US68 • US73 • US80</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-100 tracking-tight">
            {INITIAL_LEARNING_PATH_FIXTURE.title}
          </h1>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            {INITIAL_LEARNING_PATH_FIXTURE.description}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <div className="text-xs font-medium text-slate-300">Editor State Authority</div>
            <div className="text-[11px] text-slate-500 font-mono">Rust Engine (Wasm)</div>
          </div>
        </div>
      </div>

      {/* Editor Main Canvas & Panel Container */}
      <section
        id="canvas-editor-container"
        className="h-[640px] w-full rounded-2xl border border-slate-800 shadow-2xl overflow-hidden bg-slate-950 flex flex-col md:flex-row"
      >
        {mounted ? (
          <>
            <WebGpuEditor
              onSelectSkill={setSelectedSkill}
            />
            <SkillDetailPanel selectedSkill={selectedSkill} />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
            Initializing Editor Environment...
          </div>
        )}
      </section>
    </main>
  )
}
