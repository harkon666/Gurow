#!/usr/bin/env bun
/**
 * T32 delete-content check (#33): the production frontend build forwarding /api to the
 * production backend entry (Better Auth sessions, Resend stand-in) on a freshly migrated
 * PostgreSQL database, in headless Chromium with WebGPU. Real Accounts delete editor
 * content: an unused Skill leaves a personal Path with its Task, card and connections,
 * as one undo step; undo and redo after the save are new validated saves with the same
 * IDs; a connection is removed and brought back; reload shows the saved document. A
 * Skill with learning history offers no deletion, and history that appears before the
 * deletion is saved makes the backend refuse it while the local work stays. A stale tab
 * reapplies its deletion onto the accepted document. In a Coach's Draft, published
 * Skills cannot be deleted, a Draft-only Skill can, the published Version is unchanged,
 * and an undo that no longer passes the Draft rules is refused with the work kept.
 * Other Accounts cannot delete anything.
 *
 * Run from frontend: bun run scripts/t32-delete-content-check.ts [--skip-build]
 */
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'
import { closeEditorPanels } from './editor-navigation'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3581)
const API_PORT = Number(process.env.API_PORT ?? 3582)
const ORIGIN = `http://127.0.0.1:${PORT}`
const SECRET = 't32-browser-check-secret-not-for-production'
const DATABASE_URL = process.env.T32_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t32_browser_test'
const PASSWORD = 'correct horse battery staple'

interface Point { x: number; y: number }
interface Skill { id: string; title: string; outcome: string; optional?: boolean; xpThreshold?: number; tasks: { id: string; title: string; description: string; required?: boolean; xpReward?: number }[] }
interface Doc {
  learningPath: { id: string; title: string; goal: string; revision: number }
  editor: { format_version: 1; cards: { id: string; title: string; position: Point }[]; connections: { from_id: string; to_id: string }[] }
  application: { skills: Skill[] }
}

