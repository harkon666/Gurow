#!/usr/bin/env bun
/**
 * UX03 (#49, parent #46): a personal Skill's Task Board on the current build, against
 * real Better Auth, the backend and an isolated migrated PostgreSQL. Requires harness
 * checks build and db-up; isolated ports 3595/3596 and database gurow_ux03_browser_test
 * make it eligible for parallel execution. Every learning outcome is read back from the
 * backend independently of what the board shows.
 *
 * Run from frontend: bun run scripts/ux03-task-board-check.ts [--skip-build]
 *
 * AC1  Open board from the Skill summary, return with the same camera; per-Skill/Path Tasks; initial columns.
 * AC2  Add (required title), edit, reorder, move by pointer drag and by the keyboard Move menu; reward reachable.
 * AC3  Completion Column entry/exit completes/uncompletes with award/corrections; the retained action moves the card.
 * AC4  Add, rename, reorder, remove columns with a destination; role, not name; last usable column kept.
 * AC5  Completion Column replacement explained before confirmation and reconciled in one change.
 * AC6  Eligible deletion with undo; history Tasks archived, kept outside the board.
 * AC7  Existing Tasks placed once (completed in Done, others in Backlog, order kept, archived out).
 * AC8  Reload restores the arrangement; another Skill and Path are unchanged.
 * AC9  Failed and lost-answer writes, a refused locked completion, and competing tabs keep local intent truthfully.
 * AC10 Narrow viewport column selector, full-screen details, keyboard-only management without WebGPU.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import puppeteer, { type Browser, type HTTPRequest, type Page } from 'puppeteer-core'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'
import { selectSkillFromList } from './editor-navigation'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = 3595
const API_PORT = 3596
const ORIGIN = `http://127.0.0.1:${PORT}`
const DATABASE_URL = 'postgres://gurow:gurow@127.0.0.1:5433/gurow_ux03_browser_test'
const PASSWORD = 'correct horse battery staple'
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
function pass(message: string) { console.log(`  ✓ ${message}`) }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

interface Column { id: string; name: string; completion: boolean; taskIds: string[] }

async function setValue(page: Page, selector: string, next: string) {
  await page.$eval(selector, (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, next)
}
async function activate(page: Page, selector: string) {
  await page.waitForSelector(selector, { visible: true })
  await page.focus(selector)
  await page.keyboard.press('Enter')
}
const visible = (page: Page, selector: string) => page.$eval(selector, (el) => el.getClientRects().length > 0).catch(() => false)
const focusedId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? '')
async function api(page: Page, route: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(async (r, m, b) => {
    const response = await fetch(`/api${r}`, { method: m, headers: b === null ? undefined : { 'content-type': 'application/json' }, body: b })
    return { status: response.status, body: await response.json().catch(() => null) }
  }, route, method, body === undefined ? null : JSON.stringify(body))
}
async function ok(page: Page, route: string, method = 'GET', body?: unknown) {
  const result = await api(page, route, method, body)
  check([200, 201].includes(result.status), `${method} ${route}: ${result.status} ${JSON.stringify(result.body)}`)
  return result.body
}
async function portFree(port: number) {
  await new Promise<void>((resolve, reject) => {
    const server = createServer()
    server.once('error', (error) => reject(new Error(`UX03 requires unused port ${port}: ${error.message}`)))
    server.listen(port, '127.0.0.1', () => server.close((error) => error ? reject(error) : resolve()))
  })
}
async function newPage(browser: Browser, errors: string[], { noGpu = false, context = undefined as Awaited<ReturnType<Browser['createBrowserContext']>> | undefined, width = 1440, height = 1000 } = {}) {
  const page = await (context ?? await browser.createBrowserContext()).newPage()
  page.setDefaultTimeout(15000)
  await page.setViewport({ width, height, deviceScaleFactor: 1 })
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('dialog', (dialog) => { errors.push(`unexpected ${dialog.type()} dialog`); void dialog.dismiss() })
  await page.evaluateOnNewDocument((unsupported) => {
    if (unsupported) Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true })
  }, noGpu)
  return page
}
async function open(page: Page, route: string, gpu = 'ready') {
  await page.bringToFront()
  await page.goto(`${ORIGIN}${route}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector(`#path-editor[data-gpu-status="${gpu}"]`, { timeout: 20000 })
}
const camera = (page: Page) => page.$eval('#labels-camera', (el) => getComputedStyle(el).transform)
const labelBox = (page: Page, id: string) => page.$eval(`#card-label-${id}`, (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width)] })

/** The board as shown: columns in order with their cards. */
const shownBoard = (page: Page): Promise<Column[]> => page.$$eval('#board-columns > section', (els) => els.map((el) => ({
  id: (el as HTMLElement).dataset.dropColumn!, name: (el as HTMLElement).dataset.name!, completion: (el as HTMLElement).dataset.completion === 'true',
  taskIds: [...el.querySelectorAll<HTMLElement>('[data-card-id]')].map((card) => card.dataset.cardId!),
})))
const arrangement = (columns: Column[]) => columns.map((c) => `${c.name}${c.completion ? '*' : ''}:${c.taskIds.join(',')}`)

async function openBoard(page: Page, skillId: string) {
  await selectSkillFromList(page, skillId)
  await activate(page, '#open-board-btn')
  await page.waitForSelector('#task-board[open] #board-columns > section')
  await page.waitForSelector('#board-save-status[data-state="saved"]')
}
async function closeBoard(page: Page) {
  await activate(page, '#board-close-btn')
  await page.waitForSelector('#task-board', { hidden: true })
}

