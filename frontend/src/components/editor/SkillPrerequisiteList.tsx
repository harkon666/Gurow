import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { PrerequisiteConnection } from './protocol'
import type { SelectedSkillInfo } from './types'
import { resolveSkillPrerequisites, getNextSkillIndex, type ListSkill } from './skillListModel'
import { TemporaryPanel } from './TemporaryPanel'

interface SkillPrerequisiteListProps {
  skills: ListSkill[]
  connections: PrerequisiteConnection[]
  selectedSkillId: string | null
  onSelectSkill: (skill: SelectedSkillInfo | null) => void
  disabled?: boolean
  className?: string
  renderStatus?: (skillId: string) => React.ReactNode
}

export const SkillPrerequisiteList: React.FC<SkillPrerequisiteListProps> = ({ skills, connections, selectedSkillId, onSelectSkill, disabled = false, renderStatus }) => {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [focusedIndex, setFocusedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const items = useMemo(() => resolveSkillPrerequisites(skills, connections).filter((skill) => skill.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [skills, connections, search])
  const index = Math.min(focusedIndex, Math.max(0, items.length - 1))
  useEffect(() => { listRef.current?.querySelector(`#${CSS.escape(`skill-list-item-${items[index]?.id}`)}`)?.scrollIntoView({ block: 'nearest' }) }, [index, items])
  const select = (skill: SelectedSkillInfo) => {
    setOpen(false)
    onSelectSkill(skill)
  }
  const navigate = (event: React.KeyboardEvent) => {
    if (!items.length) return
    const directions = { ArrowDown: 'next', ArrowUp: 'prev', Home: 'first', End: 'last' } as const
    if (event.key in directions) {
      event.preventDefault()
      setFocusedIndex(getNextSkillIndex(index, items.length, directions[event.key as keyof typeof directions]))
    } else if ((event.key === 'Enter' || event.key === ' ') && items[index]) {
      event.preventDefault()
      select(items[index])
    }
  }
  return <>
    <button id="btn-skill-list" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setSearch(''); setFocusedIndex(Math.max(0, skills.findIndex((s) => s.id === selectedSkillId))); setOpen(true) }} className="shrink-0 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800">Skill list</button>
    {open && <TemporaryPanel title="Skill list" closeId="btn-close-skill-list" onClose={() => setOpen(false)} initialFocus="#skill-search">
      <div data-testid="skill-prerequisite-list-container" className="p-4 space-y-3">
        <label htmlFor="skill-search" className="block text-sm">Search Skills</label>
        <input id="skill-search" type="search" value={search} onChange={(event) => { setSearch(event.target.value); setFocusedIndex(0) }} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); listRef.current?.focus() } else if (event.key === 'Enter' && items[index]) { event.preventDefault(); select(items[index]) } }} className="w-full rounded-lg border border-slate-700 bg-slate-900 p-2" />
        <p className="text-xs text-slate-400">Use ↑ and ↓ to browse, Enter to open a Skill and its Tasks.</p>
        <div ref={listRef} id="skill-prerequisite-list" role="listbox" aria-label="Skill and Prerequisite List" aria-activedescendant={items[index] ? `skill-list-item-${items[index].id}` : undefined} tabIndex={0} onKeyDown={navigate} className="max-h-[55dvh] overflow-y-auto space-y-2 rounded-lg focus:ring-2 focus:ring-emerald-500">
          {items.map((skill, i) => <div key={skill.id} id={`skill-list-item-${skill.id}`} role="option" aria-selected={skill.id === selectedSkillId} onClick={() => select(skill)} className={`p-3 rounded-lg border cursor-pointer ${i === index ? 'border-emerald-500 bg-slate-800' : 'border-slate-800 bg-slate-900'}`}>
            <div className="flex justify-between gap-2 text-sm"><span>{skill.title}</span><span className="text-slate-400">{skill.tasks.length} Tasks</span></div>
            {renderStatus?.(skill.id)}
            <p className="mt-1 text-xs text-slate-400">{skill.prerequisites.length ? `Requires: ${skill.prerequisites.map((p) => p.fromTitle).join(', ')}` : 'No prerequisites'}</p>
          </div>)}
        </div>
        {!items.length && <p role="status" className="text-sm text-slate-400">No Skills found.</p>}
        <p id="list-positioning-note" className="text-xs text-slate-500">Card positioning remains a canvas operation.</p>
      </div>
    </TemporaryPanel>}
  </>
}