const steps: string[] = []
function pass(step: string, detail: string) {
  steps.push(step)
  console.log(`  ✓ ${step}: ${detail}`)
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const resend = startResendStandIn()
async function emailedLink(to: string, subject: string, after = 0) {
  for (let i = 0; i < 100; i++) {
    const fresh = resend.sent.slice(after).filter((e) => e.to.some((a) => a.toLowerCase() === to.toLowerCase()) && e.subject.startsWith(subject))
    const link = fresh.length ? /https?:\/\/\S+/.exec(fresh.at(-1)!.text)?.[0] : undefined
    if (link) return link
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no "${subject}" email reached ${to}`)
}

async function api(page: Page, apiPath: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(async (p: string, m: string, b: string | null) => {
    const response = await fetch(`/api${p}`, { method: m, headers: b === null ? undefined : { 'content-type': 'application/json' }, body: b ?? undefined })
    return { status: response.status, body: await response.json().catch(() => null) }
  }, apiPath, method, body === undefined ? null : JSON.stringify(body))
}
async function ok(page: Page, apiPath: string, method = 'GET', body?: unknown) {
  const result = await api(page, apiPath, method, body)
  check([200, 201].includes(result.status), `${method} ${apiPath} answered ${result.status}: ${JSON.stringify(result.body)}`)
  return result.body
}
const text = (page: Page, selector: string) => page.$eval(selector, (el) => el.textContent?.trim() ?? '')
async function setValue(page: Page, selector: string, value: string) {
  await page.$eval(selector, (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}
async function authenticate(page: Page, mode: 'sign-in' | 'sign-up', email: string) {
  await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#sign-in-form')
  await setValue(page, '#email-input', email)
  await setValue(page, '#password-input', PASSWORD)
  await page.click(mode === 'sign-in' ? '#sign-in-btn' : '#sign-up-btn')
  await page.waitForSelector('#personal-workspace')
  return page.$eval('main', (el) => (el as HTMLElement).dataset.accountId!)
}
async function signUpVerified(page: Page, email: string) {
  const before = resend.sent.length
  const id = await authenticate(page, 'sign-up', email)
  await page.goto(await emailedLink(email, 'Verify', before), { waitUntil: 'networkidle0' })
  await page.waitForSelector('#email-verification-status[data-verified="true"]')
  return id
}
async function newPage(browser: Browser, errors: string[]) {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('dialog', (dialog) => { errors.push(`dialog ${dialog.type()}`); void dialog.accept() })
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 })
  return page
}

const saveState = (page: Page) => page.$eval('#save-status', (el) => ({ state: (el as HTMLElement).dataset.state!, revision: Number((el as HTMLElement).dataset.revision) }))
async function waitForSaved(page: Page, revision: number) {
  await page.waitForFunction((want: number) => {
    const el = document.querySelector('#save-status') as HTMLElement | null
    return el?.dataset.state === 'saved' && Number(el.dataset.revision) === want
  }, { timeout: 10000 }, revision).catch(async () => {
    throw new Error(`expected "saved" at revision ${revision}, status is ${JSON.stringify(await saveState(page))} ${await text(page, '#save-error').catch(() => '')}`)
  })
}
async function waitForState(page: Page, state: string) {
  await page.waitForFunction((want: string) => (document.querySelector('#save-status') as HTMLElement | null)?.dataset.state === want, { timeout: 10000 }, state)
    .catch(async () => { throw new Error(`expected save state ${state}, status is ${JSON.stringify(await saveState(page))}`) })
}
async function openEditor(page: Page, url: string, cards: number) {
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#path-editor[data-gpu-status="ready"]', { timeout: 20000 }).catch(async () => {
    throw new Error(`the editor did not reach WebGPU 'ready' (status ${await page.$eval('#path-editor', (el) => (el as HTMLElement).dataset.gpuStatus).catch(() => 'absent')})`)
  })
  await waitForCards(page, cards)
  await page.waitForSelector('#save-status[data-state="saved"]')
}
const waitForCards = (page: Page, n: number) => page.waitForFunction((count: number) => document.querySelectorAll('[id^="card-label-"]').length === count, {}, n)
const cardIds = (page: Page) => page.$$eval('[id^="card-label-"]', (els) => els.map((el) => el.id.replace('card-label-', '')).sort())
/** Each label's world position: its own left/top, before the camera transform. */
const labelWorld = (page: Page) => page.$$eval('[id^="card-label-"]', (els) => Object.fromEntries(els.map((el) => [el.id.replace('card-label-', ''), { x: parseFloat((el as HTMLElement).style.left), y: parseFloat((el as HTMLElement).style.top) }])))
async function cardPoint(page: Page, id: string) {
  await closeEditorPanels(page)
  const point = await page.$eval(`#card-label-${id}`, (el) => {
    const canvas = document.querySelector('#editor-canvas')!, r = el.getBoundingClientRect()
    for (let y = r.top + 8; y < r.bottom - 8; y += 8) for (let x = r.left + 8; x < r.right - 8; x += 8) {
      if (document.elementFromPoint(x, y) === canvas) return { x, y }
    }
    return null
  })
  check(point, `card ${id} is not visible on the canvas`)
  return point
}
/** Selects a Skill by clicking its card on the WebGPU canvas. */
async function select(page: Page, id: string) {
  const point = await cardPoint(page, id)
  await page.mouse.click(point.x, point.y)
  await page.waitForFunction((want: string) => document.querySelector('#selected-skill-id')?.textContent?.trim() === want, {}, id)
}
/** Deletes the selected Skill from the editor and waits for its card to leave the canvas. */
async function deleteSkill(page: Page, id: string) {
  await select(page, id)
  check((await page.$eval('#delete-skill-btn', (el) => (el as HTMLButtonElement).disabled)) === false, `deleting ${id} is disabled: ${await page.$eval('#delete-skill-btn', (el) => el.getAttribute('title'))}`)
  await page.click('#delete-skill-btn')
  await page.waitForFunction((want: string) => !document.getElementById(`card-label-${want}`), {}, id)
}
async function undo(page: Page) { await closeEditorPanels(page); await page.click('#editor-undo-btn') }
async function redo(page: Page) { await closeEditorPanels(page); await page.click('#editor-redo-btn') }

/** The document apart from its revision, independent of order: what an undo must restore. */
function definitions(doc: Doc) {
  const byId = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => a.id.localeCompare(b.id))
  return JSON.stringify({
    title: doc.learningPath.title, goal: doc.learningPath.goal,
    cards: byId(doc.editor.cards), connections: doc.editor.connections.map((c) => `${c.from_id}>${c.to_id}`).sort(),
    skills: byId(doc.application.skills).map((s) => ({ ...s, tasks: byId(s.tasks) })),
  })
}
const edgesOf = (doc: Doc) => doc.editor.connections.map((c) => `${c.from_id}>${c.to_id}`).sort()