export async function main() {
  await portFree(PORT)
  await portFree(API_PORT)
  if (!process.argv.includes('--skip-build')) execFileSync('bun', ['run', 'build'], { cwd: FRONTEND, stdio: 'inherit' })
  execFileSync('bun', ['run', 'test/support/prepare-browser-database.ts'], { cwd: BACKEND, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: DATABASE_URL } })
  const backend = spawn('bun', ['run', 'src/index.ts'], { cwd: BACKEND, env: { ...process.env, DATABASE_URL, PORT: String(API_PORT), BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: 'ux03-browser-check-secret-not-for-production', NODE_ENV: 'test', RESEND_API_KEY: '' }, stdio: ['ignore', 'ignore', 'inherit'] })
  const web = spawn('node', ['.output/server/index.mjs'], { cwd: FRONTEND, env: { ...process.env, PORT: String(PORT), GUROW_API_ORIGIN: `http://127.0.0.1:${API_PORT}` }, stdio: 'ignore' })
  let browser: Browser | undefined
  let current: Page | undefined
  const errors: string[] = []
  try {
    await waitForServerReady(ORIGIN)
    for (let i = 0; i < 50; i++) {
      if ((await fetch(`${ORIGIN}/api/account`).catch(() => null))?.status === 401) break
      check(i < 49, 'backend never became ready')
      await pause(200)
    }
    browser = await puppeteer.launch({ executablePath: resolveChromiumExecutable(), headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu', '--use-gl=angle', '--disable-dev-shm-usage'] })
    const ownerContext = await browser.createBrowserContext()
    const owner = await newPage(browser, errors, { context: ownerContext })
    current = owner
    await owner.goto(ORIGIN, { waitUntil: 'networkidle0' })
    await owner.waitForSelector('#sign-in-form')
    await setValue(owner, '#email-input', 'owner@ux03.test')
    await setValue(owner, '#password-input', PASSWORD)
    await activate(owner, '#sign-up-btn')
    await owner.waitForSelector('#personal-workspace')

    // ---- Existing work from before boards existed: two Paths, Tasks completed, one archived.
    const uuid = () => crypto.randomUUID()
    const [A, B] = [uuid(), uuid()]
    const [read, borrow, notes, archivedTask, annotate] = [uuid(), uuid(), uuid(), uuid(), uuid()]
    const created = await ok(owner, '/personal/learning-paths', 'POST', { title: 'Board Rust', goal: 'Organise work per Skill' })
    const pathId = created.learningPath.id as string
    const route = `/personal/learning-paths/${pathId}`
    await ok(owner, `${route}/document`, 'PUT', {
      expectedRevision: 0, title: 'Board Rust', goal: 'Organise work per Skill',
      editor: { format_version: 1, cards: [{ id: A, title: 'Ownership', position: { x: 120, y: 140 } }, { id: B, title: 'Lifetimes', position: { x: 460, y: 140 } }], connections: [{ from_id: A, to_id: B }] },
      application: { skills: [
        { id: A, title: 'Ownership', outcome: 'Explain moves', tasks: [
          { id: read, title: 'Read the chapter', description: '' }, { id: borrow, title: 'Borrow exercises', description: 'Ten small programs' },
          { id: notes, title: 'Write notes', description: '' }, { id: archivedTask, title: 'Old draft', description: '' },
        ] },
        { id: B, title: 'Lifetimes', outcome: 'Annotate signatures', tasks: [{ id: annotate, title: 'Annotate a parser', description: '' }] },
      ] },
    })
    await ok(owner, `${route}/tasks/${read}/reward`, 'PUT', { xpReward: 10 })
    await ok(owner, `${route}/tasks/${read}/completion`, 'PUT')
    await ok(owner, `${route}/tasks/${archivedTask}/completion`, 'PUT')
    const archivedRevision = (await ok(owner, route)).learningPath.revision
    await ok(owner, `${route}/tasks/${archivedTask}/archive`, 'POST', { expectedRevision: archivedRevision })
    await ok(owner, `${route}/tasks/${borrow}/reward`, 'PUT', { xpReward: 20 })
    await ok(owner, `${route}/tasks/${notes}/reward`, 'PUT', { xpReward: 5 })
    const otherPath = await ok(owner, '/personal/learning-paths', 'POST', { title: 'Guitar', goal: '' })
    const [G, chords] = [uuid(), uuid()]
    await ok(owner, `/personal/learning-paths/${otherPath.learningPath.id}/document`, 'PUT', {
      expectedRevision: 0, title: 'Guitar', goal: '',
      editor: { format_version: 1, cards: [{ id: G, title: 'Chords', position: { x: 100, y: 100 } }], connections: [] },
      application: { skills: [{ id: G, title: 'Chords', outcome: 'Change chords', tasks: [{ id: chords, title: 'Practise changes', description: '' }] }] },
    })
    const stored = async (page = owner) => (await ok(page, `${route}/learning-state`)).learningState
    const storedTask = (state: any, id: string) => state.tasks.find((t: any) => t.taskId === id)
    const storedBoard = async (skillId: string, page = owner): Promise<Column[]> => (await ok(page, `${route}/skills/${skillId}/board`)).board.columns
    const before = await stored()
    check(before.xp === 10, `seeded Path XP is ${before.xp}`)

    /** Waits until the board says saved and the backend holds exactly what it shows. */
    async function synced(page: Page, skillId: string) {
      for (let i = 0; i < 100; i++) {
        const state = await page.$eval('#board-save-status', (el) => (el as HTMLElement).dataset.state).catch(() => null)
        if (state === 'saved') {
          const shown = await shownBoard(page)
          if (same(arrangement(shown), arrangement(await storedBoard(skillId, page)))) return shown
        }
        await pause(100)
      }
      throw new Error(`board never saved: shown ${JSON.stringify(arrangement(await shownBoard(page)))}, stored ${JSON.stringify(arrangement(await storedBoard(skillId, page)))}`)
    }
    const columnId = async (page: Page, name: string) => (await shownBoard(page)).find((c) => c.name === name)!.id
    /** Drags a card with real pointer input to a column, before the card at `beforeTask` or at its end. */
    async function dragCard(page: Page, taskId: string, toColumn: string, beforeTask?: string) {
      const card = await page.$eval(`#board-card-title-${taskId}`, (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
      const target = await page.evaluate((column, before) => {
        const ref = before ? document.getElementById(`board-card-${before}`) : null
        if (ref) { const r = ref.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 4 } }
        const list = document.querySelector(`#board-column-${column} ol`)!.getBoundingClientRect()
        return { x: list.x + list.width / 2, y: list.bottom - 12 }
      }, toColumn, beforeTask ?? null)
      await page.mouse.move(card.x, card.y)
      await page.mouse.down()
      await page.mouse.move(card.x + 12, card.y + 8, { steps: 3 })
      await page.mouse.move(target.x, target.y, { steps: 12 })
      check(await page.$eval('#board-columns', (el) => (el as HTMLElement).dataset.dragging === 'true'), 'the card did not start dragging')
      const onTop = await page.evaluate((id, point) => document.elementFromPoint(point.x, point.y)?.closest('[data-card-id]')?.getAttribute('data-card-id') === id, taskId, target)
      check(onTop, 'the dragged card is clipped or painted behind the destination column')
      await page.mouse.up()
    }
    async function moveWithMenu(page: Page, taskId: string, columnName: string) {
      if (!await page.$(`#card-move-menu-${taskId}`)) await activate(page, `#card-move-${taskId}`)
      await page.waitForSelector(`#card-move-column-${taskId}`, { visible: true })
      await page.select(`#card-move-column-${taskId}`, await columnId(page, columnName))
      await activate(page, `#card-move-apply-${taskId}`)
    }

    // ---- AC1/AC7: open from the summary at a changed camera; initial placement; return keeps the camera.
    await open(owner, `/paths/${pathId}`)
    const canvas = await owner.$eval('#editor-canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
    await owner.mouse.move(canvas.x + 200, canvas.y + 200)
    await owner.keyboard.down('Control')
    await owner.mouse.wheel({ deltaY: -30 })
    await owner.keyboard.up('Control')
    await owner.mouse.wheel({ deltaX: 60, deltaY: -40 })
    await owner.waitForFunction(() => getComputedStyle(document.querySelector('#labels-camera')!).transform !== 'matrix(1, 0, 0, 1, 0, 0)')
    await pause(300)
    const cameraBefore = await camera(owner)
    const labelBefore = await labelBox(owner, A)
    await openBoard(owner, A)
    let board = await shownBoard(owner)
    check(same(board.map((c) => [c.name, c.completion]), [['Backlog', false], ['To Do', false], ['In Progress', false], ['Done', true]]), `initial columns ${JSON.stringify(board)}`)
    check(same(arrangement(board), ['Backlog:' + [borrow, notes].join(','), 'To Do:', 'In Progress:', `Done*:${read}`]), `initial placement ${JSON.stringify(arrangement(board))}`)
    check(!await owner.$(`#board-card-${archivedTask}`), 'an archived Task is on the board')
    check(same(await stored(), before), 'opening the board changed learning records')
    check(await owner.$eval(`#board-card-${read}`, (el) => (el as HTMLElement).dataset.completed) === 'true', 'the completed Task card is not shown as complete')
    await closeBoard(owner)
    check(await focusedId(owner) === 'open-board-btn', `focus after closing the board is on ${await focusedId(owner)}`)
    check(await camera(owner) === cameraBefore && same(await labelBox(owner, A), labelBefore), 'returning from the board changed the camera')
    await openBoard(owner, B)
    check(same(arrangement(await shownBoard(owner)), [`Backlog:${annotate}`, 'To Do:', 'In Progress:', 'Done*:']), 'Lifetimes board does not hold only its own Task')
    await closeBoard(owner)
    const bBoard = await storedBoard(B)
    pass('AC1/AC7 Open board from the summary; Backlog/To Do/In Progress/Done with one Completion Column; completed Task in Done, others in Backlog in order, archived Task absent, no XP change; camera and focus restored; Lifetimes shows its own Task')

    // ---- AC2: add with a required title, edit, reorder, move by drag and by the keyboard menu.
    await openBoard(owner, A)
    const todo = await columnId(owner, 'To Do')
    await activate(owner, `#add-card-${todo}`)
    await owner.waitForSelector('#new-card-title', { visible: true })
    await activate(owner, '#new-card-submit')
    await owner.waitForSelector('#new-card-error', { visible: true })
    check(await focusedId(owner) === 'new-card-title', 'focus did not return to the empty title')
    await owner.type('#new-card-title', 'Smart pointers')
    await owner.type('#new-card-description', 'Box, Rc and RefCell')
    await activate(owner, '#new-card-submit')
    await owner.waitForFunction((column) => document.querySelectorAll(`#board-column-${column} [data-card-id]`).length === 1, {}, todo)
    const smart = await owner.$eval(`#board-column-${todo} [data-card-id]`, (el) => (el as HTMLElement).dataset.cardId!)
    board = await synced(owner, A)
    check(board.find((c) => c.name === 'To Do')!.taskIds[0] === smart, 'the new Task was not saved in To Do')
    const doc = await ok(owner, route)
    check(same(doc.application.skills[0].tasks.find((t: any) => t.id === smart), { id: smart, title: 'Smart pointers', description: 'Box, Rc and RefCell' }), 'the new Task title/description were not saved')
    check(await focusedId(owner) === `add-card-${todo}`, 'focus did not return to Add Task')
    // Edit through the details; a blank title is refused with feedback.
    await activate(owner, `#card-details-${borrow}`)
    await owner.waitForSelector('#card-edit-title', { visible: true })
    await setValue(owner, '#card-edit-title', '  ')
    await activate(owner, '#card-edit-save')
    await owner.waitForSelector('#card-edit-error', { visible: true })
    await setValue(owner, '#card-edit-title', 'Borrow drills')
    await setValue(owner, '#card-edit-description', 'Twelve small programs')
    await activate(owner, '#card-edit-save')
    check(await owner.$(`#board-task-reward-${borrow}`) !== null, 'the reward setting is not reachable from the Task details')
    await activate(owner, '#btn-close-card-details')
    await owner.waitForSelector(`#board-card-title-${borrow}`)
    await owner.waitForFunction((id) => document.getElementById(`board-card-title-${id}`)?.textContent === 'Borrow drills', {}, borrow)
    await owner.waitForSelector('#save-status[data-state="saved"]')
    check((await ok(owner, route)).application.skills[0].tasks.find((t: any) => t.id === borrow).title === 'Borrow drills', 'the edited title was not saved')
    // Reorder within Backlog with the keyboard, then move across columns by dragging.
    await activate(owner, `#card-move-${borrow}`)
    await activate(owner, `#card-move-down-${borrow}`)
    // Now last in its column, Move down is unavailable: focus stays on the card's Move control.
    check(await focusedId(owner) === `card-move-${borrow}`, `focus after moving to the end is on ${await focusedId(owner)}`)
    board = await synced(owner, A)
    check(same(board.find((c) => c.name === 'Backlog')!.taskIds, [notes, borrow]), `reorder within Backlog: ${JSON.stringify(arrangement(board))}`)
    await activate(owner, `#card-move-${borrow}`)
    await dragCard(owner, notes, await columnId(owner, 'In Progress'))
    board = await synced(owner, A)
    check(board.find((c) => c.name === 'In Progress')!.taskIds[0] === notes, `drag to In Progress: ${JSON.stringify(arrangement(board))}`)
    await dragCard(owner, smart, await columnId(owner, 'In Progress'), notes)
    board = await synced(owner, A)
    check(same(board.find((c) => c.name === 'In Progress')!.taskIds, [smart, notes]), `drag before a card: ${JSON.stringify(arrangement(board))}`)
    check((await stored()).tasks.every((t: any) => t.taskId === annotate ? t.skillId === B : true) && storedTask(await stored(), notes).skillId === A, 'a column move changed Task ownership')
    pass('AC2 required title with feedback and focus; optional description; edit with blank-title refusal; reward reachable; keyboard reorder keeps focus; pointer drags across and within columns persist; ownership unchanged')

    // ---- AC3: the Completion Column completes and uncompletes under the XP rules; repeats never multiply.
    const done = await columnId(owner, 'Done')
    await dragCard(owner, borrow, done)
    await synced(owner, A)
    let state = await stored()
    check(storedTask(state, borrow).completed && state.xp === 30, `entering Done: completed=${storedTask(state, borrow).completed} xp=${state.xp}`)
    await owner.waitForSelector(`#board-card-${borrow}[data-completed="true"]`)
    await moveWithMenu(owner, borrow, 'Backlog')
    await synced(owner, A)
    await moveWithMenu(owner, borrow, 'Done')
    await synced(owner, A)
    state = await stored()
    const borrowEvents = state.xpHistory.filter((e: any) => e.taskId === borrow).map((e: any) => [e.kind, e.cause, e.amount])
    check(same(borrowEvents, [['award', 'completion', 20], ['correction', 'completion_undone', -20], ['correction', 'completion', 20]]), `XP events ${JSON.stringify(borrowEvents)}`)
    check(state.xp === 30 && state.skills.find((s: any) => s.skillId === A).mastery === false && state.masteryHistory.length === 0, 'repetition multiplied XP or changed Mastery')
    check(await owner.$eval('#board-path-xp', (el) => (el as HTMLElement).dataset.xp) === '30', 'the board does not show the confirmed Path XP')
    // The retained completion action keeps the card on the matching side.
    await activate(owner, `#card-details-${borrow}`)
    await activate(owner, `#board-task-completion-btn-${borrow}`)
    await owner.waitForSelector(`#board-task-learning-${borrow}[data-completed="false"]`)
    await activate(owner, '#btn-close-card-details')
    await owner.waitForFunction((id, column) => document.getElementById(`board-card-${id}`)?.dataset.columnId !== column, {}, borrow, done)
    board = await synced(owner, A)
    check(!board.find((c) => c.completion)!.taskIds.includes(borrow) && !storedTask(await stored(), borrow).completed, 'Undo completion left the card in the Completion Column')
    await moveWithMenu(owner, borrow, 'Done')
    await synced(owner, A)
    pass('AC3 Done completes (+20 award), leaving corrects (−20), re-entering corrects (+20): Path XP 30, Mastery unclaimed; the retained Undo completion moves the card out')

    // ---- AC9: a failed coupled write, a lost answer, a refused locked completion, competing tabs.
    const cookies = (await ownerContext.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
    let mode: 'fail' | 'lose' | null = 'fail'
    const intercept = async (request: HTTPRequest) => {
      if (mode && request.method() === 'PUT' && request.url().endsWith(`/skills/${A}/board`)) {
        if (mode === 'lose') {
          // The backend commits the save, but its answer never reaches the page.
          const answer = await fetch(request.url(), { method: 'PUT', headers: { 'content-type': 'application/json', cookie: cookies }, body: request.postData() })
          check(answer.status === 200, `the lost-answer save answered ${answer.status}`)
        }
        return request.abort('failed')
      }
      return request.continue()
    }
    await owner.setRequestInterception(true)
    owner.on('request', intercept)
    const xpBefore = (await stored()).xp
    await moveWithMenu(owner, notes, 'Done')
    await owner.waitForSelector('#board-error[data-kind="failed"]', { visible: true })
    check(await owner.$eval('#board-save-status', (el) => (el as HTMLElement).dataset.state) === 'failed', 'a failed write is shown as saved')
    check((await shownBoard(owner)).find((c) => c.completion)!.taskIds.includes(notes), 'the failed move was not kept locally')
    check(await owner.$eval(`#board-card-${notes}`, (el) => (el as HTMLElement).dataset.completed) === 'false', 'the card claims completion the backend never confirmed')
    check(!storedTask(await stored(), notes).completed && (await stored()).xp === xpBefore, 'a failed coupled write changed learning records')
    check(!(await storedBoard(A)).find((c) => c.completion)!.taskIds.includes(notes), 'a failed coupled write persisted the column')
    mode = 'lose'
    await activate(owner, '#board-retry-btn')
    await owner.waitForSelector('#board-error[data-kind="failed"]', { visible: true })
    check(storedTask(await stored(), notes).completed, 'the lost-answer save did not commit')
    mode = null
    await activate(owner, '#board-retry-btn')
    await synced(owner, A)
    state = await stored()
    check(same(state.xpHistory.filter((e: any) => e.taskId === notes).map((e: any) => [e.kind, e.amount]), [['award', 5]]) && state.xp === xpBefore + 5,
      `the retried lost answer recorded ${JSON.stringify(state.xpHistory.filter((e: any) => e.taskId === notes))}, xp ${state.xp}`)
    owner.off('request', intercept)
    await owner.setRequestInterception(false)
    pass('AC9 failed write keeps the move locally, not saved, records unchanged; a lost answer is retried once: no duplicate XP event')

    await closeBoard(owner)
    await openBoard(owner, B)
    const bDone = await columnId(owner, 'Done')
    const bState = await stored()
    await moveWithMenu(owner, annotate, 'Done')
    await owner.waitForSelector('#board-error[data-kind="refused"]', { visible: true })
    check((await owner.$eval('#board-error', (el) => el.textContent ?? '')).includes('locked'), 'the refusal does not say the Skill is locked')
    check(same(await stored(), bState) && same(await storedBoard(B), bBoard), 'a refused locked completion persisted something')
    await activate(owner, '#board-discard-btn')
    await owner.waitForFunction((id, column) => document.getElementById(`board-card-${id}`)?.dataset.columnId !== column, {}, annotate, bDone)
    await closeBoard(owner)
    pass('AC9 a locked Skill\'s move into Done is refused in user language; neither column nor completion persists; Discard restores the board')

    const tab2 = await newPage(browser, errors, { context: ownerContext })
    await open(tab2, `/paths/${pathId}`)
    current = tab2
    await openBoard(tab2, A)
    await owner.bringToFront()
    current = owner
    await openBoard(owner, A)
    await tab2.bringToFront()
    await moveWithMenu(tab2, smart, 'To Do')
    await synced(tab2, A)
    await owner.bringToFront()
    await moveWithMenu(owner, notes, 'Backlog')
    await owner.waitForSelector('#board-conflict', { visible: true })
    check((await shownBoard(owner)).find((c) => c.name === 'Backlog')!.taskIds.includes(notes), 'the stale tab lost its change')
    check((await storedBoard(A)).find((c) => c.name === 'To Do')!.taskIds.includes(smart) && storedTask(await stored(), notes).completed === true, 'the stale save overwrote the newer board')
    await activate(owner, '#board-reapply-btn')
    board = await synced(owner, A)
    check(board.find((c) => c.name === 'To Do')!.taskIds.includes(smart) && board.find((c) => c.name === 'Backlog')!.taskIds.includes(notes), `reapplied board ${JSON.stringify(arrangement(board))}`)
    check(!storedTask(await stored(), notes).completed, 'reapplying did not uncomplete the moved Task')
    await tab2.close()
    pass('AC9 competing tab: the stale save is shown as a conflict, keeps its change, never overwrites; reapplying keeps both changes')

    // A failed save stays on its revision: after another tab's change, reopening shows a conflict instead of retrying silently.
    mode = 'fail'
    await owner.setRequestInterception(true)
    owner.on('request', intercept)
    await moveWithMenu(owner, notes, 'To Do')
    await owner.waitForSelector('#board-error[data-kind="failed"]', { visible: true })
    owner.off('request', intercept)
    await owner.setRequestInterception(false)
    mode = null
    const tab3 = await newPage(browser, errors, { context: ownerContext })
    current = tab3
    await open(tab3, `/paths/${pathId}`)
    await openBoard(tab3, A)
    await moveWithMenu(tab3, smart, 'Backlog')
    await synced(tab3, A)
    await tab3.close()
    current = owner
    await owner.bringToFront()
    await closeBoard(owner)
    await selectSkillFromList(owner, A)
    await activate(owner, '#open-board-btn')
    await owner.waitForSelector('#board-conflict', { visible: true })
    check(!await owner.$('#board-retry-btn'), 'Retry is offered on a newer board without a conflict decision')
    check((await shownBoard(owner)).find((c) => c.name === 'To Do')!.taskIds.includes(notes), 'the failed change was dropped on reopening')
    let remote = await storedBoard(A)
    check(remote.find((c) => c.name === 'Backlog')!.taskIds.includes(smart) && !remote.find((c) => c.name === 'To Do')!.taskIds.includes(notes), 'the failed change reached the backend without a decision')
    await activate(owner, '#board-reapply-btn')
    remote = await synced(owner, A)
    check(remote.find((c) => c.name === 'Backlog')!.taskIds.includes(smart) && remote.find((c) => c.name === 'To Do')!.taskIds.includes(notes), `after reapplying ${JSON.stringify(arrangement(remote))}`)
    pass('AC9 a failed change reopened after another tab\'s save is a conflict, not a silent retry; reapplying keeps both changes')

    /**
     * A failed move whose destination another tab then removes: Retry finds the newer board, Reapply cannot place
     * the card, and the owner either redirects it or discards it with the actual recovery controls.
     */
    async function lostDestination(taskId: string, spare: string) {
      await activate(owner, '#board-add-column-btn')
      await owner.waitForSelector('#new-column-name', { visible: true })
      await owner.type('#new-column-name', spare)
      await activate(owner, '#new-column-submit')
      await owner.waitForFunction((name) => [...document.querySelectorAll<HTMLElement>('#board-columns > section')].some((c) => c.dataset.name === name), {}, spare)
      await synced(owner, A)
      mode = 'fail'
      await owner.setRequestInterception(true)
      owner.on('request', intercept)
      await moveWithMenu(owner, taskId, spare)
      await owner.waitForSelector('#board-error[data-kind="failed"]', { visible: true })
      owner.off('request', intercept)
      await owner.setRequestInterception(false)
      mode = null
      // Another tab removes the empty column.
      const remote = (await ok(owner, `${route}/skills/${A}/board`)).board
      await ok(owner, `${route}/skills/${A}/board`, 'PUT', { expectedRevision: remote.revision, columns: remote.columns.filter((c: Column) => c.name !== spare) })
      await activate(owner, '#board-retry-btn')
      await owner.waitForSelector('#board-conflict', { visible: true })
      await activate(owner, '#board-reapply-btn')
      await owner.waitForSelector(`#board-unapplied li[data-task-id="${taskId}"]`, { visible: true })
      check(await owner.$eval('#board-save-status', (el) => (el as HTMLElement).dataset.state) === 'unapplied', 'an unplaceable change is shown as saved')
      check((await owner.$eval('#board-unapplied', (el) => el.textContent ?? '')).includes(spare), 'the explanation does not name the removed column')
      return (await storedBoard(A)).find((c) => c.taskIds.includes(taskId))!.name
    }
    const notesWasIn = await lostDestination(notes, 'Spare')
    await owner.select('#board-redirect-select-0', await columnId(owner, 'Backlog'))
    await activate(owner, '#board-redirect-btn-0')
    board = await synced(owner, A)
    check(board.find((c) => c.name === 'Backlog')!.taskIds.includes(notes) && notesWasIn !== 'Backlog', `redirected move: ${JSON.stringify(arrangement(board))}`)
    const smartWasIn = await lostDestination(smart, 'Spare two')
    await activate(owner, '#board-discard-unapplied-btn')
    board = await synced(owner, A)
    check(board.find((c) => c.taskIds.includes(smart))!.name === smartWasIn && !board.some((c) => c.name.startsWith('Spare')), `discarded move: ${JSON.stringify(arrangement(board))}`)
    pass('AC9 a failed move whose column another tab removed is held as not applicable, then redirected or discarded through the board\'s own controls; stored boards match')

    // ---- AC4/AC5: columns are customised; the Completion Column follows its role through rename and replacement.
    await activate(owner, '#board-add-column-btn')
    await owner.waitForSelector('#new-column-name', { visible: true })
    await activate(owner, '#new-column-submit')
    await owner.waitForSelector('#new-column-error', { visible: true })
    await owner.type('#new-column-name', 'Review')
    await activate(owner, '#new-column-submit')
    await owner.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('#board-columns > section')].some((s) => s.dataset.name === 'Review'))
    await synced(owner, A)
    const reviewId = await columnId(owner, 'Review')
    await activate(owner, `#column-menu-${done}`)
    await setValue(owner, `#column-rename-${done}`, 'Finished')
    await activate(owner, `#column-rename-save-${done}`)
    board = await synced(owner, A)
    check(board.find((c) => c.id === done)!.name === 'Finished' && board.find((c) => c.id === done)!.completion, 'renaming Done changed its role')
    await activate(owner, `#column-menu-${reviewId}`)
    await activate(owner, `#column-move-left-${reviewId}`)
    board = await synced(owner, A)
    check(same(board.map((c) => c.name), ['Backlog', 'To Do', 'Review', 'In Progress', 'Finished']), `column order ${JSON.stringify(board.map((c) => c.name))}`)
    await moveWithMenu(owner, smart, 'Review')
    await synced(owner, A)
    // Removing a populated column needs a destination; its Task survives.
    await activate(owner, `#column-menu-${reviewId}`)
    await activate(owner, `#column-remove-${reviewId}`)
    await owner.waitForSelector('#remove-destination-select', { visible: true })
    await owner.select('#remove-destination-select', await columnId(owner, 'Backlog'))
    check(await visible(owner, '#remove-no-learning-change'), 'removing a plain column does not say completion stays')
    await activate(owner, '#remove-column-confirm')
    board = await synced(owner, A)
    check(!board.some((c) => c.name === 'Review') && board.find((c) => c.name === 'Backlog')!.taskIds.includes(smart), `after removing Review: ${JSON.stringify(arrangement(board))}`)
    // Replacing the Completion Column explains the consequences first, then reconciles in one change.
    const inProgress = await columnId(owner, 'In Progress')
    await moveWithMenu(owner, smart, 'In Progress')
    await synced(owner, A)
    const preReplace = await stored()
    const finishedTasks = board.find((c) => c.completion)!.taskIds
    await activate(owner, `#column-menu-${done}`)
    await activate(owner, `#column-remove-${done}`)
    await owner.waitForSelector('#remove-replacement-select', { visible: true })
    await owner.select('#remove-replacement-select', inProgress)
    await owner.select('#remove-destination-select', await columnId(owner, 'Backlog'))
    const consequences = await owner.$$eval('#remove-consequences li', (els) => els.map((el) => [(el as HTMLElement).dataset.taskId ?? '', (el as HTMLElement).dataset.completed ?? '', el.textContent ?? '']))
    const expected = [...finishedTasks.map((id) => [id, 'false']), [smart, 'true']]
    check(same(consequences.map(([id, completed]) => [id, completed]).sort(), expected.sort()), `consequences ${JSON.stringify(consequences)}`)
    check(consequences.some(([id, , text]) => id === borrow && text.includes('−20 XP')), 'the consequence does not state the XP correction')
    await activate(owner, '#remove-column-confirm')
    board = await synced(owner, A)
    check(same(board.map((c) => [c.name, c.completion]), [['Backlog', false], ['To Do', false], ['In Progress', true]]), `after replacement ${JSON.stringify(board)}`)
    state = await stored()
    for (const id of finishedTasks) check(!storedTask(state, id).completed, `Task ${id} kept completion outside the Completion Column`)
    check(storedTask(state, smart).completed, 'the replacement column did not complete its Task')
    check(state.xp === preReplace.xp - finishedTasks.reduce((sum: number, id: string) => sum + storedTask(preReplace, id).xpReward, 0), `XP after replacement ${state.xp}`)
    check(state.masteryHistory.length === 0, 'replacement changed Mastery')
    // The last usable column cannot be removed.
    await activate(owner, `#column-menu-${todo}`)
    await activate(owner, `#column-remove-${todo}`)
    await owner.select('#remove-destination-select', await columnId(owner, 'Backlog'))
    await activate(owner, '#remove-column-confirm')
    board = await synced(owner, A)
    const backlog = board.find((c) => c.name === 'Backlog')!
    await activate(owner, `#column-menu-${backlog.id}`)
    await activate(owner, `#column-remove-${backlog.id}`)
    await owner.waitForSelector('#remove-column-blocked', { visible: true })
    await activate(owner, '#btn-close-remove-column')
    await owner.screenshot({ path: path.join(FRONTEND, '..', '.harness', 'ux03-board.png') })
    pass('AC4/AC5 add (name required), rename Done keeps its role, reorder, remove Review into Backlog; Completion Column replacement listed each completion change and XP before confirming, then reconciled in one save; the last usable column cannot be removed')

    // ---- AC6: eligible deletion with undo; a Task with history is archived and kept outside the board.
    const backlogId = backlog.id
    await activate(owner, `#add-card-${backlogId}`)
    await owner.type('#new-card-title', 'Scratch idea')
    await activate(owner, '#new-card-submit')
    await owner.waitForFunction((column) => document.querySelectorAll(`#board-column-${column} [data-card-id]`).length > 0, {}, backlogId)
    board = await synced(owner, A)
    const scratch = board.find((c) => c.id === backlogId)!.taskIds.find((id) => !backlog.taskIds.includes(id))!
    const scratchIndex = board.find((c) => c.id === backlogId)!.taskIds.indexOf(scratch)
    await activate(owner, `#card-details-${scratch}`)
    await activate(owner, '#card-delete-btn')
    await owner.waitForSelector('#board-undo-delete-btn', { visible: true })
    check(!await owner.$(`#board-card-${scratch}`), 'the deleted card is still shown')
    await owner.waitForSelector('#save-status[data-state="saved"]')
    await synced(owner, A)
    check(!(await ok(owner, route)).application.skills[0].tasks.some((t: any) => t.id === scratch), 'the deletion was not saved')
    await activate(owner, '#board-undo-delete-btn')
    await owner.waitForSelector(`#board-card-${scratch}`)
    await owner.waitForSelector('#save-status[data-state="saved"]')
    board = await synced(owner, A)
    check(board.find((c) => c.id === backlogId)!.taskIds.indexOf(scratch) === scratchIndex, `undo restored the card at ${JSON.stringify(arrangement(board))}`)
    check((await ok(owner, route)).application.skills[0].tasks.some((t: any) => t.id === scratch && t.title === 'Scratch idea'), 'undo was not saved')
    // borrow has history: details offer archival, not deletion.
    await activate(owner, `#card-details-${borrow}`)
    check(!await owner.$('#card-delete-btn') && await owner.$(`#board-task-archive-${borrow}`) !== null, 'a Task with history offers deletion')
    const xpBeforeArchive = (await stored()).xp
    await activate(owner, `#board-task-archive-${borrow}`)
    await activate(owner, `#board-task-archive-confirm-btn-${borrow}`)
    await owner.waitForFunction((id) => !document.getElementById(`board-card-${id}`), {}, borrow)
    await owner.waitForSelector('#save-status[data-state="saved"]')
    state = await stored()
    check(storedTask(state, borrow).archivedAt && state.xp === xpBeforeArchive, 'archival changed XP or did not archive')
    check(!(await storedBoard(A)).some((c) => c.taskIds.includes(borrow)), 'an archived Task stayed on the board')
    if (await visible(owner, '#btn-close-card-details')) await activate(owner, '#btn-close-card-details')
    if (await visible(owner, '#task-board')) await closeBoard(owner)
    await selectSkillFromList(owner, A)
    await owner.waitForSelector(`#retained-task-${borrow}`)
    pass('AC6 eligible deletion saved and undone in place through normal saves; a Task with history archives instead, leaves the board, keeps XP and stays reachable as retained history')

    // ---- AC8: reload restores the arrangement; another Skill and Path are untouched.
    const beforeReload = await storedBoard(A)
    await owner.reload({ waitUntil: 'networkidle0' })
    await owner.waitForSelector('#path-editor[data-gpu-status="ready"]', { timeout: 20000 })
    await openBoard(owner, A)
    check(same(arrangement(await shownBoard(owner)), arrangement(beforeReload)), `after reload ${JSON.stringify(arrangement(await shownBoard(owner)))} vs ${JSON.stringify(arrangement(beforeReload))}`)
    check(same(await storedBoard(B), bBoard), 'the other Skill\'s board changed')
    const guitar = await ok(owner, `/personal/learning-paths/${otherPath.learningPath.id}/skills/${G}/board`)
    check(same(guitar.board.columns.map((c: Column) => [c.name, c.taskIds]), [['Backlog', [chords]], ['To Do', []], ['In Progress', []], ['Done', []]]), 'the other Path\'s board is not its own')
    const intruder = await newPage(browser, errors)
    await intruder.goto(ORIGIN, { waitUntil: 'networkidle0' })
    await setValue(intruder, '#email-input', 'intruder@ux03.test')
    await setValue(intruder, '#password-input', PASSWORD)
    await activate(intruder, '#sign-up-btn')
    await intruder.waitForSelector('#personal-workspace')
    check((await api(intruder, `${route}/skills/${A}/board`)).status === 404, 'another Account reached the board')
    check((await api(intruder, `${route}/skills/${A}/board`, 'PUT', { expectedRevision: 0, columns: beforeReload })).status === 404, 'another Account saved the board')
    await intruder.close()
    await closeBoard(owner)
    pass('AC8 reload restores column order, names, role and membership; the other Skill and Path are unchanged; another Account gets 404')

    // ---- AC10: narrow viewport, keyboard only, without WebGPU.
    const narrow = await newPage(browser, errors, { context: ownerContext, noGpu: true, width: 390, height: 844 })
    current = narrow
    await open(narrow, `/paths/${pathId}`, 'unsupported')
    await openBoard(narrow, A)
    const columns = await shownBoard(narrow)
    check(await visible(narrow, '#board-column-select'), 'no column selector at a narrow viewport')
    const last = columns.at(-1)!
    await narrow.select('#board-column-select', last.id)
    await narrow.waitForFunction((id) => document.activeElement?.id === `board-column-heading-${id}`, {}, last.id)
    const inView = await narrow.$eval(`#board-column-heading-${last.id}`, (el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth })
    check(inView && await narrow.$eval('#board-columns', (el) => el.scrollLeft > 0), 'the column selector did not navigate horizontally')
    await narrow.screenshot({ path: path.join(FRONTEND, '..', '.harness', 'ux03-board-narrow.png') })
    const card = columns.find((c) => c.taskIds.length > 0 && !c.completion)!.taskIds[0]
    await activate(narrow, `#card-details-${card}`)
    const detailsWidth = await narrow.$eval('dialog[aria-label="Task details"]', (el) => el.getBoundingClientRect().width)
    check(Math.abs(detailsWidth - 390) < 2, `details are ${detailsWidth}px wide at a 390px viewport`)
    await narrow.keyboard.press('Escape')
    await narrow.waitForSelector('#card-edit-title', { hidden: true })
    check(await focusedId(narrow) === `card-details-${card}`, `focus after closing details is on ${await focusedId(narrow)}`)
    await activate(narrow, '#board-add-column-btn')
    await narrow.waitForSelector('#new-column-name', { visible: true })
    await narrow.keyboard.type('Later')
    await narrow.keyboard.press('Enter')
    await narrow.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('#board-columns > section')].some((s) => s.dataset.name === 'Later'))
    await synced(narrow, A)
    await activate(narrow, `#card-move-${card}`)
    await narrow.select(`#card-move-column-${card}`, await columnId(narrow, 'Later'))
    await activate(narrow, `#card-move-apply-${card}`)
    check(await focusedId(narrow) === `card-move-${card}`, 'focus did not follow the moved card')
    const narrowBoard = await synced(narrow, A)
    check(narrowBoard.find((c) => c.taskIds.includes(card))!.name === 'Later', 'the keyboard move went to the wrong column')
    await narrow.keyboard.press('Escape')
    await narrow.waitForSelector('#task-board', { hidden: true })
    check(await focusedId(narrow) === 'open-board-btn', `focus after Escape is on ${await focusedId(narrow)}`)
    pass('AC10 without WebGPU at 390px: column selector navigates horizontally and focuses the column; full-screen details; keyboard move persists; Escape closes with focus restored')

    // ---- AC6/AC9: deleting a Task while its move is being saved keeps the other change made meanwhile.
    await narrow.close()
    current = owner
    await owner.bringToFront()
    await openBoard(owner, A)
    // The owner's board was cached before the narrow tab added Later: wait until its read has caught up.
    await synced(owner, A)
    const inbox = await columnId(owner, 'Backlog')
    const later = await columnId(owner, 'Later')
    await activate(owner, `#add-card-${inbox}`)
    await owner.type('#new-card-title', 'Temporary card')
    await activate(owner, '#new-card-submit')
    await owner.waitForFunction(() => [...document.querySelectorAll('[id^="board-card-title-"]')].some((el) => el.textContent === 'Temporary card'))
    board = await synced(owner, A)
    const temporary = (await ok(owner, route)).application.skills[0].tasks.find((t: any) => t.title === 'Temporary card').id as string
    let releaseSave!: () => void
    const saveHeld = new Promise<void>((resolve) => { releaseSave = resolve })
    let holding = true
    const hold = async (request: HTTPRequest) => {
      if (holding && request.method() === 'PUT' && request.url().endsWith(`/skills/${A}/board`)) {
        holding = false
        await saveHeld
      }
      return request.continue()
    }
    await owner.setRequestInterception(true)
    owner.on('request', hold)
    await moveWithMenu(owner, temporary, 'Later')
    await owner.waitForSelector('#board-save-status[data-state="saving"]')
    await activate(owner, `#card-details-${temporary}`)
    await activate(owner, '#card-delete-btn')
    await owner.waitForFunction((id) => !document.getElementById(`board-card-${id}`), {}, temporary)
    await activate(owner, `#column-menu-${inbox}`)
    await setValue(owner, `#column-rename-${inbox}`, 'Inbox')
    await activate(owner, `#column-rename-save-${inbox}`)
    releaseSave()
    await owner.waitForSelector('#save-status[data-state="saved"]')
    board = await synced(owner, A)
    owner.off('request', hold)
    await owner.setRequestInterception(false)
    check(board.find((c) => c.id === inbox)!.name === 'Inbox' && !board.some((c) => c.taskIds.includes(temporary)), `after delete during save: ${JSON.stringify(arrangement(board))}`)
    check(!(await ok(owner, route)).application.skills[0].tasks.some((t: any) => t.id === temporary), 'the deleted Task was not saved as deleted')
    void later
    pass('AC6/AC9 deleting a Task while its move is in flight drops only that move; a rename made meanwhile is saved once the deletion is')

    // ---- AC9: after a lost answer, changing the card back locally is confirmed with the backend, never assumed saved.
    const completionId = board.find((c) => c.completion)!.id
    const lostTask = board.find((c) => c.id === inbox)!.taskIds[0]
    mode = 'lose'
    await owner.setRequestInterception(true)
    owner.on('request', intercept)
    await moveWithMenu(owner, lostTask, board.find((c) => c.completion)!.name)
    await owner.waitForSelector('#board-error[data-kind="failed"]', { visible: true })
    owner.off('request', intercept)
    await owner.setRequestInterception(false)
    mode = null
    check((await storedBoard(A)).find((c) => c.id === completionId)!.taskIds.includes(lostTask), 'the lost-answer save did not commit')
    await moveWithMenu(owner, lostTask, 'Inbox')
    await activate(owner, '#board-retry-btn')
    await owner.waitForSelector('#board-conflict', { visible: true })
    check(await owner.$eval('#board-save-status', (el) => (el as HTMLElement).dataset.state) === 'conflict', 'a reverted change after a lost answer was called saved')
    await activate(owner, '#board-discard-btn')
    board = await synced(owner, A)
    check(board.find((c) => c.id === completionId)!.taskIds.includes(lostTask) && storedTask(await stored(), lostTask).completed, 'the board does not show what the backend holds after the conflict')
    pass('AC9 a change reverted locally after a lost answer is checked with the backend: the committed move surfaces as a conflict, never as saved')

    // ---- AC9: a Task another tab deleted, while this tab's document still holds it, neither blocks nor reappears on the board.
    await closeBoard(owner)
    const docNow = await ok(owner, route)
    const victim = docNow.application.skills[0].tasks.find((t: any) => t.id === scratch) ? scratch : null
    check(victim, 'the Task to delete elsewhere is missing')
    await ok(owner, `${route}/document`, 'PUT', { expectedRevision: docNow.learningPath.revision, title: docNow.learningPath.title, goal: docNow.learningPath.goal, editor: docNow.editor,
      application: { skills: docNow.application.skills.map((skill: any) => ({ ...skill, tasks: skill.tasks.filter((t: any) => t.id !== victim) })) } })
    await openBoard(owner, A)
    await owner.waitForSelector('#board-stale-tasks', { visible: true })
    check(!await owner.$(`#board-card-${victim}`), 'a Task deleted elsewhere reappeared on the board')
    await activate(owner, `#column-menu-${inbox}`)
    await setValue(owner, `#column-rename-${inbox}`, 'Inbox two')
    await activate(owner, `#column-rename-save-${inbox}`)
    board = await synced(owner, A)
    check(board.find((c) => c.id === inbox)!.name === 'Inbox two', 'the board stayed blocked by a Task deleted elsewhere')
    pass('AC9 a Task deleted in another tab is reported, not shown again, and does not block later board saves')

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log('\nUX03 task board check passed.')
  } catch (error) {
    if (current) await current.screenshot({ path: path.join(FRONTEND, '..', '.harness', 'ux03-failure.png') }).catch(() => {})
    throw error
  } finally {
    await browser?.close()
    backend.kill()
    web.kill()
  }
}

if (import.meta.main) main().catch((error) => {
  console.error(error)
  process.exit(1)
})
