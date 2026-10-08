#!/usr/bin/env bun
/**
 * T19 publication check (#20): the production frontend build forwarding /api to the
 * production backend entry (Better Auth sessions) on a freshly migrated PostgreSQL
 * database, in headless Chromium with WebGPU. A Coach authors a Draft whose required
 * route is blocked (60 reachable XP against a 100-XP threshold, with optional work
 * offering the difference), sees publication refused with the affected Skill and
 * requirement, repairs and publishes it, finds the published Version read-only,
 * prepares Version 2 with typo corrections and publishes it, and still reads
 * Version 1 unchanged. Another Coach can neither publish, prepare nor read any of it.
 *
 * Run from frontend: bun run scripts/t19-publication-check.ts [--skip-build]
 */
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Page } from 'puppeteer-core'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'
import { addBoardTask, closeEditorPanels, closeSummaryBoard, editBoardTask, openCardDetails, openNewSkill, openSkillView, openSummaryBoard } from './editor-navigation'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3497)
const API_PORT = Number(process.env.API_PORT ?? 3498)
const ORIGIN = `http://127.0.0.1:${PORT}`
const DATABASE_URL = process.env.T19_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t19_browser_test'
const PASSWORD = 'correct horse battery staple'

interface Task { id: string; title: string; description: string; required: boolean; xpReward: number }
interface Skill { id: string; title: string; outcome: string; optional: boolean; xpThreshold: number; tasks: Task[] }
interface Doc {
  learningPath: { id: string; coachWorkspaceId: string; title: string; goal: string; revision: number }
  draft: { id: string; versionNumber: number } | null
  version: { id: string; versionNumber: number; publishedAt: string | null } | null
  versions: { id: string; versionNumber: number; publishedAt: string }[]
  editor: { format_version: 1; cards: { id: string; title: string; position: { x: number; y: number } }[]; connections: { from_id: string; to_id: string }[] }
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

async function api(page: Page, apiPath: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(async (p: string, m: string, b: string | null) => {
    const response = await fetch(`/api${p}`, { method: m, headers: b === null ? undefined : { 'content-type': 'application/json' }, body: b ?? undefined })
    return { status: response.status, body: await response.json().catch(() => null) }
  }, apiPath, method, body === undefined ? null : JSON.stringify(body))
}
async function readPath(page: Page, pathId: string): Promise<Doc> {
  const result = await api(page, `/coach/learning-paths/${pathId}`)
  check(result.status === 200, `reading Path ${pathId} answered ${result.status}`)
  return result.body
}
const content = (doc: Doc) => JSON.stringify({ skills: doc.application.skills, connections: doc.editor.connections })

const text = (page: Page, selector: string) => page.$eval(selector, (el) => el.textContent?.trim() ?? '')
const saveState = (page: Page) => page.$eval('#save-status', (el) => ({ state: (el as HTMLElement).dataset.state!, revision: Number((el as HTMLElement).dataset.revision) }))
async function waitForSaved(page: Page) {
  await new Promise((r) => setTimeout(r, 700))
  await page.waitForFunction(() => (document.querySelector('#save-status') as HTMLElement | null)?.dataset.state === 'saved', { timeout: 10000 })
    .catch(async () => { throw new Error(`expected "saved", status is ${JSON.stringify(await saveState(page))} ${await text(page, '#save-error').catch(() => '')}`) })
}
async function setValue(page: Page, selector: string, value: string) {
  await page.$eval(selector, (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}
async function authenticate(page: Page, mode: 'sign-in' | 'sign-up', email: string) {
  await page.waitForSelector('#sign-in-form')
  await setValue(page, '#email-input', email)
  await setValue(page, '#password-input', PASSWORD)
  await page.click(mode === 'sign-in' ? '#sign-in-btn' : '#sign-up-btn')
  await page.waitForSelector('#personal-workspace')
}
async function signOut(page: Page) {
  await closeEditorPanels(page)
  await page.click('#sign-out-btn')
  await page.waitForSelector('#sign-in-form')
}
async function openEditor(page: Page, cards: number) {
  await page.waitForSelector('#path-editor[data-gpu-status="ready"]', { timeout: 20000 }).catch(async () => {
    throw new Error(`the editor did not reach WebGPU 'ready' (status ${await page.$eval('#path-editor', (el) => (el as HTMLElement).dataset.gpuStatus).catch(() => 'absent')})`)
  })
  await page.waitForFunction((n: number) => document.querySelectorAll('[id^="card-label-"]').length === n, {}, cards)
  return page.$eval('#path-editor', (el) => (el as HTMLElement).dataset.pathId!)
}
const labelIds = (page: Page) => page.$$eval('[id^="card-label-"]', (els) => els.map((el) => el.id.replace('card-label-', '')))
async function addSkill(page: Page, title: string, outcome: string) {
  const before = await labelIds(page)
  await openNewSkill(page)
  await setValue(page, '#new-skill-title', title)
  await setValue(page, '#new-skill-outcome', outcome)
  await page.click('#add-skill-btn')
  await page.waitForFunction((n: number) => document.querySelectorAll('[id^="card-label-"]').length === n, {}, before.length + 1)
  const id = (await labelIds(page)).find((x) => !before.includes(x))!
  await page.waitForFunction((want: string) => document.querySelector('#selected-skill-id')?.textContent?.trim() === want, {}, id)
  return id
}
async function select(page: Page, id: string) {
  await closeEditorPanels(page)
  const point = await page.$eval(`#card-label-${id}`, (el) => {
    const canvas = document.querySelector('#editor-canvas')!, r = el.getBoundingClientRect()
    for (let y = r.top + 8; y < r.bottom - 8; y += 8) for (let x = r.left + 8; x < r.right - 8; x += 8) {
      if (document.elementFromPoint(x, y) === canvas) return { x, y }
    }
    return null
  })
  check(point, `card ${id} is not visible on the canvas`)
  await page.mouse.click(point.x, point.y)
  await page.waitForFunction((want: string) => document.querySelector('#selected-skill-id')?.textContent?.trim() === want, {}, id)
}
/** Adds a Draft Task through the Skill's preparation board, with its Required setting and reward from its details. */
async function addTask(page: Page, title: string, required: boolean, xpReward: number) {
  await openSummaryBoard(page)
  const id = await addBoardTask(page, title)
  await openCardDetails(page, id)
  if (!required) await page.click(`#board-task-required-${id}`)
  await setValue(page, `#board-task-xp-reward-${id}`, String(xpReward))
  await closeSummaryBoard(page)
  return id
}
async function connect(page: Page, from: string, to: string) {
  await select(page, from)
  await openSkillView(page, 'prerequisites')
  await page.select('#connect-skill-select', to)
  await page.click('#btn-add-dependent')
}
/** The read-only view of a published Version: its number and each Skill's and Task's shown text. */
async function publishedView(page: Page) {
  await page.waitForSelector('#published-version')
  return page.$eval('#published-version', (el) => ({
    versionNumber: Number((el as HTMLElement).dataset.versionNumber),
    versionId: (el as HTMLElement).dataset.versionId!,
    skills: [...el.querySelectorAll('[id^="published-skill-"]')].map((skill) => ({
      id: skill.id.replace('published-skill-', ''),
      title: skill.querySelector('[data-field="title"]')?.textContent ?? '',
      outcome: skill.querySelector('[data-field="outcome"]')?.textContent ?? '',
      tasks: [...skill.querySelectorAll('[id^="published-task-"]')].map((task) => `${task.id.replace('published-task-', '')}:${task.querySelector('[data-field="title"]')?.textContent}`),
    })),
    editable: el.querySelectorAll('input, textarea, select').length,
  }))
}

async function main() {
  if (!process.argv.includes('--skip-build')) {
    console.log('Building current sources (Wasm + production bundle)...')
    execFileSync('bun', ['run', 'build'], { cwd: FRONTEND, stdio: 'inherit' })
  }
  execFileSync('bun', ['run', 'test/support/prepare-browser-database.ts'], { cwd: BACKEND, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: DATABASE_URL } })

  // A developer's backend/.env may hold a real Resend key; this check reads the logged mail instead.
  const apiServer = spawn('bun', ['run', 'src/index.ts'], {
    cwd: BACKEND,
    env: { ...process.env, DATABASE_URL, PORT: String(API_PORT), BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: 't19-browser-check-secret-not-for-production', NODE_ENV: 'test', RESEND_API_KEY: '' },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const web = spawn('node', ['.output/server/index.mjs'], { cwd: FRONTEND, env: { ...process.env, PORT: String(PORT), GUROW_API_ORIGIN: `http://127.0.0.1:${API_PORT}` }, stdio: 'ignore' })
  const browser = await puppeteer.launch({
    executablePath: resolveChromiumExecutable(), headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu', '--use-gl=angle', '--disable-dev-shm-usage'],
  })
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const dialogs: string[] = []
  let current: Page | null = null
  try {
    await waitForServerReady(ORIGIN)
    for (let i = 0; i < 30; i++) {
      if ((await fetch(`${ORIGIN}/api/account`).catch(() => null))?.status === 401) break
      await new Promise((r) => setTimeout(r, 300))
    }
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('dialog', (dialog) => { dialogs.push(dialog.type()); void dialog.accept() })
    current = page
    await page.setViewport({ width: 1800, height: 900, deviceScaleFactor: 1 })

    // 1. A Draft whose required route is blocked: Vectors' Required Tasks give 60 XP, Matrices needs 100.
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
    await authenticate(page, 'sign-up', 'carla@gurow.test')
    await page.click('#switch-to-coach')
    await page.waitForSelector('#coach-home')
    await setValue(page, '#new-coach-workspace-name', 'Linear Algebra Studio')
    await page.click('#create-coach-workspace-btn')
    await page.waitForSelector('#coach-workspace')
    await setValue(page, '#new-coach-path-title', 'Linear Algebra')
    await setValue(page, '#new-coach-path-goal', 'Solve linear systems')
    await page.click('#create-coach-path-btn')
    const pathId = await openEditor(page, 0)
    const vectors = await addSkill(page, 'Vectors', 'Add and scale vectros')
    const drills = await addTask(page, 'Vector drils', true, 30)
    await addTask(page, 'Vector proofs', true, 30)
    await addTask(page, 'Read chapter 1', false, 50)
    const matrices = await addSkill(page, 'Matrices', 'Multiply matrices')
    await openSkillView(page, 'edit')
    await setValue(page, '#skill-threshold-input', '100')
    await addTask(page, 'Matrix drills', true, 10)
    const history = await addSkill(page, 'History of algebra', 'Place results in history')
    await openSkillView(page, 'edit')
    await page.click('#skill-optional-input')
    await addTask(page, 'Essay', true, 50)
    await connect(page, vectors, matrices)
    await connect(page, vectors, history)
    await waitForSaved(page)
    const draft = await readPath(page, pathId)
    check(draft.draft?.versionNumber === 1 && draft.versions.length === 0, `Draft state: ${JSON.stringify({ draft: draft.draft, versions: draft.versions })}`)
    pass('blocked Draft', `rev ${draft.learningPath.revision}: Vectors 30+30 Required + 50 Enrichment, Matrices needs 100 XP, Optional History offers 50`)

    // 2. Publication is refused with the affected Skill and its unmet requirement; nothing is published.
    check(await text(page, '#publish-version-btn') === 'Publish Version 1', `publish button: ${await text(page, '#publish-version-btn')}`)
    await closeEditorPanels(page)
    await page.click('#publish-version-btn')
    await page.waitForSelector('#publication-problems')
    const blocked = await page.$$eval('#publication-problems [data-blocked-skill-id]', (els) => els.map((el) => ({
      id: (el as HTMLElement).dataset.blockedSkillId, text: el.textContent ?? '', unmet: [...el.querySelectorAll('[data-unmet]')].map((u) => (u as HTMLElement).dataset.unmet),
    })))
    check(blocked.length === 1 && blocked[0].id === matrices && JSON.stringify(blocked[0].unmet) === '["xp_threshold"]', `blocked Skills: ${JSON.stringify(blocked)}`)
    check(blocked[0].text.includes('Matrices') && blocked[0].text.includes('needs 100 XP, but Required Tasks on reachable required Skills award only 60 XP'), `explanation: ${blocked[0].text}`)
    const afterRefusal = await readPath(page, pathId)
    check(afterRefusal.draft?.id === draft.draft!.id && afterRefusal.versions.length === 0 && afterRefusal.learningPath.revision === draft.learningPath.revision && content(afterRefusal) === content(draft), 'a refused publication changed the Path')
    check(await page.$('#path-editor') !== null && (await saveState(page)).state === 'saved', 'the Draft stopped being editable after the refusal')
    pass('rejected publication', `"${blocked[0].text.slice(0, 90)}…"; Draft still open, nothing published`)

    // 3. Repair the route in the editor and publish: Version 1 becomes read-only.
    await select(page, matrices)
    await openSkillView(page, 'edit')
    await setValue(page, '#skill-threshold-input', '60')
    await waitForSaved(page)
    check(await page.$('#publication-problems') === null, 'the old refusal is still shown for a changed Draft')
    await closeEditorPanels(page)
    await page.click('#publish-version-btn')
    const v1 = await publishedView(page)
    check(v1.versionNumber === 1 && v1.editable === 0 && await page.$('#path-editor') === null, `published view: ${JSON.stringify(v1)}`)
    check(v1.skills.map((s) => s.id).join() === [vectors, matrices, history].join() && v1.skills[0].outcome === 'Add and scale vectros' && v1.skills[0].tasks[0] === `${drills}:Vector drils`, `Version 1 shows ${JSON.stringify(v1.skills)}`)
    const published = await readPath(page, pathId)
    check(published.draft === null && published.versions.map((v) => v.versionNumber).join() === '1' && published.version?.id === draft.draft!.id, `after publication: ${JSON.stringify({ draft: published.draft, versions: published.versions })}`)
    check(await text(page, '#prepare-draft-btn') === 'Prepare Version 2 as a Draft' && await page.$('#version-link-1') !== null, 'the published Path offers no new Draft or Version link')
    pass('valid route published', `Matrices threshold 60 → Version 1 published (${v1.versionId.slice(0, 8)}); shown read-only with ${v1.skills.length} Skills and no inputs`)

    // 4. Published content cannot be edited in place, not even a typo, through direct requests.
    const typoFix = { expectedRevision: published.learningPath.revision, title: published.learningPath.title, goal: published.learningPath.goal, editor: published.editor,
      application: { skills: published.application.skills.map((s) => s.id === vectors ? { ...s, outcome: 'Add and scale vectors' } : s) } }
    const direct = {
      save: await api(page, `/coach/learning-paths/${pathId}/draft`, 'PUT', typoFix),
      republish: await api(page, `/coach/learning-paths/${pathId}/publication`, 'POST', { expectedRevision: published.learningPath.revision }),
      staleSave: await api(page, `/coach/learning-paths/${pathId}/draft`, 'PUT', { ...typoFix, expectedRevision: draft.learningPath.revision }),
    }
    check(direct.save.status === 409 && direct.save.body.error === 'no_open_draft', `typo save: ${JSON.stringify(direct.save)}`)
    check(direct.republish.status === 409 && direct.republish.body.error === 'no_open_draft', `republish: ${JSON.stringify(direct.republish)}`)
    check(direct.staleSave.status === 409 && direct.staleSave.body.error === 'stale_revision', `stale save: ${JSON.stringify(direct.staleSave)}`)
    check(content(await readPath(page, pathId)) === content(published), 'a direct write changed published content')
    pass('immutable in place', `typo save ${direct.save.body.error}, republish ${direct.republish.body.error}, pre-publication save ${direct.staleSave.body.error}; Version 1 unchanged`)

    // 5. A new content Version: prepare a Draft, correct the typos, publish Version 2.
    await page.click('#prepare-draft-btn')
    await openEditor(page, 3)
    check(await text(page, '#publish-version-btn') === 'Publish Version 2', 'the new Draft is not Version 2')
    const prepared = await readPath(page, pathId)
    check(prepared.draft?.versionNumber === 2 && content(prepared) === content(published), 'the new Draft is not a copy of Version 1')
    await select(page, vectors)
    await openSkillView(page, 'edit')
    await setValue(page, '#skill-outcome-input', 'Add and scale vectors')
    await openSummaryBoard(page)
    await editBoardTask(page, drills, { title: 'Vector drills' })
    await closeSummaryBoard(page)
    await closeEditorPanels(page)
    await setValue(page, '#path-goal-input', 'Solve linear systems by elimination')
    await waitForSaved(page)
    // The Draft's new goal is its own: Version 1 still states the goal it was published with.
    const v1WhileDrafting = await api(page, `/coach/learning-path-versions/${v1.versionId}`)
    check(v1WhileDrafting.body.learningPath.goal === 'Solve linear systems', `Version 1 goal while drafting: ${v1WhileDrafting.body.learningPath.goal}`)
    await closeEditorPanels(page)
    await page.click('#publish-version-btn')
    const v2 = await publishedView(page)
    check(v2.versionNumber === 2 && v2.versionId !== v1.versionId, `Version 2 view: ${JSON.stringify(v2)}`)
    check(v2.skills.map((s) => s.id).join() === v1.skills.map((s) => s.id).join() && v2.skills[0].outcome === 'Add and scale vectors' && v2.skills[0].tasks[0] === `${drills}:Vector drills`, `Version 2 shows ${JSON.stringify(v2.skills)}`)
    check(await page.$('#version-link-1') !== null && await page.$('#version-link-2') !== null, 'the Version history does not list both Versions')
    check(await text(page, '#published-path-goal') === 'Goal: Solve linear systems by elimination', `Version 2 goal: ${await text(page, '#published-path-goal')}`)
    pass('new content Version', `Version 2 (${v2.versionId.slice(0, 8)}) corrects "vectros" and "drils" under the same Skill and Task IDs and states its own goal; Version 1's goal unchanged while drafting`)

    // 6. Version 1 still reads exactly as published, also after a reload.
    await page.click('#version-link-1')
    await page.waitForFunction((id: string) => (document.querySelector('#published-version') as HTMLElement | null)?.dataset.versionId === id, {}, v1.versionId)
    check(new URL(page.url()).pathname === `/coach/versions/${v1.versionId}`, `Version 1 URL: ${page.url()}`)
    await page.reload({ waitUntil: 'networkidle0' })
    const reread = await publishedView(page)
    check(JSON.stringify(reread) === JSON.stringify(v1), `Version 1 after Version 2: ${JSON.stringify(reread)}`)
    check(await text(page, '#published-path-goal') === 'Goal: Solve linear systems', `Version 1 goal after Version 2: ${await text(page, '#published-path-goal')}`)
    const v1Api = await api(page, `/coach/learning-path-versions/${v1.versionId}`)
    check(v1Api.status === 200 && content(v1Api.body) === content(published), 'Version 1 content changed')
    pass('immutable old content', `Version 1 still shows "vectros", "Vector drils" and its original goal after reload; IDs shared with Version 2`)

    // 7. Another Coach can neither publish, prepare nor read; the Coach's Versions are unchanged.
    const before = { path: await readPath(page, pathId), v1: v1Api.body }
    await signOut(page)
    await authenticate(page, 'sign-up', 'otto@gurow.test')
    await page.goto(`${ORIGIN}/coach/versions/${v1.versionId}`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('#version-unavailable')
    const visible = await page.$eval('body', (el) => el.innerText)
    check(!['Linear Algebra', 'Vectors', 'vectros'].some((t) => visible.includes(t)), 'the refused Version page shows content')
    const ottoCalls = [
      await api(page, `/coach/learning-paths/${pathId}/publication`, 'POST', { expectedRevision: before.path.learningPath.revision }),
      await api(page, `/coach/learning-paths/${pathId}/drafts`, 'POST', { expectedRevision: before.path.learningPath.revision }),
      await api(page, `/coach/learning-path-versions/${v1.versionId}`),
      await api(page, `/coach/learning-paths/${pathId}/draft`, 'PUT', typoFix),
    ]
    check(ottoCalls.every((r) => r.status === 404), `another Coach answered ${ottoCalls.map((r) => r.status)}`)
    await signOut(page)
    await authenticate(page, 'sign-in', 'carla@gurow.test')
    check(JSON.stringify(await readPath(page, pathId)) === JSON.stringify(before.path), 'another Coach changed the Path')
    check(JSON.stringify((await api(page, `/coach/learning-path-versions/${v1.versionId}`)).body) === JSON.stringify(before.v1), 'another Coach changed Version 1')
    pass('unauthorized writes', `Otto: "not available" page, API ${ottoCalls.map((r) => r.status).join('/')}; Carla's Path and Versions unchanged`)

    check(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
    check(dialogs.length === 0, `unexpected dialogs: ${dialogs}`)
    console.log(`\nT19 publication check passed (${steps.length} steps).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t19-failure.png')
    await current?.screenshot({ path: shot }).then(() => console.error(`screenshot: ${shot}`)).catch(() => {})
    if (consoleErrors.length > 0) console.error(`console errors:\n  ${consoleErrors.slice(-10).join('\n  ')}`)
    if (pageErrors.length > 0) console.error(`page errors:\n  ${pageErrors.join('\n  ')}`)
    throw error
  } finally {
    await browser.close()
    web.kill()
    apiServer.kill()
  }
}

main().catch((error) => {
  console.error(`\nT19 publication check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
