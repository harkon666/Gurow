import React, { useRef, useEffect, useState, useMemo } from 'react'
import type { PrerequisiteConnection } from './protocol'
import type { SelectedSkillInfo } from './types'
import {
  resolveSkillPrerequisites,
  getNextSkillIndex,
  type ListSkill,
} from './skillListModel'

interface SkillPrerequisiteListProps {
  skills: ListSkill[]
  connections: PrerequisiteConnection[]
  selectedSkillId: string | null
  onSelectSkill: (skill: SelectedSkillInfo | null) => void
  disabled?: boolean
  className?: string
  /** A Skill's current status (e.g. Access and Mastery), shown under its title. */
  renderStatus?: (skillId: string) => React.ReactNode
}

export const SkillPrerequisiteList: React.FC<SkillPrerequisiteListProps> = ({
  skills,
  connections,
  selectedSkillId,
  onSelectSkill,
  disabled = false,
  className = '',
  renderStatus,
}) => {
  const listRef = useRef<HTMLDivElement | null>(null)
  const items = useMemo(
    () => resolveSkillPrerequisites(skills, connections),
    [skills, connections]
  )

  // Track focused index for keyboard navigation
  const [focusedIndex, setFocusedIndex] = useState<number>(() => {
    const idx = items.findIndex((s) => s.id === selectedSkillId)
    return idx >= 0 ? idx : 0
  })

  // Synchronize focused index when external selection changes
  useEffect(() => {
    if (selectedSkillId) {
      const idx = items.findIndex((s) => s.id === selectedSkillId)
      if (idx >= 0) {
        setFocusedIndex(idx)
      }
    }
  }, [selectedSkillId, items])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || items.length === 0) return

    let nextIdx = focusedIndex

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        nextIdx = getNextSkillIndex(focusedIndex, items.length, 'next')
        setFocusedIndex(nextIdx)
        if (items[nextIdx]) {
          onSelectSkill({
            id: items[nextIdx].id,
            title: items[nextIdx].title,
          })
        }
        break

      case 'ArrowUp':
        e.preventDefault()
        nextIdx = getNextSkillIndex(focusedIndex, items.length, 'prev')
        setFocusedIndex(nextIdx)
        if (items[nextIdx]) {
          onSelectSkill({
            id: items[nextIdx].id,
            title: items[nextIdx].title,
          })
        }
        break

      case 'Home':
        e.preventDefault()
        nextIdx = getNextSkillIndex(focusedIndex, items.length, 'first')
        setFocusedIndex(nextIdx)
        if (items[nextIdx]) {
          onSelectSkill({
            id: items[nextIdx].id,
            title: items[nextIdx].title,
          })
        }
        break

      case 'End':
        e.preventDefault()
        nextIdx = getNextSkillIndex(focusedIndex, items.length, 'last')
        setFocusedIndex(nextIdx)
        if (items[nextIdx]) {
          onSelectSkill({
            id: items[nextIdx].id,
            title: items[nextIdx].title,
          })
        }
        break

      case 'Enter':
      case ' ':
        e.preventDefault()
        if (items[focusedIndex]) {
          onSelectSkill({
            id: items[focusedIndex].id,
            title: items[focusedIndex].title,
          })
        }
        break

      default:
        break
    }
  }

  return (
    <div
      className={`flex flex-col h-full bg-slate-950/80 border-r border-slate-800/80 ${className}`}
      data-testid="skill-prerequisite-list-container"
    >
      {/* Header with keyboard instructions */}
      <div className="p-3 border-b border-slate-800 flex items-center justify-between bg-slate-900/40">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Skills & Prerequisites
          </h2>
          <p className="text-[10px] text-slate-500 mt-0.5">
            Use <kbd className="px-1 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">↑</kbd> <kbd className="px-1 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">↓</kbd> or <kbd className="px-1 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">Enter</kbd> to select
          </p>
        </div>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700/60">
          {items.length} {items.length === 1 ? 'Skill' : 'Skills'}
        </span>
      </div>

      {/* Keyboard navigable listbox */}
      <div
        ref={listRef}
        id="skill-prerequisite-list"
        role="listbox"
        aria-label="Skill and Prerequisite List"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="flex-1 overflow-y-auto p-2 space-y-1.5 outline-none focus:ring-1 focus:ring-emerald-500/50"
      >
        {items.map((skill, index) => {
          const isSelected = skill.id === selectedSkillId
          const isFocused = index === focusedIndex

          return (
            <div
              key={skill.id}
              id={`skill-list-item-${skill.id}`}
              role="option"
              aria-selected={isSelected}
              tabIndex={-1}
              onClick={() => {
                setFocusedIndex(index)
                onSelectSkill({ id: skill.id, title: skill.title })
              }}
              className={`p-2.5 rounded-xl text-left cursor-pointer transition-all duration-150 border ${
                isSelected
                  ? 'bg-emerald-950/50 border-emerald-500/80 text-emerald-200 shadow-md shadow-emerald-950/40'
                  : isFocused
                  ? 'bg-slate-900/90 border-slate-700 text-slate-200'
                  : 'bg-slate-900/40 border-slate-800/80 text-slate-300 hover:bg-slate-800/50 hover:border-slate-700/60'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-xs tracking-tight truncate">
                  {skill.title}
                </span>
                <span className="text-[10px] font-mono text-slate-500">
                  {skill.tasks.length} {skill.tasks.length === 1 ? 'task' : 'tasks'}
                </span>
              </div>

              {renderStatus?.(skill.id)}

              {/* Prerequisites description */}
              <div className="mt-1 flex flex-wrap gap-1 items-center text-[10px]">
                {skill.prerequisites.length === 0 ? (
                  <span className="text-slate-500 italic">
                    Root Skill (No prerequisites)
                  </span>
                ) : (
                  <>
                    <span className="text-slate-500">Prereqs:</span>
                    {skill.prerequisites.map((p) => (
                      <span
                        key={p.fromId}
                        className="px-1.5 py-0.2 rounded bg-slate-800/80 text-slate-300 border border-slate-700/60 font-mono text-[9px]"
                      >
                        ← {p.fromTitle}
                      </span>
                    ))}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Positioning note per ADR-0017 / AC2 */}
      <div
        id="list-positioning-note"
        className="p-2 border-t border-slate-800/80 bg-slate-950 text-[10px] text-slate-500 text-center shrink-0"
      >
        Card positioning remains a canvas operation.
      </div>
    </div>
  )
}