async function main() {
  if (!process.argv.includes('--skip-build')) {
    console.log('Building current sources (Wasm + production bundle)...')
    execFileSync('bun', ['run', 'build'], { cwd: FRONTEND, stdio: 'inherit' })
  }
  execFileSync('bun', ['run', 'test/support/prepare-browser-database.ts'], { cwd: BACKEND, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: DATABASE_URL } })
  const apiServer = spawn('bun', ['run', 'src/index.ts'], {
    cwd: BACKEND,
    env: {
      ...process.env, DATABASE_URL, PORT: String(API_PORT), BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: SECRET, NODE_ENV: 'test',
      RESEND_API_KEY: resend.apiKey, RESEND_API_URL: resend.url, MAIL_FROM: 'Gurow <invitations@gurow.test>',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const web = spawn('node', ['.output/server/index.mjs'], { cwd: FRONTEND, env: { ...process.env, PORT: String(PORT), GUROW_API_ORIGIN: `http://127.0.0.1:${API_PORT}` }, stdio: 'ignore' })
  const browser = await puppeteer.launch({
    executablePath: resolveChromiumExecutable(), headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu', '--use-gl=angle', '--disable-dev-shm-usage'],
  })
  const errors: string[] = []
  let current: Page | null = null
  try {
    await waitForServerReady(ORIGIN)
    for (let i = 0; i < 30; i++) {
      if ((await fetch(`${ORIGIN}/api/account`).catch(() => null))?.status === 401) break
      await new Promise((r) => setTimeout(r, 300))
    }

    // 0. Ada's personal Path: Ownership → Lifetimes → Async, Traits → Async; Ownership's Task is completed (history).
    const ada = current = await newPage(browser, errors)
    await authenticate(ada, 'sign-up', 'ada@gurow.test')
    await setValue(ada, '#new-path-title', 'Systems Rust')
    await setValue(ada, '#new-path-goal', 'Ship a small allocator')
    await ada.click('#create-path-btn')
    await ada.waitForSelector('#path-editor[data-path-id]')
    const pathId = await ada.$eval('#path-editor', (el) => (el as HTMLElement).dataset.pathId!)
    const route = `/personal/learning-paths/${pathId}`
    const id = { ownership: crypto.randomUUID(), lifetimes: crypto.randomUUID(), traits: crypto.randomUUID(), async: crypto.randomUUID() }
    const task = { borrow: crypto.randomUUID(), annotate: crypto.randomUUID(), impl: crypto.randomUUID(), futures: crypto.randomUUID() }
    const fresh: Doc = await ok(ada, route)
    const seeded: Doc = await ok(ada, `${route}/document`, 'PUT', {
      expectedRevision: fresh.learningPath.revision, title: fresh.learningPath.title, goal: fresh.learningPath.goal,
      editor: { format_version: 1, cards: [
        { id: id.ownership, title: 'Ownership', position: { x: 100, y: 100 } }, { id: id.lifetimes, title: 'Lifetimes', position: { x: 420, y: 100 } },
        { id: id.traits, title: 'Traits', position: { x: 100, y: 330 } }, { id: id.async, title: 'Async', position: { x: 740, y: 330 } },
      ], connections: [{ from_id: id.ownership, to_id: id.lifetimes }, { from_id: id.lifetimes, to_id: id.async }, { from_id: id.traits, to_id: id.async }] },
      application: { skills: [
        { id: id.ownership, title: 'Ownership', outcome: 'Explain moves and borrows', tasks: [{ id: task.borrow, title: 'Borrow exercises', description: 'Ten exercises' }] },
        { id: id.lifetimes, title: 'Lifetimes', outcome: 'Annotate lifetimes', tasks: [{ id: task.annotate, title: 'Annotate a parser', description: 'By hand' }] },
        { id: id.traits, title: 'Traits', outcome: 'Write generic code', tasks: [{ id: task.impl, title: 'Implement Display', description: 'Three types' }] },
        { id: id.async, title: 'Async', outcome: 'Write async code', tasks: [{ id: task.futures, title: 'Join futures', description: 'With tokio' }] },
      ] },
    })
    await ok(ada, `${route}/tasks/${task.borrow}/reward`, 'PUT', { xpReward: 25 })
    await ok(ada, `${route}/tasks/${task.borrow}/completion`, 'PUT')
    await ok(ada, `${route}/skills/${id.ownership}/xp-threshold`, 'PUT', { xpThreshold: 25 })
    await ok(ada, `${route}/skills/${id.ownership}/mastery`, 'PUT')
    const learningBefore = (await ok(ada, `${route}/learning-state`)).learningState
    const ownershipBefore = learningBefore.skills.find((s: any) => s.skillId === id.ownership)
    const borrowBefore = learningBefore.tasks.find((t: any) => t.taskId === task.borrow)
    check(learningBefore.xp === 25 && ownershipBefore?.mastery && borrowBefore?.completed && learningBefore.masteryHistory.length > 0, 'completion did not establish XP and Mastery history')
    await openEditor(ada, `${ORIGIN}/paths/${pathId}`, 4)
    let revision = seeded.learningPath.revision
    await waitForSaved(ada, revision)

    // 1. A Skill with learning history offers no deletion; its Tasks can be archived instead.
    await select(ada, id.ownership)
    await ada.waitForSelector('#skill-delete-blocked')
    check(await ada.$('#delete-skill-btn') === null && (await text(ada, '#skill-delete-blocked')).includes('has learning history, so it cannot be deleted'), `Ownership offers deletion: ${await text(ada, '#skill-delete-blocked').catch(() => 'no notice')}`)
    check(await ada.$(`#task-archive-${task.borrow}`) !== null, 'the completed Task cannot be archived')
    pass('history keeps a Skill', `Ownership (its Task completed) shows "${(await text(ada, '#skill-delete-blocked')).slice(0, 60)}…" and offers archiving its Task instead of deletion`)

    // 2. An unused Skill is deleted with its Task, card and connections, and saved.
    const positions = await labelWorld(ada)
    await deleteSkill(ada, id.lifetimes)
    check((await text(ada, '#deletion-status')).startsWith('Deleted “Lifetimes” with its Task and its connections. Undo brings it back'), `deletion status: ${await text(ada, '#deletion-status')}`)
    check(await ada.$('#selected-skill-id') === null, 'the deleted Skill is still open in the sidebar')
    await waitForSaved(ada, ++revision)
    const deleted: Doc = await ok(ada, route)
    check(JSON.stringify(deleted.application.skills.map((s) => s.id).sort()) === JSON.stringify([id.ownership, id.traits, id.async].sort()), `stored Skills ${deleted.application.skills.map((s) => s.title)}`)
    check(!deleted.application.skills.some((s) => s.tasks.some((t) => t.id === task.annotate)) && !deleted.editor.cards.some((c) => c.id === id.lifetimes), 'the Task or card of Lifetimes is still stored')
    check(JSON.stringify(edgesOf(deleted)) === JSON.stringify([`${id.traits}>${id.async}`]), `stored connections ${edgesOf(deleted)}`)
    const learningAfter = (await ok(ada, `${route}/learning-state`)).learningState
    check(learningAfter.xp === learningBefore.xp && JSON.stringify(learningAfter.xpHistory) === JSON.stringify(learningBefore.xpHistory) && !learningAfter.skills.some((s: any) => s.skillId === id.lifetimes), 'the deletion changed learning records or left the Skill in them')
    pass('unused Skill deleted', `Lifetimes leaves with "Annotate a parser", its card and Ownership → Lifetimes → Async; saved revision ${revision}; Path XP ${learningAfter.xp} and XP history unchanged`)

    // 3. Undo and redo after the save are new validated saves with the same IDs.
    await undo(ada)
    await waitForCards(ada, 4)
    await waitForSaved(ada, ++revision)
    const restored: Doc = await ok(ada, route)
    check(definitions(restored) === definitions(seeded), `after undo the stored document differs:\n${definitions(restored)}\n${definitions(seeded)}`)
    check(JSON.stringify((await labelWorld(ada))[id.lifetimes]) === JSON.stringify(positions[id.lifetimes]), 'the restored card is not at its place')
    check(await ada.$('#deletion-status') === null, 'the deletion notice stayed after the undo')
    await redo(ada)
    await waitForCards(ada, 3)
    await waitForSaved(ada, ++revision)
    check(definitions(await ok(ada, route)) === definitions(deleted), 'redo did not delete Lifetimes again')
    await undo(ada)
    await waitForCards(ada, 4)
    await waitForSaved(ada, ++revision)
    check(definitions(await ok(ada, route)) === definitions(seeded), 'the second undo did not restore Lifetimes')
    const learningRestored = (await ok(ada, `${route}/learning-state`)).learningState
    check(learningRestored.xp === learningBefore.xp && JSON.stringify(learningRestored.xpHistory) === JSON.stringify(learningBefore.xpHistory) && JSON.stringify(learningRestored.masteryHistory) === JSON.stringify(learningBefore.masteryHistory), 'undo or redo changed XP or Mastery history')
    check(JSON.stringify(learningRestored.skills.find((s: any) => s.skillId === id.ownership)) === JSON.stringify(ownershipBefore) && JSON.stringify(learningRestored.tasks.find((t: any) => t.taskId === task.borrow)) === JSON.stringify(borrowBefore), 'undo or redo changed unrelated progress')
    pass('undo and redo after the save', `Undo → revision ${revision - 2} with Lifetimes, its Task, card at (${positions[id.lifetimes].x}, ${positions[id.lifetimes].y}) and both connections, same IDs; Redo → revision ${revision - 1} without; Undo → revision ${revision}; completion and XP history untouched`)

    // 4. A connection is removed, brought back by undo, and reload shows what was saved.
    await select(ada, id.traits)
    await ada.click(`#disconnect-${id.traits}-${id.async}`)
    await waitForSaved(ada, ++revision)
    check(!edgesOf(await ok(ada, route)).includes(`${id.traits}>${id.async}`), 'the removed connection is still stored')
    check((await ok(ada, route)).application.skills.length === 4, 'removing a connection removed a Skill')
    await undo(ada)
    await waitForSaved(ada, ++revision)
    check(edgesOf(await ok(ada, route)).includes(`${id.traits}>${id.async}`), 'undo did not bring the connection back')
    await ada.reload({ waitUntil: 'networkidle0' })
    await openEditor(ada, `${ORIGIN}/paths/${pathId}`, 4)
    await waitForSaved(ada, revision)
    const reloaded: Doc = await ok(ada, route)
    check(definitions(reloaded) === definitions(seeded), 'the reloaded document differs from the seeded one')
    const reloadedPositions = await labelWorld(ada)
    check(reloaded.editor.cards.every((c) => reloadedPositions[c.id]?.x === c.position.x && reloadedPositions[c.id]?.y === c.position.y), 'reloaded labels are off their stored positions')
    await select(ada, id.traits)
    check(JSON.parse(await ada.$eval('#skill-detail-panel', (el) => (el as HTMLElement).dataset.connections ?? '[]')).some((c: any) => c.from_id === id.traits && c.to_id === id.async), 'the reloaded editor lost Traits → Async')
    check(await ada.$eval('#editor-undo-btn', (el) => (el as HTMLButtonElement).disabled), 'the undo history survived the reload')
    pass('connection deletion and reload', `removing Traits → Async → revision ${revision - 1}; Undo → revision ${revision} with it back; reload shows the same Skills, positions and connections with nothing to undo`)

    // 5. History that appears before the deletion is saved: the backend refuses it, the local work stays, undo recovers.
    // The page's records do not know yet that Async now has an Access Override.
    await ok(ada, `${route}/skills/${id.async}/access-override`, 'PUT')
    await deleteSkill(ada, id.async)
    await waitForState(ada, 'rejected')
    check((await ada.$eval('#save-error', (el) => el.getAttribute('title') ?? '')).includes('Skill "Async" has learning history and cannot be deleted'), `refusal: ${await ada.$eval('#save-error', (el) => el.getAttribute('title'))}`)
    check(!(await cardIds(ada)).includes(id.async), 'the refused deletion was dropped locally')
    check(definitions(await ok(ada, route)) === definitions(seeded), 'the refused deletion reached the backend')
    await undo(ada)
    await waitForCards(ada, 4)
    await waitForSaved(ada, revision)
    check(definitions(await ok(ada, route)) === definitions(seeded), 'recovering changed the stored document')
    await ada.reload({ waitUntil: 'networkidle0' })
    await openEditor(ada, `${ORIGIN}/paths/${pathId}`, 4)
    await select(ada, id.async)
    await ada.waitForSelector('#skill-delete-blocked')
    pass('history refuses a deletion', `an Access Override granted elsewhere before the save: "Not saved: the change was refused" (Skill “Async” has learning history…), the card stays deleted locally and the store unchanged; one Undo brings Async back and saves at revision ${revision}; after reload Async offers no deletion`)

    // 6. A stale tab reapplies its deletion onto the accepted document.
    const tab2 = current = await ada.browserContext().newPage()
    tab2.setDefaultTimeout(10000)
    tab2.on('pageerror', (error) => errors.push(String(error)))
    tab2.on('dialog', (dialog) => { void dialog.accept() })
    await tab2.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 })
    await openEditor(tab2, `${ORIGIN}/paths/${pathId}`, 4)
    await ada.bringToFront()
    await closeEditorPanels(ada)
    await setValue(ada, '#path-goal-input', 'Ship an allocator and a parser')
    await waitForSaved(ada, ++revision)
    await tab2.bringToFront()
    await deleteSkill(tab2, id.traits)
    await waitForState(tab2, 'conflict')
    const changes = await text(tab2, '#conflict-changes')
    check(changes.includes('Deleted the Skill “Traits” with 1 Task') && !changes.includes('Removed the connection'), `conflict changes: ${changes}`)
    check(definitions(await ok(tab2, route)) !== definitions(seeded) && (await ok(tab2, route)).application.skills.some((s: Skill) => s.id === id.traits), 'the stale deletion reached the backend')
    await closeEditorPanels(tab2)
    await tab2.click('#reapply-mine-btn')
    await waitForSaved(tab2, ++revision)
    const merged: Doc = await ok(tab2, route)
    check(merged.learningPath.goal === 'Ship an allocator and a parser' && !merged.application.skills.some((s) => s.id === id.traits) && !edgesOf(merged).some((e) => e.includes(id.traits)), `merged document: goal ${merged.learningPath.goal}, Skills ${merged.application.skills.map((s) => s.title)}`)
    await tab2.close()
    current = ada
    pass('stale tab reapplies a deletion', `tab 2 (opened before the goal changed in tab 1) deletes Traits → conflict listing "Deleted the Skill “Traits” with 1 Task"; reapplying saves revision ${revision} with tab 1's goal and without Traits or its connection`)

    // 7. A Coach's Draft: published Skills stay, a Draft-only Skill is deleted and restored, the published Version is unchanged.
    const carla = current = await newPage(browser, errors)
    await signUpVerified(carla, 'carla@gurow.test')
    const workspace = (await ok(carla, '/coach/workspaces', 'POST', { name: 'Linear Algebra Studio' })).workspace
    const created = await ok(carla, `/coach/workspaces/${workspace.id}/learning-paths`, 'POST', { title: 'Linear Algebra', goal: 'Linear maps' })
    const la = { path: created.learningPath.id as string, vectors: crypto.randomUUID(), matrices: crypto.randomUUID(), eigen: crypto.randomUUID(), drills: crypto.randomUUID(), matrixDrills: crypto.randomUUID(), eigenDrills: crypto.randomUUID() }
    const coachRoute = `/coach/learning-paths/${la.path}`
    const firstDraft = await ok(carla, `${coachRoute}/draft`, 'PUT', {
      expectedRevision: created.learningPath.revision, title: 'Linear Algebra', goal: 'Linear maps',
      editor: { format_version: 1, cards: [{ id: la.vectors, title: 'Vectors', position: { x: 80, y: 120 } }, { id: la.matrices, title: 'Matrices', position: { x: 420, y: 120 } }], connections: [{ from_id: la.vectors, to_id: la.matrices }] },
      application: { skills: [
        { id: la.vectors, title: 'Vectors', outcome: 'Add vectors', optional: false, xpThreshold: 0, tasks: [{ id: la.drills, title: 'Vector drills', description: '', required: true, xpReward: 20 }] },
        { id: la.matrices, title: 'Matrices', outcome: 'Multiply matrices', optional: false, xpThreshold: 20, tasks: [{ id: la.matrixDrills, title: 'Matrix drills', description: '', required: true, xpReward: 15 }] },
      ] },
    })
    const published = await ok(carla, `${coachRoute}/publication`, 'POST', { expectedRevision: firstDraft.learningPath.revision })
    const version1 = await ok(carla, `/coach/learning-path-versions/${published.version.id}`)
    const lenaPage = await newPage(browser, errors)
    await signUpVerified(lenaPage, 'lena@gurow.test')
    const beforeInvite = resend.sent.length
    const invited = await ok(carla, `/coach/learning-path-versions/${published.version.id}/invitations`, 'POST', { email: 'lena@gurow.test' })
    check(invited.delivered === true, 'invitation was not delivered')
    await lenaPage.goto(await emailedLink('lena@gurow.test', 'You are invited', beforeInvite), { waitUntil: 'networkidle0' })
    await lenaPage.click('#accept-invitation-btn')
    await lenaPage.waitForSelector('#invitation-result[data-outcome="enrolled"]')
    const enrollment = await lenaPage.$eval('#invitation-result', (el) => (el as HTMLElement).dataset.enrollmentId!)
    const evidenceRoute = `/enrollments/${enrollment}/tasks/${la.drills}/submission`
    const sent = await ok(lenaPage, `${evidenceRoute}/revisions`, 'POST', { text: 'Vector evidence', urls: [] })
    await ok(carla, `${evidenceRoute}/revisions/${sent.revision.id}/review`, 'POST', { decision: 'approval' })
    const enrollmentBefore = (await ok(lenaPage, `/enrollments/${enrollment}/learning-state`)).learningState
    const evidenceBefore = (await ok(lenaPage, evidenceRoute)).submission
    check(enrollmentBefore.xp === 20 && enrollmentBefore.skills.find((s: any) => s.skillId === la.vectors)?.mastery, 'approval did not establish XP and Mastery')
    await carla.bringToFront()
    const opened: Doc = await ok(carla, `${coachRoute}/drafts`, 'POST', { expectedRevision: published.learningPath.revision })
    const withEigen: Doc = await ok(carla, `${coachRoute}/draft`, 'PUT', {
      expectedRevision: opened.learningPath.revision, title: opened.learningPath.title, goal: opened.learningPath.goal,
      editor: { ...opened.editor, cards: [...opened.editor.cards, { id: la.eigen, title: 'Eigenvalues', position: { x: 760, y: 120 } }], connections: [...opened.editor.connections, { from_id: la.vectors, to_id: la.eigen }] },
      application: { skills: [...opened.application.skills, { id: la.eigen, title: 'Eigenvalues', outcome: 'Find eigenvalues', optional: false, xpThreshold: 15, tasks: [{ id: la.eigenDrills, title: 'Eigen drills', description: 'Ten', required: true, xpReward: 25 }] }] },
    })
    let draftRevision = withEigen.learningPath.revision
    await openEditor(carla, `${ORIGIN}/coach/paths/${la.path}`, 3)
    await waitForSaved(carla, draftRevision)
    await select(carla, la.matrices)
    await carla.waitForSelector('#skill-delete-blocked')
    check((await text(carla, '#skill-delete-blocked')).includes('is part of a published Version, so it cannot be deleted'), `Matrices: ${await text(carla, '#skill-delete-blocked')}`)
    await deleteSkill(carla, la.eigen)
    await waitForSaved(carla, ++draftRevision)
    const draftDeleted: Doc = await ok(carla, coachRoute)
    check(definitions(draftDeleted) === definitions(opened), 'the Draft without Eigenvalues differs from the opened Draft')
    await undo(carla)
    await waitForCards(carla, 3)
    await waitForSaved(carla, ++draftRevision)
    check(definitions(await ok(carla, coachRoute)) === definitions(withEigen), 'undo did not restore Eigenvalues with its rules and reward')
    // The response also includes mutable Path revision and open-Draft metadata; compare the Version itself.
    const versionAfter = await ok(carla, `/coach/learning-path-versions/${published.version.id}`)
    check(definitions(versionAfter) === definitions(version1) && JSON.stringify(versionAfter.version) === JSON.stringify(version1.version), 'the published Version content or identity changed')
    pass('Draft deletion', `Matrices (published in Version 1) offers no deletion; Draft-only Eigenvalues is deleted (revision ${draftRevision - 1}) and restored by Undo with its 15-XP threshold and 25-XP Required Task (revision ${draftRevision}); Version 1 unchanged`)

    // 8. An undo that no longer passes the Draft rules is refused, and the local work stays.
    await select(carla, la.vectors)
    // Remove the other required dependent first; otherwise the optional toggle is correctly blocked.
    await carla.click(`#disconnect-${la.vectors}-${la.matrices}`)
    await waitForSaved(carla, ++draftRevision)
    await carla.click(`#disconnect-${la.vectors}-${la.eigen}`)
    await waitForSaved(carla, ++draftRevision)
    await carla.click('#skill-optional-input')
    await waitForSaved(carla, ++draftRevision)
    const optionalDraft: Doc = await ok(carla, coachRoute)
    check(optionalDraft.application.skills.find((s) => s.id === la.vectors)?.optional === true, 'Vectors was not made optional')
    // Undo brings back Vectors → Eigenvalues: an Optional Skill as a Prerequisite of a required one.
    await undo(carla)
    await carla.waitForSelector('#draft-rule-problem')
    await new Promise((r) => setTimeout(r, 900))
    const refusedState = await saveState(carla)
    check(refusedState.state !== 'saved' && refusedState.revision === draftRevision, `the rule-breaking undo was saved: ${JSON.stringify(refusedState)}`)
    check(JSON.stringify(await ok(carla, coachRoute)) === JSON.stringify(optionalDraft), 'the rule-breaking undo reached the backend')
    const ruleRefusal = await api(carla, `${coachRoute}/draft`, 'PUT', {
      expectedRevision: optionalDraft.learningPath.revision, title: optionalDraft.learningPath.title, goal: optionalDraft.learningPath.goal,
      editor: { ...optionalDraft.editor, connections: [...optionalDraft.editor.connections, { from_id: la.vectors, to_id: la.eigen }] }, application: optionalDraft.application,
    })
    check(ruleRefusal.status === 422 && ruleRefusal.body.error === 'optional_prerequisite', `the backend answered the restored connection with ${ruleRefusal.status} ${JSON.stringify(ruleRefusal.body)}`)
    check(JSON.parse(await carla.$eval('#skill-detail-panel', (el) => (el as HTMLElement).dataset.connections ?? '[]')).some((c: any) => c.from_id === la.vectors && c.to_id === la.eigen), 'the local connection was dropped')
    await redo(carla)
    await waitForSaved(carla, draftRevision)
    check(await carla.$('#draft-rule-problem') === null && JSON.stringify(await ok(carla, coachRoute)) === JSON.stringify(optionalDraft), 'redo did not return to the saved Draft')
    pass('rule-breaking undo refused', `after removing Vectors → Eigenvalues and making Vectors optional, Undo shows the Draft rule problem, nothing is saved (state ${refusedState.state}, revision ${draftRevision}; the backend answers that document 422 optional_prerequisite) and the connection stays on screen; Redo returns to the saved Draft`)

    // 9. Nobody else deletes anything.
    current = lenaPage
    check(JSON.stringify((await ok(lenaPage, `/enrollments/${enrollment}/learning-state`)).learningState) === JSON.stringify(enrollmentBefore), 'delete or undo changed Enrollment XP, Mastery or history')
    check(JSON.stringify((await ok(lenaPage, evidenceRoute)).submission) === JSON.stringify(evidenceBefore), 'delete or undo changed immutable Submissions or Reviews')
    pass('Enrollment and assessment history retained', 'Lena remains on Version 1 with the same approved vector evidence, Review, 20 XP and Mastery after Draft deletion, undo and rejected restoration')
    const adaDoc: Doc = await ok(ada, route)
    const withoutAsync = { expectedRevision: adaDoc.learningPath.revision, title: adaDoc.learningPath.title, goal: adaDoc.learningPath.goal,
      editor: { ...adaDoc.editor, cards: adaDoc.editor.cards.filter((c) => c.id !== id.ownership), connections: adaDoc.editor.connections.filter((c) => c.from_id !== id.ownership && c.to_id !== id.ownership) },
      application: { skills: adaDoc.application.skills.filter((s) => s.id !== id.ownership) } }
    const draftDoc: Doc = await ok(carla, coachRoute)
    const withoutEigen = { expectedRevision: draftDoc.learningPath.revision, title: draftDoc.learningPath.title, goal: draftDoc.learningPath.goal,
      editor: { ...draftDoc.editor, cards: draftDoc.editor.cards.filter((c) => c.id !== la.eigen), connections: draftDoc.editor.connections.filter((c) => c.to_id !== la.eigen) },
      application: { skills: draftDoc.application.skills.filter((s) => s.id !== la.eigen) } }
    const attempts = [
      await api(lenaPage, `${route}/document`, 'PUT', withoutAsync),
      await api(lenaPage, `${coachRoute}/draft`, 'PUT', withoutEigen),
      await api(carla, `${route}/document`, 'PUT', withoutAsync),
    ]
    const stale = await api(carla, `${coachRoute}/draft`, 'PUT', { ...withoutEigen, expectedRevision: withoutEigen.expectedRevision - 1 })
    check(attempts.every((a) => a.status === 404) && stale.status === 409 && stale.body.error === 'stale_revision', `forbidden deletions answered ${attempts.map((a) => a.status)}, stale ${stale.status}`)
    check(JSON.stringify(await ok(ada, route)) === JSON.stringify(adaDoc) && JSON.stringify(await ok(carla, coachRoute)) === JSON.stringify(draftDoc), 'a refused deletion changed a document')
    pass('forbidden and stale deletions', `Lena deleting from Ada's Path or Carla's Draft → 404, Carla deleting from Ada's Path → 404, a stale Draft deletion → 409; both documents unchanged`)

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log(`\nT32 delete-content check passed (${steps.length} steps).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t32-failure.png')
    await current?.screenshot({ path: shot }).then(() => console.error(`screenshot: ${shot}`)).catch(() => {})
    if (errors.length > 0) console.error(`page errors:\n  ${errors.join('\n  ')}`)
    throw error
  } finally {
    await browser.close()
    web.kill()
    apiServer.kill()
    resend.stop()
  }
}

main().catch((error) => {
  console.error(`\nT32 delete-content check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
