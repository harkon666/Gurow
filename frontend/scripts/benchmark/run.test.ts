import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acPowerOnline, deliveredCount, isWebGpuFailure, refreshAgrees, windowFitsScreen } from './run'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function supply(name: string, type: string, online: string) {
  const root = roots.at(-1)!
  const dir = path.join(root, name)
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'type'), `${type}\n`)
  writeFileSync(path.join(dir, 'online'), `${online}\n`)
}

test('recognizes AC power by type instead of assuming the supply is named AC', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gurow-power-'))
  roots.push(root)
  supply('BAT1', 'Battery', '1')
  supply('ACAD', 'Mains', '1')
  expect(acPowerOnline(root)).toBe(true)
  writeFileSync(path.join(root, 'ACAD', 'online'), '0\n')
  expect(acPowerOnline(root)).toBe(false)
})

test('missing power-supply telemetry fails closed', () => {
  expect(acPowerOnline(path.join(os.tmpdir(), 'gurow-missing-power-supply'))).toBe(false)
})

test('counts browser-delivered movement, not the drag press, against the schedule', () => {
  const moves = Array.from({ length: 3600 }, () => ({ event_type: 'pointermove' }))
  expect(deliveredCount([{ event_type: 'pointerdown' }, ...moves])).toBe(3600)
  expect(deliveredCount([{ event_type: 'wheel' }, { event_type: 'wheel' }])).toBe(2)
  // A zero-travel wheel reached the page even though it requested no change.
  expect(deliveredCount([{ event_type: 'wheel' }], 3)).toBe(4)
})

test('checks window placement against the available area on Wayland and X11', () => {
  const base = { outer_width: 1896, outer_height: 1150, screen_width: 1920, avail_left: 0 }
  // X11 under Hyprland: absolute position below a 26 px bar (the 2026-09-30 false negative).
  expect(windowFitsScreen({ ...base, screen_x: 12, screen_y: 38, screen_height: 1174, avail_top: 26 })).toBe(true)
  expect(windowFitsScreen({ ...base, screen_x: 0, screen_y: 0, screen_height: 1174, avail_top: 0 })).toBe(true)
  expect(windowFitsScreen({ ...base, screen_x: 12, screen_y: 60, screen_height: 1174, avail_top: 26 })).toBe(false)
})

test('recognizes WebGPU work that failed without a reported renderer error', () => {
  expect(isWebGpuFailure('[Invalid Texture] is invalid due to a previous error.\n - While calling [Invalid Texture].CreateView')).toBe(true)
  expect(isWebGpuFailure('Real WebGPU device lost: vkAllocateMemory failed with VK_ERROR_OUT_OF_DEVICE_MEMORY')).toBe(true)
  expect(isWebGpuFailure('[vite] connected.')).toBe(false)
})

test('rejects a proxy refresh that idle rAF does not confirm', () => {
  expect(refreshAgrees(164.2, 165)).toBe(true)
  expect(refreshAgrees(60, 165)).toBe(false)
  expect(refreshAgrees(Number.NaN, 165)).toBe(false)
})
