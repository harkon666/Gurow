#!/usr/bin/env bun
/**
 * T18 Coach Workspace and Draft check (#19): the production frontend build forwarding
 * /api to the production backend entry (Better Auth sessions) on a freshly migrated
 * PostgreSQL database, in headless Chromium with WebGPU. An Account with a private
 * personal Path switches to its Coach context, creates a Coach Workspace and two
 * Drafts on the same subject, sets Required/Enrichment Tasks, rewards, an Optional
 * Skill, thresholds and Prerequisites, sees forbidden edits refused at once, and
 * reloads. Another Coach finds none of it, and the coach pages never read personal data.
 *
 * Run from frontend: bun run scripts/t18-coach-draft-check.ts [--skip-build]
 */
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Page } from 'puppeteer-core'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3495)
const API_PORT = Number(process.env.API_PORT ?? 3496)
const ORIGIN = `http://127.0.0.1:${PORT}`
const DATABASE_URL = process.env.T18_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t18_browser_test'
const PASSWORD = 'correct horse battery staple'

interface Task { id: string; title: string; description: string; required: boolean; xpReward: number }
interface Skill { id: string; title: string; outcome: string; optional: boolean; xpThreshold: number; tasks: Task[] }
interface Doc {
  learningPath: { id: string; coachWorkspaceId: string; title: string; goal: string; revision: number }
  draft: { id: string; versionNumber: number } | null
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
async function readDraft(page: Page, pathId: string): Promise<Doc> {
  const result = await api(page, `/coach/learning-paths/${pathId}`)
  check(result.status === 200, `reading Draft ${pathId} answered ${result.status}`)
  return result.body
}
const edges = (connections: { from_id: string; to_id: string }[]) => connections.map((c) => `${c.from_id}>${c.to_id}`).sort()
const rules = (doc: Doc) => doc.application.skills.map((s) => [s.title, s.outcome, s.optional, s.xpThreshold, s.tasks.map((t) => [t.title, t.required, t.xpReward])])

const text = (page: Page, selector: string) => page.$eval(selector, (el) => el.textContent?.trim() ?? '')
const fieldValue = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLInputElement).value)
const checked = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLInputElement).checked)
const saveState = (page: Page) => page.$eval('#save-status', (el) => ({ state: (el as HTMLElement).dataset.state!, revision: Number((el as HTMLElement).dataset.revision) }))
async function waitForSaved(page: Page) {
  // Let a pending autosave start, then wait for the backend to accept it.
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
  await setValue(page, '#new-skill-title', title)
  await setValue(page, '#new-skill-outcome', outcome)
  await page.click('#add-skill-btn')
  await page.waitForFunction((n: number) => document.querySelectorAll('[id^="card-label-"]').length === n, {}, before.length + 1)
  const id = (await labelIds(page)).find((x) => !before.includes(x))!
  await page.waitForFunction((want: string) => document.querySelector('#selected-skill-id')?.textContent?.trim() === want, {}, id)
  return id
}
async function select(page: Page, id: string) {
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
/** Adds a Task to the selected Skill with its Draft rules. */
async function addTask(page: Page, title: string, required: boolean, xpReward: number) {
  const before = await page.$$eval('[id^="task-edit-title-"]', (els) => els.map((el) => el.id))
  await page.click('#add-task-btn')
  await page.waitForFunction((n: number) => document.querySelectorAll('[id^="task-edit-title-"]').length === n, {}, before.length + 1)
  const id = (await page.$$eval('[id^="task-edit-title-"]', (els) => els.map((el) => el.id))).find((x) => !before.includes(x))!.replace('task-edit-title-', '')
  await setValue(page, `#task-edit-title-${id}`, title)
  check(await checked(page, `#task-edit-required-${id}`), 'a new Draft Task does not start as Required')
  if (!required) await page.click(`#task-edit-required-${id}`)
  await setValue(page, `#task-xp-reward-${id}`, String(xpReward))
  return id
}
async function connect(page: Page, from: string, to: string) {
  await select(page, from)
  await page.select('#connect-skill-select', to)
  await page.click('#btn-add-dependent')
}
const graph = async (page: Page) => edges(JSON.parse(await page.$eval('#skill-detail-panel', (el) => (el as HTMLElement).dataset.connections ?? '[]')))

async function main() {
  if (!process.argv.includes('--skip-build')) {
    console.log('Building current sources (Wasm + production bundle)...')
    execFileSync('bun', ['run', 'build'], { cwd: FRONTEND, stdio: 'inherit' })
  }
  execFileSync('bun', ['run', 'test/support/prepare-browser-database.ts'], { cwd: BACKEND, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: DATABASE_URL } })

  const apiServer = spawn('bun', ['run', 'src/index.ts'], {
    cwd: BACKEND,
    env: { ...process.env, DATABASE_URL, PORT: String(API_PORT), BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: 't18-browser-check-secret-not-for-production', NODE_ENV: 'test' },
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
    // Every API request the coach pages make; none may read personal data.
    const coachRequests: string[] = []
    let recording = false
    page.on('request', (request) => { if (recording && request.url().includes('/api/')) coachRequests.push(`${request.method()} ${new URL(request.url()).pathname}`) })
    current = page
    await page.setViewport({ width: 1800, height: 900, deviceScaleFactor: 1 })

    // 1. One Account, two contexts: a private personal Path, then the owning-Coach context.
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
    await authenticate(page, 'sign-up', 'carla@gurow.test')
    await setValue(page, '#new-path-title', 'Private Diary')
    await setValue(page, '#new-path-goal', 'A secret personal goal')
    await page.click('#create-path-btn')
    await page.waitForSelector('#path-editor')
    check(await page.$eval('#active-context', (el) => (el as HTMLElement).dataset.context) === 'personal', 'the personal Path is not in the personal context')
    recording = true
    await page.click('#switch-to-coach')
    await page.waitForSelector('#coach-home')
    check(await page.$eval('#active-context', (el) => (el as HTMLElement).dataset.context) === 'coach' && await text(page, '#active-context') === 'Coaching', `context after switching: ${await text(page, '#active-context')}`)
    check(await page.$('#coach-workspaces-empty') !== null, 'a new Account already lists a Coach Workspace')
    await setValue(page, '#new-coach-workspace-name', 'Linear Algebra Studio')
    await page.click('#create-coach-workspace-btn')
    await page.waitForSelector('#coach-workspace')
    const workspaceId = await page.$eval('main', (el) => (el as HTMLElement).dataset.coachWorkspaceId!)
    check(await text(page, '#active-context') === 'Coaching · Linear Algebra Studio', `workspace context: ${await text(page, '#active-context')}`)
    pass('contexts', `personal Path "Private Diary" in the personal context; Coaching switch shows no Workspace, then "Linear Algebra Studio" (${workspaceId.slice(0, 8)})`)

    // 2. A Draft with Required and Enrichment Tasks, rewards, an Optional Skill, thresholds and Prerequisites.
    await setValue(page, '#new-coach-path-title', 'Linear Algebra')
    await setValue(page, '#new-coach-path-goal', 'Solve linear systems')
    await page.click('#create-coach-path-btn')
    const pathA = await openEditor(page, 0)
    check(new URL(page.url()).pathname === `/coach/paths/${pathA}` && await page.$('#draft-badge') !== null && await page.$('#path-xp') === null, 'the Draft did not open in the coach editor')
    const vectors = await addSkill(page, 'Vectors', 'Add and scale vectors')
    await addTask(page, 'Vector exercises', true, 20)
    await addTask(page, 'Read chapter 1', false, 5)
    const matrices = await addSkill(page, 'Matrices', 'Multiply matrices')
    await setValue(page, '#skill-threshold-input', '20')
    await addTask(page, 'Matrix exercises', true, 30)
    const history = await addSkill(page, 'History of algebra', 'Place results in history')
    await page.click('#skill-optional-input')
    await addTask(page, 'Essay', false, 10)
    const eigen = await addSkill(page, 'Eigenvalues', 'Find eigenvalues')
    await setValue(page, '#skill-threshold-input', '50')
    await connect(page, vectors, matrices)
    await connect(page, matrices, eigen)
    await connect(page, vectors, history)
    await waitForSaved(page)
    let doc = await readDraft(page, pathA)
    const expectedRules = [
      ['Vectors', 'Add and scale vectors', false, 0, [['Vector exercises', true, 20], ['Read chapter 1', false, 5]]],
      ['Matrices', 'Multiply matrices', false, 20, [['Matrix exercises', true, 30]]],
      ['History of algebra', 'Place results in history', true, 0, [['Essay', false, 10]]],
      ['Eigenvalues', 'Find eigenvalues', false, 50, []],
    ]
    check(JSON.stringify(rules(doc)) === JSON.stringify(expectedRules), `stored Draft rules: ${JSON.stringify(rules(doc))}`)
    check(JSON.stringify(edges(doc.editor.connections)) === JSON.stringify(edges([{ from_id: vectors, to_id: matrices }, { from_id: matrices, to_id: eigen }, { from_id: vectors, to_id: history }])), 'stored Prerequisites differ')
    check(doc.draft?.versionNumber === 1 && !JSON.stringify(doc.editor).includes('Vector exercises'), 'Draft version or snapshot/payload split is wrong')
    check(await text(page, `#skill-draft-status-${history}`) === 'Optional' && (await text(page, `#skill-draft-status-${eigen}`)).includes('50 XP'), 'the list does not show the Draft designations')
    pass('draft rules', `rev ${doc.learningPath.revision}: Required/Enrichment Tasks with rewards 20/5/30/10, Optional "History of algebra", thresholds 20 and 50, an Eigenvalues Skill with no Task yet, 3 Prerequisites`)

    // 3. Forbidden edits are refused at once in the editor and change nothing.
    const revision = doc.learningPath.revision
    const graphBefore = await graph(page)
    await connect(page, history, matrices)
    await page.waitForSelector('#cycle-rejection-alert')
    const optionalRefusal = await text(page, '#cycle-rejection-alert')
    check(optionalRefusal.includes('Optional Skill “History of algebra” cannot be a Prerequisite of required Skill “Matrices”'), `optional refusal: ${optionalRefusal}`)
    check(JSON.stringify(await graph(page)) === JSON.stringify(graphBefore), 'the forbidden connection reached the graph')
    await select(page, vectors)
    await page.click('#skill-optional-input')
    await page.waitForFunction(() => document.querySelector('#cycle-rejection-alert')?.textContent?.includes('“Vectors” cannot be a Prerequisite of required Skill “Matrices”'))
    check(!(await checked(page, '#skill-optional-input')), 'Vectors became Optional although it leads to a required Skill')
    await connect(page, eigen, vectors)
    await page.waitForFunction(() => /cycle/i.test(document.querySelector('#cycle-rejection-alert')?.textContent ?? ''))
    await new Promise((r) => setTimeout(r, 900))
    doc = await readDraft(page, pathA)
    check(doc.learningPath.revision === revision && JSON.stringify(edges(doc.editor.connections)) === JSON.stringify(graphBefore) && JSON.stringify(rules(doc)) === JSON.stringify(expectedRules), 'a refused edit reached the backend')
    check((await saveState(page)).state === 'saved', `a refused edit left the document unsaved: ${JSON.stringify(await saveState(page))}`)
    pass('immediate refusals', `"${optionalRefusal.slice(0, 80)}…"; making Vectors Optional refused; a cycle refused by the engine; Draft rev ${revision} unchanged`)

    // 4. The backend refuses the same edits sent directly, and connections to another Path.
    const base = { expectedRevision: doc.learningPath.revision, title: doc.learningPath.title, goal: doc.learningPath.goal, editor: doc.editor, application: doc.application }
    const withEdge = (from: string, to: string) => ({ ...base, editor: { ...base.editor, connections: [...base.editor.connections, { from_id: from, to_id: to }] } })
    await page.click('#back-to-coach-workspace')
    await page.waitForSelector('#coach-workspace')
    await setValue(page, '#new-coach-path-title', 'Linear Algebra for Engineers')
    await page.click('#create-coach-path-btn')
    const pathB = await openEditor(page, 0)
    const engVectors = await addSkill(page, 'Vectors', 'Resolve forces into components')
    await addTask(page, 'Model forces with vectors', true, 30)
    await waitForSaved(page)
    const refused = {
      optional: await api(page, `/coach/learning-paths/${pathA}/draft`, 'PUT', withEdge(history, matrices)),
      cycle: await api(page, `/coach/learning-paths/${pathA}/draft`, 'PUT', withEdge(eigen, vectors)),
      outside: await api(page, `/coach/learning-paths/${pathA}/draft`, 'PUT', withEdge(vectors, engVectors)),
    }
    check(refused.optional.status === 422 && refused.optional.body.error === 'optional_prerequisite', `optional → required: ${JSON.stringify(refused.optional)}`)
    check(refused.cycle.status === 422 && refused.cycle.body.error === 'prerequisite_cycle', `cycle: ${JSON.stringify(refused.cycle)}`)
    check(refused.outside.status === 422 && refused.outside.body.error === 'connection_outside_path', `cross-Path: ${JSON.stringify(refused.outside)}`)
    check(JSON.stringify(await readDraft(page, pathA)) === JSON.stringify(doc), 'a refused API edit changed the Draft')
    pass('backend validation', `optional → required ${refused.optional.status} ${refused.optional.body.error}; cycle ${refused.cycle.body.error}; connection to the other Path ${refused.outside.body.error}; Draft unchanged`)

    // 5. Two Paths on the same subject keep their own outcomes and Tasks.
    const docB = await readDraft(page, pathB)
    check(JSON.stringify(rules(docB)) === JSON.stringify([['Vectors', 'Resolve forces into components', false, 0, [['Model forces with vectors', true, 30]]]]) && engVectors !== vectors, `second Path: ${JSON.stringify(rules(docB))}`)
    await page.click('#back-to-coach-workspace')
    await page.waitForSelector('#coach-workspace')
    const listed = await page.$$eval('#coach-paths [data-learning-path-id]', (els) => els.map((el) => (el as HTMLElement).dataset.learningPathId))
    check(JSON.stringify(listed) === JSON.stringify([pathA, pathB]), `the Workspace lists ${listed}`)
    pass('independent Paths', `"Linear Algebra" and "Linear Algebra for Engineers" each hold their own "Vectors" (${vectors.slice(0, 8)} vs ${engVectors.slice(0, 8)}) with different outcomes and Tasks`)

    // 6. Reload restores the Draft and its rules into the editor.
    await page.click(`[data-learning-path-id="${pathA}"] a`)
    await openEditor(page, 4)
    await page.reload({ waitUntil: 'networkidle0' })
    await openEditor(page, 4)
    await select(page, history)
    check(await checked(page, '#skill-optional-input'), 'History of algebra is no longer Optional after reload')
    await select(page, matrices)
    check(await fieldValue(page, '#skill-threshold-input') === '20', 'Matrices lost its threshold')
    await select(page, vectors)
    const vectorTasks = doc.application.skills[0].tasks
    check(await checked(page, `#task-edit-required-${vectorTasks[0].id}`) && !(await checked(page, `#task-edit-required-${vectorTasks[1].id}`)), 'Required/Enrichment did not reopen')
    check(await fieldValue(page, `#task-xp-reward-${vectorTasks[0].id}`) === '20' && await fieldValue(page, `#task-xp-reward-${vectorTasks[1].id}`) === '5', 'rewards did not reopen')
    check(JSON.stringify(await graph(page)) === JSON.stringify(graphBefore), 'Prerequisites did not reopen')
    const personalCalls = coachRequests.filter((request) => request.includes('/personal/'))
    check(personalCalls.length === 0, `coach pages read personal data: ${personalCalls}`)
    check(!(await page.$eval('body', (el) => el.innerText)).includes('Private Diary'), 'a coach page shows the personal Path')
    pass('reload', `Optional, thresholds, Required/Enrichment, rewards and Prerequisites reopen; ${coachRequests.length} API requests from coach pages, none to /personal`)

    // 7. Back in the personal context, the Coach's Drafts are not personal Paths.
    recording = false
    await page.click('#switch-to-personal')
    await page.waitForSelector('#personal-workspace')
    const personalList = await text(page, '#workspace-paths')
    check(personalList.includes('Private Diary') && !personalList.includes('Linear Algebra'), `personal Workspace lists: ${personalList}`)
    pass('context switch back', 'the Personal Workspace lists only "Private Diary"')

    // 8. Another Coach finds none of it and keeps its own Workspace apart.
    await signOut(page)
    await authenticate(page, 'sign-up', 'otto@gurow.test')
    await page.click('#switch-to-coach')
    await page.waitForSelector('#coach-workspaces-empty')
    await page.goto(`${ORIGIN}/coach/workspaces/${workspaceId}`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('#coach-workspace-unavailable')
    await page.goto(`${ORIGIN}/coach/paths/${pathA}`, { waitUntil: 'networkidle0' })
    await page.waitForSelector('#path-unavailable')
    const visible = await page.$eval('body', (el) => el.innerText)
    check(!['Linear Algebra', 'Vectors', 'carla@gurow.test'].some((t) => visible.includes(t)), 'the refused page shows the other Coach\'s content')
    const ottoCalls = [
      await api(page, `/coach/workspaces/${workspaceId}`), await api(page, `/coach/learning-paths/${pathA}`),
      await api(page, `/coach/learning-paths/${pathA}/draft`, 'PUT', { ...base, goal: 'Otto was here' }),
      await api(page, `/coach/workspaces/${workspaceId}/learning-paths`, 'POST', { title: 'Intruder' }),
    ]
    check(ottoCalls.every((r) => r.status === 404), `another Coach answered ${ottoCalls.map((r) => r.status)}`)
    await page.goto(`${ORIGIN}/coach`, { waitUntil: 'networkidle0' })
    await setValue(page, '#new-coach-workspace-name', 'Otto Studio')
    await page.click('#create-coach-workspace-btn')
    await page.waitForSelector('#coach-workspace')
    await signOut(page)
    await authenticate(page, 'sign-in', 'carla@gurow.test')
    check(JSON.stringify(await readDraft(page, pathA)) === JSON.stringify(doc), 'another Coach changed the Draft')
    const carlaWorkspaces = (await api(page, '/coach/workspaces')).body.workspaces.map((w: any) => w.name)
    check(JSON.stringify(carlaWorkspaces) === JSON.stringify(['Linear Algebra Studio']), `Carla's Workspaces: ${carlaWorkspaces}`)
    pass('another Coach', `Otto sees no Workspace, "not available" for Carla's Workspace and Draft, API ${ottoCalls.map((r) => r.status).join('/')}; Otto's own Workspace is not Carla's; Carla's Draft unchanged`)

    check(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
    check(dialogs.length === 0, `unexpected dialogs: ${dialogs}`)
    console.log(`\nT18 Coach Draft check passed (${steps.length} steps).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t18-failure.png')
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
  console.error(`\nT18 Coach Draft check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
