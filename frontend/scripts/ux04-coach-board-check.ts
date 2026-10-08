#!/usr/bin/env bun
/**
 * UX04 (#50, parent #46): a Coach's preparation board for one Draft Skill on the current
 * build, against real Better Auth, the backend and an isolated migrated PostgreSQL.
 * Requires harness checks build and db-up; isolated ports 3597/3598 and database
 * gurow_ux04_browser_test make it eligible for parallel execution. Every learning and
 * content outcome is read back from the backend independently of what the board shows.
 *
 * Run from frontend: bun run scripts/ux04-coach-board-check.ts [--skip-build]
 *
 * AC1  Open the preparation board from the Draft Skill summary, return with the same camera; per-Skill Tasks; initial columns.
 * AC2  Add (required title), edit, Required/Enrichment and reward from the details, keyboard and pointer moves; Skill rules reachable.
 * AC3  Add, rename, reorder, remove columns with a destination; last column kept; no Completion Column; reload restores.
 * AC4  Ready grants nothing to the learner; publication follows the Draft's rules only, without a column gate.
 * AC5  Published Versions unchanged; learners and other Accounts cannot read or save Draft boards.
 * AC6  Existing Draft Tasks start in Ideas in saved order; Tasks created later join the board.
 * AC7  Eligible deletion with undo; published material archived, kept as history, never brought back by a stale board.
 * AC8  The separate Review entry reaches submitted work, hides private drafts and leaves the board unchanged.
 * AC9  Failed and conflicting writes keep local intent truthfully; identity switching shows nothing of the Coach's Draft.
 * AC10 Narrow viewport column selector, full-screen details and keyboard management without WebGPU.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import puppeteer, { type Browser, type BrowserContext, type HTTPRequest, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'
import { closeSummaryBoard, openCardDetails, openSkillView, selectSkillFromList } from './editor-navigation'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = 3597
const API_PORT = 3598
const ORIGIN = `http://127.0.0.1:${PORT}`
const DATABASE_URL = 'postgres://gurow:gurow@127.0.0.1:5433/gurow_ux04_browser_test'
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
const bodyText = (page: Page) => page.evaluate(() => document.body.innerText)
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
    server.once('error', (error) => reject(new Error(`UX04 requires unused port ${port}: ${error.message}`)))
    server.listen(port, '127.0.0.1', () => server.close((error) => error ? reject(error) : resolve()))
  })
}
async function newPage(browser: Browser, errors: string[], { noGpu = false, context = undefined as BrowserContext | undefined, width = 1440, height = 1000 } = {}) {
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
  const resend = startResendStandIn()
  const backend = spawn('bun', ['run', 'src/index.ts'], { cwd: BACKEND, env: { ...process.env, DATABASE_URL, PORT: String(API_PORT), BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: 'ux04-browser-check-secret-not-for-production', NODE_ENV: 'test', RESEND_API_KEY: resend.apiKey, RESEND_API_URL: resend.url, MAIL_FROM: 'Gurow <invitations@gurow.test>' }, stdio: ['ignore', 'ignore', 'inherit'] })
  const web = spawn('node', ['.output/server/index.mjs'], { cwd: FRONTEND, env: { ...process.env, PORT: String(PORT), GUROW_API_ORIGIN: `http://127.0.0.1:${API_PORT}` }, stdio: 'ignore' })
  let browser: Browser | undefined
  let current: Page | undefined
  const errors: string[] = []
  async function emailLink(email: string, subject: string, after: number) {
    for (let i = 0; i < 100; i++) {
      const mail = resend.sent.slice(after).filter((m) => m.to.includes(email) && m.subject.startsWith(subject)).at(-1)
      const link = mail && /https?:\/\/\S+/.exec(mail.text)?.[0]
      if (link) return link
      await pause(50)
    }
    throw new Error(`missing ${subject} email for ${email}`)
  }
  async function authenticate(page: Page, email: string, signup = true) {
    const before = resend.sent.length
    await page.bringToFront()
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
    await page.waitForSelector('#sign-in-form')
    await setValue(page, '#email-input', email)
    await setValue(page, '#password-input', PASSWORD)
    await activate(page, signup ? '#sign-up-btn' : '#sign-in-btn')
    await page.waitForSelector('#personal-workspace')
    if (signup) {
      await page.goto(await emailLink(email, 'Verify', before), { waitUntil: 'networkidle0' })
      await page.waitForSelector('#email-verification-status[data-verified="true"]')
    }
  }
  try {
    await waitForServerReady(ORIGIN)
    for (let i = 0; i < 50; i++) {
      if ((await fetch(`${ORIGIN}/api/account`).catch(() => null))?.status === 401) break
      check(i < 49, 'backend never became ready')
      await pause(200)
    }
    browser = await puppeteer.launch({ executablePath: resolveChromiumExecutable(), headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu', '--use-gl=angle', '--disable-dev-shm-usage'] })
    const coachContext = await browser.createBrowserContext()
    const coach = await newPage(browser, errors, { context: coachContext })
    current = coach
    await authenticate(coach, 'coach@ux04.test')

    // ---- Published history: Version 1 with an enrolled learner who sent work and keeps a private draft.
    const uuid = () => crypto.randomUUID()
    const [V, M] = [uuid(), uuid()]
    const [drills, reading, matrix] = [uuid(), uuid(), uuid()]
    const workspace = (await ok(coach, '/coach/workspaces', 'POST', { name: 'UX04 studio' })).workspace
    const created = await ok(coach, `/coach/workspaces/${workspace.id}/learning-paths`, 'POST', { title: 'Coached algebra', goal: 'Explain linear maps' })
    const pathId = created.learningPath.id as string
    const coachRoute = `/coach/learning-paths/${pathId}`
    const seeded = await ok(coach, `${coachRoute}/draft`, 'PUT', {
      expectedRevision: created.learningPath.revision, title: 'Coached algebra', goal: 'Explain linear maps',
      editor: { format_version: 1, cards: [{ id: V, title: 'Vectors', position: { x: 120, y: 140 } }, { id: M, title: 'Matrices', position: { x: 460, y: 140 } }], connections: [{ from_id: V, to_id: M }] },
      application: { skills: [
        { id: V, title: 'Vectors', outcome: 'Add vectors confidently', optional: false, xpThreshold: 0, tasks: [
          { id: drills, title: 'Vector drills', description: 'Show your calculation', required: true, xpReward: 20 },
          { id: reading, title: 'Read chapter 1', description: '', required: false, xpReward: 5 },
        ] },
        { id: M, title: 'Matrices', outcome: 'Compose linear maps', optional: false, xpThreshold: 0, tasks: [{ id: matrix, title: 'Matrix drills', description: '', required: true, xpReward: 10 }] },
      ] },
    })
    const v1 = (await ok(coach, `${coachRoute}/publication`, 'POST', { expectedRevision: seeded.learningPath.revision })).version
    const learnerContext = await browser.createBrowserContext()
    const learner = await newPage(browser, errors, { context: learnerContext })
    await authenticate(learner, 'learner@ux04.test')
    const beforeInvite = resend.sent.length
    await ok(coach, `/coach/learning-path-versions/${v1.id}/invitations`, 'POST', { email: 'learner@ux04.test' })
    const invitationId = new URL(await emailLink('learner@ux04.test', 'You are invited', beforeInvite)).pathname.split('/').at(-1)!
    const enrollment = (await ok(learner, `/invitations/${invitationId}/accept`, 'POST')).enrollment.id as string
    const work = `/enrollments/${enrollment}/tasks/${drills}`
    await ok(learner, `${work}/submission/revisions`, 'POST', { text: 'Sent: (1, 2) + (2, 3) = (3, 5)', urls: [] })
    await ok(learner, `${work}/draft`, 'PUT', { text: 'PRIVATE draft the Coach must not see', urls: [] })
    const learnerState = async () => (await ok(learner, `/enrollments/${enrollment}/learning-state`)).learningState
    const learnerBefore = await learnerState()
    const enrolledBefore = await ok(learner, `/enrollments/${enrollment}/version`)
    // A published Version's own content: its title and goal, learning content, rules and Canvas Layout (the Path's revision moves with Draft saves).
    const versionContent = async (versionId: string) => {
      const read = await ok(coach, `/coach/learning-path-versions/${versionId}`)
      return { title: read.learningPath.title, goal: read.learningPath.goal, version: read.version, editor: read.editor, application: read.application }
    }
    const v1Before = await versionContent(v1.id)
    // The next Version is prepared in a Draft through the ordinary workflow.
    const prepared = await ok(coach, `${coachRoute}/drafts`, 'POST', { expectedRevision: (await ok(coach, coachRoute)).learningPath.revision })
    const draftId = prepared.draft.id as string
    const boardRoute = (skillId: string) => `${coachRoute}/drafts/${draftId}/skills/${skillId}/board`
    const storedBoard = async (skillId: string, page = coach): Promise<Column[]> => (await ok(page, boardRoute(skillId))).board.columns
    const storedDoc = (page = coach) => ok(page, coachRoute)
    const storedTasks = async (skillId: string) => (await storedDoc()).application.skills.find((s: any) => s.id === skillId).tasks as any[]

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
      await page.mouse.up()
    }
    async function moveWithMenu(page: Page, taskId: string, columnName: string) {
      if (!await page.$(`#card-move-menu-${taskId}`)) await activate(page, `#card-move-${taskId}`)
      await page.waitForSelector(`#card-move-column-${taskId}`, { visible: true })
      await page.select(`#card-move-column-${taskId}`, await columnId(page, columnName))
      await activate(page, `#card-move-apply-${taskId}`)
    }

    // ---- AC1/AC6: open from the Draft summary at a changed camera; initial columns and placement; return keeps the camera.
    await open(coach, `/coach/paths/${pathId}`)
    const canvas = await coach.$eval('#editor-canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
    await coach.mouse.move(canvas.x + 200, canvas.y + 200)
    await coach.keyboard.down('Control')
    await coach.mouse.wheel({ deltaY: -30 })
    await coach.keyboard.up('Control')
    await coach.mouse.wheel({ deltaX: 60, deltaY: -40 })
    await coach.waitForFunction(() => getComputedStyle(document.querySelector('#labels-camera')!).transform !== 'matrix(1, 0, 0, 1, 0, 0)')
    await pause(300)
    const cameraBefore = await camera(coach)
    const labelBefore = await labelBox(coach, V)
    const contentBefore = await storedDoc()
    await selectSkillFromList(coach, V)
    check(/preparation board/i.test(await coach.$eval('#open-board-btn', (el) => (el as HTMLElement).innerText)), 'the Draft board action is not labelled as preparation')
    await activate(coach, '#open-board-btn')
    await coach.waitForSelector('#task-board[open] #board-columns > section')
    await coach.waitForSelector('#board-save-status[data-state="saved"]')
    let board = await shownBoard(coach)
    check(same(board.map((c) => [c.name, c.completion]), [['Ideas', false], ['In preparation', false], ['Ready', false]]), `initial columns ${JSON.stringify(board)}`)
    check(same(arrangement(board), [`Ideas:${drills},${reading}`, 'In preparation:', 'Ready:']), `initial placement ${JSON.stringify(arrangement(board))}`)
    check(!/Completion Column/i.test(await coach.$eval('#task-board', (el) => (el as HTMLElement).innerText)), 'a Draft board shows a Completion Column')
    check(await coach.$eval(`#board-card-${drills}`, (el) => (el as HTMLElement).dataset.completed === undefined), 'a Draft card claims completion state')
    check(/do not publish, approve, award XP/i.test(await coach.$eval('#board-note', (el) => (el as HTMLElement).innerText)), 'the board does not say what its columns mean')
    check(/Required/.test(await coach.$eval(`#board-card-${drills}`, (el) => (el as HTMLElement).innerText)) && /Enrichment/.test(await coach.$eval(`#board-card-${reading}`, (el) => (el as HTMLElement).innerText)), 'cards lost the Required/Enrichment designation')
    check(same(await storedDoc(), contentBefore), 'opening the board changed the Draft')
    await closeBoard(coach)
    check(await focusedId(coach) === 'open-board-btn', `focus after closing the board is on ${await focusedId(coach)}`)
    check(await camera(coach) === cameraBefore && same(await labelBox(coach, V), labelBefore), 'returning from the board changed the camera')
    await openBoard(coach, M)
    check(same(arrangement(await shownBoard(coach)), [`Ideas:${matrix}`, 'In preparation:', 'Ready:']), 'the Matrices board does not hold only its own Task')
    await closeBoard(coach)
    pass('AC1/AC6 Open preparation board from the Draft summary: Ideas/In preparation/Ready, no Completion Column, Draft Tasks in Ideas in saved order, Required/Enrichment shown; Draft unchanged; camera and focus restored; Matrices shows its own Task')

    // ---- AC2: add with a required title, edit title/description, Required/Enrichment and reward, keyboard and pointer moves.
    await openBoard(coach, V)
    const prep = await columnId(coach, 'In preparation')
    await activate(coach, `#add-card-${prep}`)
    await coach.waitForSelector('#new-card-title', { visible: true })
    await activate(coach, '#new-card-submit')
    await coach.waitForSelector('#new-card-error', { visible: true })
    check(await focusedId(coach) === 'new-card-title', 'focus did not return to the empty title')
    await coach.type('#new-card-title', 'Worked examples')
    await coach.type('#new-card-description', 'Three solved problems')
    await activate(coach, '#new-card-submit')
    await coach.waitForFunction((column) => document.querySelectorAll(`#board-column-${column} [data-card-id]`).length === 1, {}, prep)
    const examples = await coach.$eval(`#board-column-${prep} [data-card-id]`, (el) => (el as HTMLElement).dataset.cardId!)
    board = await synced(coach, V)
    check(same(board.find((c) => c.name === 'In preparation')!.taskIds, [examples]), 'the new Task was not saved in In preparation')
    const added = (await storedTasks(V)).find((t) => t.id === examples)
    check(same(added, { id: examples, title: 'Worked examples', description: 'Three solved problems', required: true, xpReward: 0 }), `the new Task was not saved as a Required Draft Task: ${JSON.stringify(added)}`)
    await activate(coach, `#card-details-${examples}`)
    await coach.waitForSelector('#card-edit-title', { visible: true })
    await setValue(coach, '#card-edit-title', '  ')
    await activate(coach, '#card-edit-save')
    await coach.waitForSelector('#card-edit-error', { visible: true })
    await setValue(coach, '#card-edit-title', 'Solved examples')
    await setValue(coach, '#card-edit-description', 'Four solved problems')
    await activate(coach, '#card-edit-save')
    await coach.click(`#board-task-required-${examples}`)
    await setValue(coach, `#board-task-xp-reward-${examples}`, '15')
    await activate(coach, '#btn-close-card-details')
    await coach.waitForFunction((id) => document.getElementById(`board-card-title-${id}`)?.textContent === 'Solved examples', {}, examples)
    await coach.waitForSelector('#save-status[data-state="saved"]')
    await coach.waitForFunction((id) => /Enrichment/.test(document.getElementById(`board-card-${id}`)?.innerText ?? ''), {}, examples)
    for (let i = 0; i < 50 && (await storedTasks(V)).find((t) => t.id === examples).xpReward !== 15; i++) await pause(100)
    check(same((await storedTasks(V)).find((t) => t.id === examples), { id: examples, title: 'Solved examples', description: 'Four solved problems', required: false, xpReward: 15 }), 'title, description, Enrichment and reward were not saved through the Draft')
    // Keyboard: move to Ready from the menu, then reorder; pointer: drag across and before a card.
    await moveWithMenu(coach, drills, 'Ready')
    check(await focusedId(coach) === `card-move-${drills}`, 'focus did not follow the moved card')
    board = await synced(coach, V)
    check(same(board.find((c) => c.name === 'Ready')!.taskIds, [drills]), `keyboard move to Ready: ${JSON.stringify(arrangement(board))}`)
    await dragCard(coach, reading, await columnId(coach, 'Ready'), drills)
    board = await synced(coach, V)
    check(same(board.find((c) => c.name === 'Ready')!.taskIds, [reading, drills]), `drag before a card: ${JSON.stringify(arrangement(board))}`)
    if (!await coach.$(`#card-move-menu-${drills}`)) await activate(coach, `#card-move-${drills}`)
    await activate(coach, `#card-move-up-${drills}`)
    board = await synced(coach, V)
    check(same(board.find((c) => c.name === 'Ready')!.taskIds, [drills, reading]), `keyboard reorder: ${JSON.stringify(arrangement(board))}`)
    await activate(coach, `#card-move-${drills}`)
    await dragCard(coach, examples, await columnId(coach, 'Ideas'))
    board = await synced(coach, V)
    check(same(arrangement(board), [`Ideas:${examples}`, 'In preparation:', `Ready:${drills},${reading}`]), `drag across columns: ${JSON.stringify(arrangement(board))}`)
    check((await storedDoc()).application.skills.every((s: any) => s.tasks.every((t: any) => s.id === V ? [drills, reading, examples].includes(t.id) : t.id === matrix)), 'a board move changed a Task\'s Skill')
    // The Draft's Skill rules are in the summary's Edit view; each Task's Required setting and reward in its board details.
    await closeBoard(coach)
    await openSkillView(coach, 'edit')
    check(await visible(coach, '#draft-rules'), 'Skill rules became unreachable')
    await openSkillView(coach, 'summary')
    // Reopened details show the values the earlier details saved through the Draft.
    await activate(coach, '#open-board-btn')
    await coach.waitForSelector('#task-board[open] #board-columns > section')
    await openCardDetails(coach, drills)
    check(await visible(coach, `#board-task-required-${drills}`), 'the Required setting became unreachable')
    await openCardDetails(coach, examples)
    const shownReward = await coach.$eval(`#board-task-xp-reward-${examples}`, (el) => (el as HTMLInputElement).value)
    const shownRequired = await coach.$eval(`#board-task-required-${examples}`, (el) => (el as HTMLInputElement).checked)
    const shownTitle = await coach.$eval('#card-edit-title', (el) => (el as HTMLInputElement).value)
    check(shownReward === '15' && !shownRequired && shownTitle === 'Solved examples', `reopened details show stale Task values: reward ${shownReward}, required ${shownRequired}, title ${shownTitle}`)
    await closeSummaryBoard(coach)
    pass('AC2 required title with feedback; description; blank-title edit refused; Required→Enrichment and reward saved through the Draft and shown on the card; keyboard and pointer moves persist; Task Skills unchanged; Draft rules reachable')

    // ---- AC3: add, rename, reorder and remove columns; the last column stays; reload restores everything.
    await activate(coach, '#open-board-btn')
    await coach.waitForSelector('#board-save-status[data-state="saved"]')
    await activate(coach, '#board-add-column-btn')
    await coach.waitForSelector('#new-column-name', { visible: true })
    await activate(coach, '#new-column-submit')
    await coach.waitForSelector('#new-column-error', { visible: true })
    await coach.type('#new-column-name', 'Needs review')
    await coach.keyboard.press('Enter')
    await coach.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('#board-columns > section')].some((s) => s.dataset.name === 'Needs review'))
    board = await synced(coach, V)
    const review = board.find((c) => c.name === 'Needs review')!.id
    const ready = board.find((c) => c.name === 'Ready')!.id
    check(board.at(-1)!.id === review, 'a new column did not join the end of a board without a Completion Column')
    await activate(coach, `#column-menu-${ready}`)
    await setValue(coach, `#column-rename-${ready}`, 'Ready to teach')
    await activate(coach, `#column-rename-save-${ready}`)
    await activate(coach, `#column-menu-${review}`)
    await activate(coach, `#column-move-left-${review}`)
    board = await synced(coach, V)
    check(same(board.map((c) => c.name), ['Ideas', 'In preparation', 'Needs review', 'Ready to teach']), `rename/reorder: ${JSON.stringify(board.map((c) => c.name))}`)
    check(board.every((c) => !c.completion), 'a column gained a completion role')
    await coach.keyboard.press('Escape')
    // Removing a populated column moves its Tasks to the chosen column; nothing about learning or publication changes.
    await activate(coach, `#column-menu-${ready}`)
    await activate(coach, `#column-remove-${ready}`)
    await coach.waitForSelector('#remove-column-dialog', { visible: true })
    await coach.select('#remove-destination-select', review)
    check(!await coach.$('#remove-replacement-select') && (await coach.$$('#remove-consequences li')).length === 0, 'a Draft column removal offered completion changes')
    check(/no Task, rule, publication check or learner record changes/i.test(await coach.$eval('#remove-no-learning-change', (el) => (el as HTMLElement).innerText)), 'the removal does not explain its consequences')
    await activate(coach, '#remove-column-confirm')
    board = await synced(coach, V)
    check(same(arrangement(board), [`Ideas:${examples}`, 'In preparation:', `Needs review:${drills},${reading}`]), `removal into Needs review: ${JSON.stringify(arrangement(board))}`)
    await closeBoard(coach)
    // On the Matrices board, columns go down to one, which cannot be removed.
    await openBoard(coach, M)
    for (const name of ['Ready', 'In preparation']) {
      const id = await columnId(coach, name)
      await activate(coach, `#column-menu-${id}`)
      await activate(coach, `#column-remove-${id}`)
      await coach.waitForSelector('#remove-column-confirm', { visible: true })
      await activate(coach, '#remove-column-confirm')
      await coach.waitForFunction((gone) => !document.getElementById(`board-column-${gone}`), {}, id)
    }
    const only = (await synced(coach, M))
    check(same(arrangement(only), [`Ideas:${matrix}`]), `Matrices down to one column: ${JSON.stringify(arrangement(only))}`)
    await activate(coach, `#column-menu-${only[0].id}`)
    await activate(coach, `#column-remove-${only[0].id}`)
    await coach.waitForSelector('#remove-column-blocked', { visible: true })
    check(!await coach.$('#remove-column-confirm'), 'the last column could be removed')
    await activate(coach, '#btn-close-remove-column')
    await closeBoard(coach)
    const vBeforeReload = await storedBoard(V)
    await coach.reload({ waitUntil: 'networkidle0' })
    await coach.waitForSelector('#path-editor[data-gpu-status="ready"]', { timeout: 20000 })
    await openBoard(coach, V)
    check(same(arrangement(await shownBoard(coach)), arrangement(vBeforeReload)) && same((await shownBoard(coach)).map((c) => c.id), vBeforeReload.map((c) => c.id)), 'reload did not restore column order, names and membership')
    await closeBoard(coach)
    check(same(arrangement(await storedBoard(M)), [`Ideas:${matrix}`]), 'the Matrices board changed')
    pass('AC3 empty column name refused; add/rename/reorder persist; populated removal into a chosen column keeps every Task and explains no learning change; the last column cannot be removed; reload restores the board; roles never appear')

    // ---- AC4/AC5: readiness grants nothing; Version 1 and the learner's records are unchanged; others cannot reach the board.
    check(same(await learnerState(), learnerBefore), 'board changes altered the learner\'s learning state')
    check(same(await ok(learner, `/enrollments/${enrollment}/version`), enrolledBefore), 'board changes altered the learner\'s enrolled Version')
    check(same(await versionContent(v1.id), v1Before), 'board changes altered the published Version')
    for (const page of [learner]) {
      check((await api(page, boardRoute(V))).status === 404, 'a learner read the Draft board')
      check((await api(page, boardRoute(V), 'PUT', { expectedRevision: 0, columns: vBeforeReload })).status === 404, 'a learner saved the Draft board')
      check((await api(page, `${coachRoute}/draft`, 'PUT', { expectedRevision: 0, title: 'x', goal: '', editor: prepared.editor, application: prepared.application })).status === 404, 'a learner edited the Draft')
    }
    check((await api(coach, `${coachRoute}/drafts/${v1.id}/skills/${V}/board`)).status === 409, 'a published Version\'s board opened as a Draft board')
    check((await api(coach, boardRoute(V), 'PUT', { expectedRevision: 0, columns: [{ id: crypto.randomUUID(), name: 'Done', completion: true, taskIds: [drills, reading, examples] }] })).status === 422, 'a Draft board accepted a Completion Column')
    pass('AC4/AC5 Ready changes no learner XP, Approval, Mastery or enrolled Version; Version 1 unchanged; learners get 404 for the board and the Draft; a published Version is not a Draft board; no Completion Column role')

    // ---- AC7: eligible deletion with undo; published material archives, stays as history and a stale board cannot bring it back.
    const other = await newPage(browser, errors, { context: coachContext })
    current = other
    await open(other, `/coach/paths/${pathId}`)
    await openBoard(other, V)
    current = coach
    await coach.bringToFront()
    await openBoard(coach, V)
    await activate(coach, `#card-details-${examples}`)
    await activate(coach, '#card-delete-btn')
    await coach.waitForFunction((id) => !document.getElementById(`board-card-${id}`), {}, examples)
    await coach.waitForSelector('#save-status[data-state="saved"]')
    for (let i = 0; i < 50 && (await storedTasks(V)).some((t) => t.id === examples); i++) await pause(100)
    check(!(await storedTasks(V)).some((t) => t.id === examples), 'the deleted Task is still in the Draft')
    await activate(coach, '#board-undo-delete-btn')
    await coach.waitForSelector(`#board-card-${examples}`)
    board = await synced(coach, V)
    check(same(arrangement(board), [`Ideas:${examples}`, 'In preparation:', `Needs review:${drills},${reading}`]), `undo did not restore the Task in place: ${JSON.stringify(arrangement(board))}`)
    check((await storedTasks(V)).some((t) => t.id === examples), 'the undo was not saved through the Draft')
    await activate(coach, `#card-details-${reading}`)
    check(!await coach.$('#card-delete-btn'), 'a published Task can be deleted from the board')
    await activate(coach, `#board-task-archive-${reading}`)
    await activate(coach, `#board-task-archive-confirm-btn-${reading}`)
    await coach.waitForFunction((id) => !document.getElementById(`board-card-${id}`), {}, reading)
    await coach.waitForSelector('#save-status[data-state="saved"]')
    check(!(await storedTasks(V)).some((t) => t.id === reading) && !(await storedBoard(V)).some((c) => c.taskIds.includes(reading)), 'the archived Task stayed in the Draft or on its board')
    check(same(await versionContent(v1.id), v1Before) && same(await learnerState(), learnerBefore), 'archival changed Version 1 or the learner')
    // Archiving reloads the Draft (closing the board when it clears the selection); its history keeps the Task.
    await closeSummaryBoard(coach)
    await selectSkillFromList(coach, V)
    await openSkillView(coach, 'history')
    await coach.waitForSelector(`#retained-task-${reading}`)
    await openSkillView(coach, 'summary')
    // The other tab still shows the archived Task: its move conflicts, and reapplying cannot bring it back.
    current = other
    await other.bringToFront()
    await moveWithMenu(other, reading, 'In preparation')
    await other.waitForSelector('#board-conflict', { visible: true })
    await activate(other, '#board-reapply-btn')
    await other.waitForSelector('#board-unapplied', { visible: true })
    check(await other.$eval('#board-save-status', (el) => (el as HTMLElement).dataset.state) === 'unapplied', 'a move of an archived Task was not held back')
    await activate(other, '#board-discard-unapplied-btn')
    await synced(other, V)
    check(!(await storedBoard(V)).some((c) => c.taskIds.includes(reading)) && !(await storedTasks(V)).some((t) => t.id === reading), 'the archived Task came back through a stale board')
    await other.close()
    current = coach
    await coach.bringToFront()
    pass('AC7 eligible deletion saved and undone in place through Draft saves; a published Task archives instead, leaves the board and stays as history; Version 1 and the learner unchanged; a stale tab\'s move of it is held back and discarded, never resurrected')

    // ---- AC9: a failed board save keeps the change locally and only Retry with an answer calls it saved.
    await closeBoardIfOpen(coach)
    await openBoard(coach, V)
    const savedBoard = await storedBoard(V)
    const failing = (request: HTTPRequest) => {
      if (request.method() === 'PUT' && request.url().endsWith(`/skills/${V}/board`)) return request.abort('failed')
      return request.continue()
    }
    await coach.setRequestInterception(true)
    coach.on('request', failing)
    await moveWithMenu(coach, examples, 'In preparation')
    await coach.waitForSelector('#board-error[data-kind="failed"]', { visible: true })
    check((await shownBoard(coach)).find((c) => c.name === 'In preparation')!.taskIds.includes(examples), 'the failed change was not kept locally')
    check(await coach.$eval('#board-save-status', (el) => (el as HTMLElement).dataset.state) === 'failed', 'a failed save was called saved')
    coach.off('request', failing)
    await coach.setRequestInterception(false)
    check(same(await storedBoard(V), savedBoard), 'the failed save changed the stored board')
    await activate(coach, '#board-retry-btn')
    board = await synced(coach, V)
    check(board.find((c) => c.name === 'In preparation')!.taskIds.includes(examples), 'Retry did not save the kept change')
    await closeBoard(coach)
    pass('AC9 a failed save keeps the move shown as not saved, leaves the stored board unchanged, and Retry saves it')

    // ---- AC8: the separate Review entry reaches submitted work, hides the private draft and changes no preparation column.
    const boardsBeforeReview = { v: await storedBoard(V), m: await storedBoard(M) }
    const reviewPage = await newPage(browser, errors, { context: coachContext, noGpu: true })
    current = reviewPage
    await reviewPage.goto(`${ORIGIN}/coach/versions/${v1.id}`, { waitUntil: 'networkidle0' })
    check(!await reviewPage.$('#open-board-btn'), 'a published Version offers a preparation board')
    await activate(reviewPage, `#open-enrollment-${enrollment}`)
    await reviewPage.waitForSelector('#enrolled-version[data-gpu-status="unsupported"]')
    check(!await reviewPage.$('#open-board-btn'), 'the review context offers a board')
    await activate(reviewPage, '#btn-coach-review')
    await reviewPage.waitForSelector(`#awaiting-review-${drills}[data-revision-number="1"]`)
    await activate(reviewPage, `#awaiting-review-${drills}`)
    await reviewPage.waitForSelector(`#task-review-${drills}[data-target-revision="1"]`)
    check(!(await bodyText(reviewPage)).includes('PRIVATE draft'), 'the Coach sees the learner\'s private Submission Draft')
    await setValue(reviewPage, `#task-review-feedback-${drills}`, 'Correct vector addition')
    await activate(reviewPage, `#task-review-approve-${drills}`)
    await reviewPage.waitForSelector(`#task-review-${drills}[data-status="recorded"]`)
    check((await learnerState()).xp === 20, 'the Review did not award the published reward')
    check(same({ v: await storedBoard(V), m: await storedBoard(M) }, boardsBeforeReview), 'reviewing changed preparation columns')
    await reviewPage.close()
    current = coach
    pass('AC8 Review is reached from the published Version, never a board; it shows submitted work, not the private draft; the Approval awards Version 1\'s reward; preparation columns unchanged')

    // ---- AC10: narrow viewport, keyboard only, without WebGPU.
    // Its own browser, signed in as the Coach, so the identity switch below leaves the Coach's other tabs signed in.
    const narrow = await newPage(browser, errors, { noGpu: true, width: 390, height: 844 })
    current = narrow
    await authenticate(narrow, 'coach@ux04.test', false)
    await open(narrow, `/coach/paths/${pathId}`, 'unsupported')
    await openBoard(narrow, V)
    const columns = await shownBoard(narrow)
    check(await visible(narrow, '#board-column-select'), 'no column selector at a narrow viewport')
    const last = columns.at(-1)!
    await narrow.select('#board-column-select', last.id)
    await narrow.waitForFunction((id) => document.activeElement?.id === `board-column-heading-${id}`, {}, last.id)
    const inView = await narrow.$eval(`#board-column-heading-${last.id}`, (el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth })
    check(inView && await narrow.$eval('#board-columns', (el) => el.scrollLeft > 0), 'the column selector did not navigate horizontally')
    await narrow.screenshot({ path: path.join(FRONTEND, '..', '.harness', 'ux04-board-narrow.png') })
    await activate(narrow, `#card-details-${drills}`)
    const detailsWidth = await narrow.$eval('dialog[aria-label="Task details"]', (el) => el.getBoundingClientRect().width)
    check(Math.abs(detailsWidth - 390) < 2, `details are ${detailsWidth}px wide at a 390px viewport`)
    check(await visible(narrow, `#board-task-xp-reward-${drills}`), 'the reward is not reachable in narrow details')
    await narrow.keyboard.press('Escape')
    await narrow.waitForSelector('#card-edit-title', { hidden: true })
    check(await focusedId(narrow) === `card-details-${drills}`, `focus after closing details is on ${await focusedId(narrow)}`)
    await activate(narrow, '#board-add-column-btn')
    await narrow.waitForSelector('#new-column-name', { visible: true })
    await narrow.keyboard.type('Polish')
    await narrow.keyboard.press('Enter')
    await narrow.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('#board-columns > section')].some((s) => s.dataset.name === 'Polish'))
    await synced(narrow, V)
    await activate(narrow, `#card-move-${drills}`)
    await narrow.select(`#card-move-column-${drills}`, await columnId(narrow, 'Polish'))
    await activate(narrow, `#card-move-apply-${drills}`)
    check(await focusedId(narrow) === `card-move-${drills}`, 'focus did not follow the moved card')
    const narrowBoard = await synced(narrow, V)
    check(narrowBoard.find((c) => c.taskIds.includes(drills))!.name === 'Polish', 'the keyboard move went to the wrong column')
    await narrow.keyboard.press('Escape')
    await narrow.waitForSelector('#task-board', { hidden: true })
    check(await focusedId(narrow) === 'open-board-btn', `focus after Escape is on ${await focusedId(narrow)}`)
    pass('AC10 without WebGPU at 390px: column selector navigates and focuses the column; full-screen details keep the reward; keyboard add column and move persist; Escape closes with focus restored')

    // ---- AC9: identity switching in the same browser shows none of the Coach's Draft or board.
    await activate(narrow, '#btn-close-skill-details')
    await narrow.waitForSelector('#skill-detail-panel', { hidden: true })
    await activate(narrow, '#sign-out-btn')
    await narrow.waitForSelector('#sign-in-form')
    await setValue(narrow, '#email-input', 'learner@ux04.test')
    await setValue(narrow, '#password-input', PASSWORD)
    await activate(narrow, '#sign-in-btn')
    await narrow.waitForSelector('#personal-workspace')
    await narrow.goto(`${ORIGIN}/coach/paths/${pathId}`, { waitUntil: 'networkidle0' })
    await narrow.waitForSelector('#path-unavailable')
    const leaked = await bodyText(narrow)
    check(!/Solved examples|Needs review|Polish|Vector drills/.test(leaked) && !await narrow.$('#task-board'), 'another Account sees the Coach\'s Draft or board')
    check((await api(narrow, boardRoute(V))).status === 404, 'the switched Account reads the board')
    await narrow.close()
    pass('AC9 after switching to the learner in the same browser the Draft and its board are unavailable, with nothing of their content shown')

    // ---- AC4/AC5: publication follows the Draft's rules, not columns; published material and history are kept.
    current = coach
    await coach.bringToFront()
    await coach.reload({ waitUntil: 'networkidle0' })
    await coach.waitForSelector('#path-editor[data-gpu-status="ready"]', { timeout: 20000 })
    const finalBoard = await storedBoard(V)
    check(finalBoard.find((c) => c.name === 'Ideas')!.taskIds.includes(examples) || finalBoard.find((c) => c.name === 'In preparation')!.taskIds.includes(examples), 'expected a Task outside every "ready" column before publishing')
    await activate(coach, '#publish-version-btn')
    await coach.waitForSelector('#published-version[data-version-number="2"]', { timeout: 20000 })
    check(!await coach.$('#open-board-btn'), 'a published Version offers a preparation board')
    const published = await storedDoc()
    check(published.draft === null && published.versions.length === 2, 'the Draft was not published as Version 2')
    check((await api(coach, boardRoute(V))).status === 409, 'the published Draft\'s board is still editable')
    check(same(await versionContent(v1.id), v1Before), 'publishing changed Version 1')
    const v2 = await ok(coach, `/coach/learning-path-versions/${published.versions[1].id}`)
    check(!v2.application.skills.find((s: any) => s.id === V).tasks.some((t: any) => t.id === reading), 'the archived Task was published again')
    check(!JSON.stringify(v2).includes('Needs review') && !JSON.stringify(await ok(learner, `/enrollments/${enrollment}/version`)).includes('Needs review'), 'preparation columns leaked into a Version')
    const learnerAfter = await learnerState()
    check(learnerAfter.xp === 20 && same(await ok(learner, `/enrollments/${enrollment}/version`), enrolledBefore), 'publication moved the learner or changed their records')
    pass('AC4/AC5 publication succeeds with Tasks outside Ready (no column gate) and freezes the board; Version 1, the learner\'s Version and XP are unchanged; the archived Task is not republished')

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log('\nUX04 coach preparation board check passed.')
  } catch (error) {
    if (current) await current.screenshot({ path: path.join(FRONTEND, '..', '.harness', 'ux04-failure.png') }).catch(() => {})
    throw error
  } finally {
    await browser?.close()
    backend.kill()
    web.kill()
    resend.stop()
  }
}

async function closeBoardIfOpen(page: Page) {
  if (await visible(page, '#task-board')) await closeBoard(page)
}

if (import.meta.main) main().catch((error) => {
  console.error(error)
  process.exit(1)
})
