#!/usr/bin/env bun
/**
 * UX05 (#51, parent #46): a Learner's own Task Board for one Skill of their Enrollment on the
 * current build, against real Better Auth, the backend and an isolated migrated PostgreSQL.
 * Requires harness checks build and db-up; isolated ports 3599/3600 and database
 * gurow_ux05_browser_test make it eligible for parallel execution. Every learning and
 * evidence outcome is read back from the backend independently of what the board shows.
 *
 * Run from frontend: bun run scripts/ux05-learner-board-check.ts [--skip-build]
 *
 * AC1  Open the board from the enrolled Skill summary, return with the same camera; Backlog/To Do/In Progress/Done; per-Skill Tasks.
 * AC2  Add, rename, reorder, remove columns with a destination; keyboard and pointer moves; last column kept; reload restores; nothing else changes.
 * AC3  Done is organizational: no Submission, Approval, XP or Mastery; a locked Skill's card in Done stays locked and unsendable.
 * AC4  Work is sent only by the explicit action in the Task's details; private drafts never reach the Coach through the board.
 * AC5  Cards and the summary show the newest revision's status and an earlier still-valid Approval separately.
 * AC6  send → Changes Requested (Coach UI) → corrected send → Approval → newer pending → Approval Revocation; cards never move.
 * AC7  No Task authoring on the learner board; the Coach has no board; direct writes are refused.
 * AC8  First placement: a Task with a valid Approval starts in Done, the others in Backlog, in saved order.
 * AC9  Peer and other Skills untouched; failed and conflicting writes keep local intent; identity switching shows nothing.
 * AC10 Narrow viewport without WebGPU: column selector, full-width details, keyboard moves, visible review errors, draft recovery.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import puppeteer, { type Browser, type BrowserContext, type HTTPRequest, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'
import { openCoachReview, selectSkillFromList } from './editor-navigation'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = 3599
const API_PORT = 3600
const ORIGIN = `http://127.0.0.1:${PORT}`
const DATABASE_URL = 'postgres://gurow:gurow@127.0.0.1:5433/gurow_ux05_browser_test'
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
    server.once('error', (error) => reject(new Error(`UX05 requires unused port ${port}: ${error.message}`)))
    server.listen(port, '127.0.0.1', () => server.close((error) => error ? reject(error) : resolve()))
  })
}
async function newPage(browser: Browser, errors: string[], { noGpu = false, context = undefined as BrowserContext | undefined, width = 1440, height = 1000 } = {}) {
  const page = await (context ?? await browser.createBrowserContext()).newPage()
  page.setDefaultTimeout(15000)
  await page.setViewport({ width, height, deviceScaleFactor: 1 })
  page.on('pageerror', (error) => errors.push(String(error)))
  // Leaving with unsaved board changes asks first; a step that means to leave anyway marks the page with `leaving`.
  page.on('dialog', (dialog) => {
    if (dialog.type() === 'beforeunload' && leaving.has(page)) return void dialog.accept()
    errors.push(`unexpected ${dialog.type()} dialog`)
    void dialog.dismiss()
  })
  await page.evaluateOnNewDocument((unsupported) => {
    if (unsupported) Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true })
  }, noGpu)
  return page
}
const leaving = new WeakSet<Page>()
async function openEnrollment(page: Page, enrollmentId: string, gpu = 'ready') {
  await page.bringToFront()
  await page.goto(`${ORIGIN}/enrollments/${enrollmentId}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector(`#enrolled-version[data-gpu-status="${gpu}"]`, { timeout: 20000 })
}
const camera = (page: Page) => page.$eval('#labels-camera', (el) => getComputedStyle(el).transform)
const labelBox = (page: Page, id: string) => page.$eval(`#card-label-${id}`, (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width)] })

/** The board as shown: columns in order with their cards. */
const shownBoard = (page: Page): Promise<Column[]> => page.$$eval('#board-columns > section', (els) => els.map((el) => ({
  id: (el as HTMLElement).dataset.dropColumn!, name: (el as HTMLElement).dataset.name!, completion: (el as HTMLElement).dataset.completion === 'true',
  taskIds: [...el.querySelectorAll<HTMLElement>('[data-card-id]')].map((card) => card.dataset.cardId!),
})))
const arrangement = (columns: Column[]) => columns.map((c) => `${c.name}${c.completion ? '*' : ''}:${c.taskIds.join(',')}`)
/** A card's review facts as shown: the newest revision's status and the revisions whose Approval still counts. */
const cardReview = (page: Page, taskId: string, prefix = 'board-card-review') => page.$eval(`#${prefix}-${taskId}`, (el) => {
  const d = (el as HTMLElement).dataset
  return { latest: d.latest, revision: d.latestRevision ?? '', counting: d.countingApprovals ?? '', text: (el as HTMLElement).innerText }
})

async function openBoard(page: Page, skillId: string) {
  await selectSkillFromList(page, skillId)
  await activate(page, '#open-board-btn')
  await page.waitForSelector('#task-board[open] #board-columns > section')
  await page.waitForSelector('#board-save-status[data-state="saved"]')
}
async function closeBoard(page: Page) {
  if (await visible(page, '#btn-close-card-details')) await activate(page, '#btn-close-card-details')
  await activate(page, '#board-close-btn')
  await page.waitForSelector('#task-board', { hidden: true })
}

export async function main() {
  await portFree(PORT)
  await portFree(API_PORT)
  if (!process.argv.includes('--skip-build')) execFileSync('bun', ['run', 'build'], { cwd: FRONTEND, stdio: 'inherit' })
  execFileSync('bun', ['run', 'test/support/prepare-browser-database.ts'], { cwd: BACKEND, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: DATABASE_URL } })
  const resend = startResendStandIn()
  const backend = spawn('bun', ['run', 'src/index.ts'], { cwd: BACKEND, env: { ...process.env, DATABASE_URL, PORT: String(API_PORT), BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: 'ux05-browser-check-secret-not-for-production', NODE_ENV: 'test', RESEND_API_KEY: resend.apiKey, RESEND_API_URL: resend.url, MAIL_FROM: 'Gurow <invitations@gurow.test>' }, stdio: ['ignore', 'ignore', 'inherit'] })
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
    await authenticate(coach, 'coach@ux05.test')

    // ---- A published Version: Vectors (two Required Tasks, one Enrichment) and Matrices behind Vectors' Mastery.
    const uuid = () => crypto.randomUUID()
    const [V, M] = [uuid(), uuid()]
    const [drills, proofs, reading, matrix] = [uuid(), uuid(), uuid(), uuid()]
    const workspace = (await ok(coach, '/coach/workspaces', 'POST', { name: 'UX05 studio' })).workspace
    const created = await ok(coach, `/coach/workspaces/${workspace.id}/learning-paths`, 'POST', { title: 'Coached algebra', goal: 'Explain linear maps' })
    const pathId = created.learningPath.id as string
    const coachRoute = `/coach/learning-paths/${pathId}`
    const seeded = await ok(coach, `${coachRoute}/draft`, 'PUT', {
      expectedRevision: created.learningPath.revision, title: 'Coached algebra', goal: 'Explain linear maps',
      editor: { format_version: 1, cards: [{ id: V, title: 'Vectors', position: { x: 120, y: 140 } }, { id: M, title: 'Matrices', position: { x: 460, y: 140 } }], connections: [{ from_id: V, to_id: M }] },
      application: { skills: [
        { id: V, title: 'Vectors', outcome: 'Add vectors confidently', optional: false, xpThreshold: 0, tasks: [
          { id: drills, title: 'Vector drills', description: 'Show your calculation', required: true, xpReward: 20 },
          { id: proofs, title: 'Vector proofs', description: 'Prove the laws', required: true, xpReward: 10 },
          { id: reading, title: 'Read chapter 1', description: 'Summarize it', required: false, xpReward: 5 },
        ] },
        { id: M, title: 'Matrices', outcome: 'Compose linear maps', optional: false, xpThreshold: 0, tasks: [{ id: matrix, title: 'Matrix drills', description: '', required: true, xpReward: 10 }] },
      ] },
    })
    const v1 = (await ok(coach, `${coachRoute}/publication`, 'POST', { expectedRevision: seeded.learningPath.revision })).version
    const learnerContext = await browser.createBrowserContext()
    let learner = await newPage(browser, errors, { context: learnerContext })
    await authenticate(learner, 'learner@ux05.test')
    const peerContext = await browser.createBrowserContext()
    const peer = await newPage(browser, errors, { context: peerContext })
    await authenticate(peer, 'peer@ux05.test')
    const join = async (page: Page, email: string) => {
      const before = resend.sent.length
      await ok(coach, `/coach/learning-path-versions/${v1.id}/invitations`, 'POST', { email })
      const invitationId = new URL(await emailLink(email, 'You are invited', before)).pathname.split('/').at(-1)!
      return (await ok(page, `/invitations/${invitationId}/accept`, 'POST')).enrollment.id as string
    }
    const enrollment = await join(learner, 'learner@ux05.test')
    const peerEnrollment = await join(peer, 'peer@ux05.test')
    const taskRoute = (task: string) => `/enrollments/${enrollment}/tasks/${task}`
    const boardRoute = (skillId: string, id = enrollment) => `/enrollments/${id}/skills/${skillId}/board`
    const storedBoard = async (skillId: string, page = learner, id = enrollment): Promise<Column[]> => (await ok(page, boardRoute(skillId, id))).board.columns
    const learnerState = async () => (await ok(learner, `/enrollments/${enrollment}/learning-state`)).learningState
    const reviewOf = async (task: string) => (await learnerState()).taskReviews.find((r: any) => r.taskId === task) ?? null
    const enrolledBefore = await ok(learner, `/enrollments/${enrollment}/version`)
    const revisionsOf = async (task: string) => (await ok(learner, `${taskRoute(task)}/submission`)).submission.revisions as { id: string; revisionNumber: number; status: string }[]
    // Before the board exists: the drills were approved, then a newer revision is pending; Matrices holds a private draft.
    await ok(learner, `${taskRoute(drills)}/submission/revisions`, 'POST', { text: 'Sent: (1, 2) + (2, 3) = (3, 5)', urls: [] })
    await ok(coach, `${taskRoute(drills)}/submission/revisions/${(await revisionsOf(drills))[0].id}/review`, 'POST', { decision: 'approval' })
    await ok(learner, `${taskRoute(drills)}/submission/revisions`, 'POST', { text: 'Sent again with the working shown', urls: [] })
    await ok(learner, `${taskRoute(matrix)}/draft`, 'PUT', { text: 'PRIVATE matrix plan the Coach must not see', urls: [] })

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
    /** Sends the Task's work through the explicit action in its board details; only the backend's confirmation counts. */
    async function sendFromDetails(page: Page, taskId: string, text: string, revisionNumber: number) {
      await activate(page, `#card-details-${taskId}`)
      await page.waitForSelector(`#task-work-${taskId}[data-draft-state="ready"]`)
      await setValue(page, `#task-work-text-${taskId}`, text)
      await activate(page, `#task-work-send-${taskId}`)
      await page.waitForSelector(`#task-work-${taskId}[data-status="sent"][data-sent-revision="${revisionNumber}"]`)
      await activate(page, '#btn-close-card-details')
    }
    /** Reopens the board, which reads the learning records again, as returning to it does. */
    async function reopenBoard(page: Page, skillId: string) {
      await closeBoard(page)
      await activate(page, '#open-board-btn')
      await page.waitForSelector('#task-board[open] #board-columns > section')
      await page.waitForSelector('#board-save-status[data-state="saved"]')
      await page.waitForSelector('#enrollment-records[data-reading="false"]')
      void skillId
    }

    // ---- AC1/AC8: open from the enrolled summary at a changed camera; initial columns and placement; return keeps the camera.
    const stateBefore = await learnerState()
    await openEnrollment(learner, enrollment)
    const canvas = await learner.$eval('#editor-canvas', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
    await learner.mouse.move(canvas.x + 200, canvas.y + 200)
    await learner.keyboard.down('Control')
    await learner.mouse.wheel({ deltaY: -30 })
    await learner.keyboard.up('Control')
    await learner.mouse.wheel({ deltaX: 60, deltaY: -40 })
    await learner.waitForFunction(() => getComputedStyle(document.querySelector('#labels-camera')!).transform !== 'matrix(1, 0, 0, 1, 0, 0)')
    await pause(300)
    const cameraBefore = await camera(learner)
    const labelBefore = await labelBox(learner, V)
    await selectSkillFromList(learner, V)
    await activate(learner, '#open-board-btn')
    await learner.waitForSelector('#task-board[open] #board-columns > section')
    await learner.waitForSelector('#board-save-status[data-state="saved"]')
    let board = await shownBoard(learner)
    check(same(board.map((c) => [c.name, c.completion]), [['Backlog', false], ['To Do', false], ['In Progress', false], ['Done', false]]), `initial columns ${JSON.stringify(board)}`)
    check(same(arrangement(board), [`Backlog:${proofs},${reading}`, 'To Do:', 'In Progress:', `Done:${drills}`]), `initial placement ${JSON.stringify(arrangement(board))}`)
    check(!/Completion Column/i.test(await learner.$eval('#task-board', (el) => (el as HTMLElement).innerText)), 'a learner board shows a Completion Column')
    check(/sends nothing and changes no Review, Approval, XP or Mastery/i.test(await learner.$eval('#board-note', (el) => (el as HTMLElement).innerText)), 'the board does not say what its columns mean')
    await learner.waitForFunction((id) => document.getElementById(`board-card-review-${id}`)?.dataset.latest === 'pending', {}, drills)
    const drillsReview = await cardReview(learner, drills)
    check(drillsReview.revision === '2' && drillsReview.counting === '1' && /Revision 2 awaiting Review/.test(drillsReview.text) && /Approval of Revision 1 still counts/.test(drillsReview.text), `the newer pending revision and the earlier Approval are not told apart: ${JSON.stringify(drillsReview)}`)
    check((await cardReview(learner, reading)).latest === 'not-sent', 'an unsent Task does not say so')
    check(/Required · 20 XP/.test(await learner.$eval(`#board-card-${drills}`, (el) => (el as HTMLElement).innerText)) && /Enrichment · 5 XP/.test(await learner.$eval(`#board-card-${reading}`, (el) => (el as HTMLElement).innerText)), 'cards lost the Required/Enrichment designation or reward')
    check(same(await learnerState(), stateBefore), 'opening the board changed the learning records')
    await closeBoard(learner)
    check(await focusedId(learner) === 'open-board-btn', `focus after closing the board is on ${await focusedId(learner)}`)
    check(await camera(learner) === cameraBefore && same(await labelBox(learner, V), labelBefore), 'returning from the board changed the camera')
    await openBoard(learner, M)
    check(same(arrangement(await shownBoard(learner)), [`Backlog:${matrix}`, 'To Do:', 'In Progress:', 'Done:']), 'the Matrices board does not hold only its own Task')
    await closeBoard(learner)
    pass('AC1/AC8 Open board from the enrolled summary: Backlog/To Do/In Progress/Done; the approved Task starts in Done, the others in Backlog in saved order; its newer pending revision and earlier Approval shown apart; records unchanged; camera and focus restored; Matrices shows its own Task')

    // ---- AC7: the learner cannot author Tasks here; the Coach has no board and cannot read the learner's.
    await openBoard(learner, V)
    check((await learner.$$('[id^="add-card-"]')).length === 0, 'the learner board offers adding a Task')
    await activate(learner, `#card-details-${proofs}`)
    await learner.waitForSelector('#card-details', { visible: true })
    check(!await learner.$('#card-edit-title') && !await learner.$('#card-delete-btn') && !await learner.$('[id^="board-task-archive-"]'), 'a learner can edit, delete or archive an official Task')
    check(await learner.$eval('#card-definition-title', (el) => el.textContent) === 'Vector proofs', 'the official Task definition is not shown read-only')
    check(await visible(learner, `#task-work-send-${proofs}`), 'the explicit send action is not in the Task details')
    await activate(learner, '#btn-close-card-details')
    check((await api(learner, boardRoute(V), 'PUT', { expectedRevision: 0, columns: [...(await storedBoard(V)).map((c, i) => (i === 0 ? { ...c, taskIds: [...c.taskIds, uuid()] } : c))] })).body?.error === 'board_task_unknown', 'a private Task was accepted on the board')
    check((await api(learner, `${coachRoute}/draft`, 'PUT', { expectedRevision: 0, title: 'x', goal: '', editor: seeded.editor, application: seeded.application })).status === 404, 'a learner edited the Path\'s Draft')
    check((await api(coach, boardRoute(V))).status === 403 && (await api(coach, boardRoute(V), 'PUT', { expectedRevision: 0, columns: [] })).status === 403, 'the Coach reached the learner\'s board')
    check((await api(peer, boardRoute(V))).status === 404, 'a peer reached the learner\'s board')
    await closeBoard(learner)
    pass('AC7 no Add Task, edit, delete or archival on the learner board; the official definition is read-only beside the explicit send; private Tasks and Draft edits are refused; the Coach gets 403 and a peer 404 for the board')

    // ---- AC2: keyboard and pointer moves; add, rename, reorder and remove columns; reload restores; nothing else changes.
    await openBoard(learner, V)
    await moveWithMenu(learner, reading, 'In Progress')
    check(await focusedId(learner) === `card-move-${reading}`, 'focus did not follow the moved card')
    board = await synced(learner, V)
    check(same(board.find((c) => c.name === 'In Progress')!.taskIds, [reading]), `keyboard move: ${JSON.stringify(arrangement(board))}`)
    await activate(learner, `#card-move-${reading}`)
    await dragCard(learner, proofs, await columnId(learner, 'To Do'))
    board = await synced(learner, V)
    check(same(board.find((c) => c.name === 'To Do')!.taskIds, [proofs]), `pointer drag: ${JSON.stringify(arrangement(board))}`)
    await activate(learner, '#board-add-column-btn')
    await learner.waitForSelector('#new-column-name', { visible: true })
    await activate(learner, '#new-column-submit')
    await learner.waitForSelector('#new-column-error', { visible: true })
    await learner.type('#new-column-name', 'Blocked')
    await learner.keyboard.press('Enter')
    await learner.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('#board-columns > section')].some((s) => s.dataset.name === 'Blocked'))
    board = await synced(learner, V)
    const blocked = board.find((c) => c.name === 'Blocked')!.id
    const done = board.find((c) => c.name === 'Done')!.id
    check(board.at(-1)!.id === blocked, 'a new column did not join the end of a board without roles')
    await activate(learner, `#column-menu-${done}`)
    await setValue(learner, `#column-rename-${done}`, 'Finished')
    await activate(learner, `#column-rename-save-${done}`)
    await activate(learner, `#column-menu-${blocked}`)
    await activate(learner, `#column-move-left-${blocked}`)
    board = await synced(learner, V)
    check(same(board.map((c) => c.name), ['Backlog', 'To Do', 'In Progress', 'Blocked', 'Finished']) && board.every((c) => !c.completion), `rename/reorder: ${JSON.stringify(board.map((c) => c.name))}`)
    await learner.keyboard.press('Escape')
    const toDo = board.find((c) => c.name === 'To Do')!.id
    await activate(learner, `#column-menu-${toDo}`)
    await activate(learner, `#column-remove-${toDo}`)
    await learner.waitForSelector('#remove-column-dialog', { visible: true })
    await learner.select('#remove-destination-select', blocked)
    check(!await learner.$('#remove-replacement-select') && (await learner.$$('#remove-consequences li')).length === 0, 'a learner column removal offered completion changes')
    check(/nothing is sent, and no Review, Approval, XP or Mastery changes/i.test(await learner.$eval('#remove-no-learning-change', (el) => (el as HTMLElement).innerText)), 'the removal does not explain its consequences')
    await activate(learner, '#remove-column-confirm')
    board = await synced(learner, V)
    check(same(arrangement(board), ['Backlog:', `In Progress:${reading}`, `Blocked:${proofs}`, `Finished:${drills}`]), `removal into Blocked: ${JSON.stringify(arrangement(board))}`)
    await closeBoard(learner)
    // ---- AC3: a locked Skill's card in Done stays locked; nothing can be sent; the private draft never reaches the Coach.
    await openBoard(learner, M)
    await moveWithMenu(learner, matrix, 'Done')
    await synced(learner, M)
    check(await learner.$eval('#board-skill-access', (el) => (el as HTMLElement).dataset.access) === 'locked', 'the locked Skill is not shown as locked on its board')
    await activate(learner, `#card-details-${matrix}`)
    await learner.waitForSelector(`#task-work-${matrix}[data-draft-state="ready"]`)
    check(await learner.$eval(`#task-work-${matrix}`, (el) => (el as HTMLElement).dataset.canSend) === 'false', 'a locked Task can be sent from the board')
    await activate(learner, '#btn-close-card-details')
    await closeBoard(learner)
    const locked = (await learnerState()).skills.find((s: any) => s.skillId === M)
    check(!locked.access && !locked.mastery, 'placement changed the locked Skill')
    check((await api(coach, `${taskRoute(matrix)}/draft`)).status === 403 && (await api(coach, `${taskRoute(matrix)}/submission`)).status === 404, 'the Coach reaches the private draft or a Submission that was never sent')
    pass('AC3 the locked Skill\'s board says Locked; its Task cannot be sent from the details; Access and Mastery unchanged; the Coach still cannot read the private draft and finds no Submission')

    // The Matrices board goes down to one column, which cannot be removed.
    await openBoard(learner, M)
    for (const name of ['Done', 'In Progress', 'To Do']) {
      const id = await columnId(learner, name)
      await activate(learner, `#column-menu-${id}`)
      await activate(learner, `#column-remove-${id}`)
      await learner.waitForSelector('#remove-column-confirm', { visible: true })
      await activate(learner, '#remove-column-confirm')
      await learner.waitForFunction((gone) => !document.getElementById(`board-column-${gone}`), {}, id)
    }
    const only = await synced(learner, M)
    check(same(arrangement(only), [`Backlog:${matrix}`]), `Matrices down to one column: ${JSON.stringify(arrangement(only))}`)
    await activate(learner, `#column-menu-${only[0].id}`)
    await activate(learner, `#column-remove-${only[0].id}`)
    await learner.waitForSelector('#remove-column-blocked', { visible: true })
    check(!await learner.$('#remove-column-confirm'), 'the last column could be removed')
    await activate(learner, '#btn-close-remove-column')
    await closeBoard(learner)
    const vBeforeReload = await storedBoard(V)
    await learner.reload({ waitUntil: 'networkidle0' })
    await learner.waitForSelector('#enrolled-version[data-gpu-status="ready"]', { timeout: 20000 })
    await openBoard(learner, V)
    check(same(arrangement(await shownBoard(learner)), arrangement(vBeforeReload)) && same((await shownBoard(learner)).map((c) => c.id), vBeforeReload.map((c) => c.id)), 'reload did not restore column order, names and membership')
    await closeBoard(learner)
    check(same(await learnerState(), stateBefore), 'arranging the boards changed the learning records')
    check(same(arrangement(await storedBoard(V, peer, peerEnrollment)), [`Backlog:${drills},${proofs},${reading}`, 'To Do:', 'In Progress:', 'Done:']), 'the peer\'s board was affected or misplaced')
    check(same(await ok(learner, `/enrollments/${enrollment}/version`), enrolledBefore), 'arranging changed the enrolled Version')
    pass('AC2 keyboard and pointer moves; empty column name refused; add/rename/reorder persist; populated removal into a chosen column keeps every Task and says nothing is sent; the last column cannot be removed; reload restores; records, enrolled Version and the peer\'s board unchanged')

    // ---- AC4/AC5/AC6: explicit sends from the board, Review outcomes from the Coach, and cards that never move.
    await openBoard(learner, V)
    await moveWithMenu(learner, reading, 'Finished')
    board = await synced(learner, V)
    const settled = await storedBoard(V)
    check(same(settled.find((c) => c.name === 'Finished')!.taskIds, [drills, reading]), `reading is not in Finished: ${JSON.stringify(arrangement(settled))}`)
    check((await reviewOf(reading)) === null && same(await learnerState(), stateBefore), 'moving into a Done column sent work or changed records')
    await sendFromDetails(learner, reading, 'Chapter 1 summary, first attempt', 1)
    await learner.waitForFunction((id) => document.getElementById(`board-card-review-${id}`)?.dataset.latest === 'pending', {}, reading)
    check(same(await storedBoard(V), settled), 'sending moved a card')
    // The Coach requests changes through the Review entry point, which offers no board.
    const reviewPage = await newPage(browser, errors, { context: coachContext, noGpu: true })
    current = reviewPage
    await reviewPage.goto(`${ORIGIN}/coach/versions/${v1.id}`, { waitUntil: 'networkidle0' })
    await activate(reviewPage, `#open-enrollment-${enrollment}`)
    await reviewPage.waitForSelector('#enrolled-version[data-gpu-status="unsupported"]')
    await selectSkillFromList(reviewPage, V)
    check(!await reviewPage.$('#open-board-btn'), 'the Coach\'s Review context offers a board')
    await openCoachReview(reviewPage)
    await reviewPage.waitForSelector(`#awaiting-review-${reading}[data-revision-number="1"]`)
    await activate(reviewPage, `#awaiting-review-${reading}`)
    await reviewPage.waitForSelector(`#task-review-${reading}[data-target-revision="1"]`)
    const coachText = await bodyText(reviewPage)
    check(!coachText.includes('PRIVATE matrix plan') && !/Blocked|Finished/.test(coachText), 'the Coach sees the learner\'s private draft or board columns')
    await setValue(reviewPage, `#task-review-feedback-${reading}`, 'Summarize sections 1.2 and 1.3 too')
    await activate(reviewPage, `#task-review-request-changes-${reading}`)
    await reviewPage.waitForSelector(`#task-review-${reading}[data-status="recorded"]`)
    await reviewPage.close()
    current = learner
    await learner.bringToFront()
    await reopenBoard(learner, V)
    await learner.waitForFunction((id) => document.getElementById(`board-card-review-${id}`)?.dataset.latest === 'changes_requested', {}, reading)
    check((await shownBoard(learner)).find((c) => c.name === 'Finished')!.taskIds.includes(reading) && same(await storedBoard(V), settled), 'Changes Requested moved the card out of Finished')
    // Corrected send → Approval: XP follows the evidence, not the column.
    await sendFromDetails(learner, reading, 'Chapter 1 summary, all sections', 2)
    const revisions = await revisionsOf(reading)
    await ok(coach, `${taskRoute(reading)}/submission/revisions/${revisions[1].id}/review`, 'POST', { decision: 'approval' })
    await reopenBoard(learner, V)
    await learner.waitForFunction((id) => document.getElementById(`board-card-review-${id}`)?.dataset.latest === 'approval', {}, reading)
    check((await learnerState()).xp === 25 && await learner.$eval('#board-enrollment-xp', (el) => (el as HTMLElement).dataset.xp) === '25', 'the Approval did not award the reward')
    // A newer pending revision does not inherit the Approval, which still counts.
    await sendFromDetails(learner, reading, 'Chapter 1 summary with diagrams', 3)
    await learner.waitForFunction((id) => document.getElementById(`board-card-review-${id}`)?.dataset.latest === 'pending', {}, reading)
    const newer = await cardReview(learner, reading)
    check(newer.revision === '3' && newer.counting === '2' && /Approval of Revision 2 still counts/.test(newer.text), `newer pending and still-valid Approval not distinct: ${JSON.stringify(newer)}`)
    check(same(await reviewOf(reading), { taskId: reading, sentRevisions: 3, latestRevisionNumber: 3, latestStatus: 'pending', approvedRevisionNumbers: [2] }) && (await learnerState()).xp === 25, 'the stored review state or XP is wrong for a newer pending revision')
    // Approval Revocation: the evidence goes, the card stays.
    await ok(coach, `${taskRoute(reading)}/submission/revisions/${revisions[1].id}/review/revoke`, 'POST', { reason: 'Summary copied from the book' })
    await reopenBoard(learner, V)
    await learner.waitForFunction((id) => document.getElementById(`board-card-review-${id}`)?.dataset.countingApprovals === '', {}, reading)
    check((await cardReview(learner, reading)).latest === 'pending' && (await learnerState()).xp === 20, 'the revocation is not shown or XP not corrected')
    check(same(await storedBoard(V), settled) && same(arrangement(await shownBoard(learner)), arrangement(settled)), 'a Review outcome moved a card')
    await closeBoard(learner)
    // The Skill summary shows the same two facts.
    await learner.waitForSelector(`#summary-review-state-${reading}`)
    const summary = await cardReview(learner, reading, 'summary-review-state')
    check(summary.latest === 'pending' && summary.revision === '3' && summary.counting === '', `the summary review state is wrong: ${JSON.stringify(summary)}`)
    const drillsSummary = await cardReview(learner, drills, 'summary-review-state')
    check(drillsSummary.latest === 'pending' && drillsSummary.counting === '1', `the summary does not keep the earlier Approval apart: ${JSON.stringify(drillsSummary)}`)
    pass('AC4/AC5/AC6 work is sent only from the details; send → Changes Requested (Coach UI, no board there) → corrected send → Approval (+5 XP) → newer pending (earlier Approval still counts) → revocation (XP corrected); the card stays in Finished throughout; cards and summary show both facts')

    // ---- AC9: a failed save keeps the change locally; a competing tab conflicts and reapplies; other contexts are untouched.
    await openBoard(learner, V)
    const savedBoard = await storedBoard(V)
    const failing = (request: HTTPRequest) => {
      if (request.method() === 'PUT' && request.url().endsWith(`/skills/${V}/board`)) return request.abort('failed')
      return request.continue()
    }
    await learner.setRequestInterception(true)
    learner.on('request', failing)
    await moveWithMenu(learner, proofs, 'Backlog')
    await learner.waitForSelector('#board-error[data-kind="failed"]', { visible: true })
    check((await shownBoard(learner)).find((c) => c.name === 'Backlog')!.taskIds.includes(proofs), 'the failed change was not kept locally')
    check(await learner.$eval('#board-save-status', (el) => (el as HTMLElement).dataset.state) === 'failed', 'a failed save was called saved')
    learner.off('request', failing)
    await learner.setRequestInterception(false)
    check(same(await storedBoard(V), savedBoard), 'the failed save changed the stored board')
    await activate(learner, '#board-retry-btn')
    board = await synced(learner, V)
    check(board.find((c) => c.name === 'Backlog')!.taskIds.includes(proofs), 'Retry did not save the kept change')
    // A failed change survives a reload of its tab, even while another tab of the same learner saves its own change:
    // restored as not saved, never sent on its own, and reapplied onto the newer board by the learner.
    await learner.setRequestInterception(true)
    learner.on('request', failing)
    await moveWithMenu(learner, reading, 'In Progress')
    await learner.waitForSelector('#board-error[data-kind="failed"]', { visible: true })
    learner.off('request', failing)
    await learner.setRequestInterception(false)
    const tabA = await newPage(browser, errors, { context: learnerContext })
    current = tabA
    await openEnrollment(tabA, enrollment)
    await openBoard(tabA, V)
    // The other tab's own change fails first (it keeps it too), then its Retry is accepted and it forgets its own.
    await tabA.setRequestInterception(true)
    tabA.on('request', failing)
    await moveWithMenu(tabA, proofs, 'In Progress')
    await tabA.waitForSelector('#board-error[data-kind="failed"]', { visible: true })
    tabA.off('request', failing)
    await tabA.setRequestInterception(false)
    await activate(tabA, '#board-retry-btn')
    const afterTabA = await synced(tabA, V)
    check(await tabA.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('gurow:board-intents:')).length) === 0, 'the other tab kept intents after its save was accepted')
    await tabA.close()
    current = learner
    await learner.bringToFront()
    let boardSaves = 0
    const countSaves = (request: HTTPRequest) => { if (request.method() === 'PUT' && request.url().endsWith(`/skills/${V}/board`)) boardSaves++ }
    leaving.add(learner)
    await learner.reload({ waitUntil: 'networkidle0' })
    leaving.delete(learner)
    learner.on('request', countSaves)
    await learner.waitForSelector('#enrolled-version[data-gpu-status="ready"]', { timeout: 20000 })
    await selectSkillFromList(learner, V)
    await learner.waitForSelector('#board-kept-note', { visible: true })
    await activate(learner, '#open-board-btn')
    await learner.waitForSelector('#board-conflict[data-restored="true"]', { visible: true })
    check(/kept in this tab from before the page was reloaded/.test(await learner.$eval('#board-conflict', (el) => (el as HTMLElement).innerText)), 'the restored change does not say where it came from')
    check((await shownBoard(learner)).find((c) => c.name === 'In Progress')!.taskIds.includes(reading), 'the failed change was lost on reload after the other tab saved')
    check(boardSaves === 0 && same(arrangement(await storedBoard(V)), arrangement(afterTabA)), 'a restored change was sent without the learner deciding')
    learner.off('request', countSaves)
    await activate(learner, '#board-reapply-btn')
    board = await synced(learner, V)
    const progress = board.find((c) => c.name === 'In Progress')!.taskIds
    check(progress.includes(reading) && progress.includes(proofs), `reapplying the restored change lost a side: ${JSON.stringify(arrangement(board))}`)
    check(await learner.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('gurow:board-intents:')).length) === 0, 'saved intents stayed in the tab\'s storage')
    await moveWithMenu(learner, reading, 'Finished')
    await synced(learner, V)
    // A save made elsewhere (another tab of the same learner) makes this tab's next move stale.
    const elsewhere = await storedBoard(V)
    const revisionNow = (await ok(learner, boardRoute(V))).board.revision as number
    const moved = elsewhere.map((c) => ({ ...c, taskIds: c.name === 'Blocked' ? [...c.taskIds, proofs] : c.taskIds.filter((id) => id !== proofs) }))
    await ok(learner, boardRoute(V), 'PUT', { expectedRevision: revisionNow, columns: moved })
    await moveWithMenu(learner, drills, 'In Progress')
    await learner.waitForSelector('#board-conflict', { visible: true })
    check(await learner.$eval('#board-save-status', (el) => (el as HTMLElement).dataset.state) === 'conflict', 'a stale save was not reported as a conflict')
    check(same(await storedBoard(V), moved), 'the stale save changed the stored board')
    await activate(learner, '#board-reapply-btn')
    const reapplied = await synced(learner, V)
    check(reapplied.find((c) => c.name === 'Blocked')!.taskIds.includes(proofs) && reapplied.find((c) => c.name === 'In Progress')!.taskIds.includes(drills), `reapplying lost a side: ${JSON.stringify(arrangement(reapplied))}`)
    await closeBoard(learner)
    check(same(arrangement(await storedBoard(M)), [`Backlog:${matrix}`]) && same(arrangement(await storedBoard(V, peer, peerEnrollment)), [`Backlog:${drills},${proofs},${reading}`, 'To Do:', 'In Progress:', 'Done:']), 'another Skill\'s or the peer\'s board changed')
    pass('AC9/AC10 a failed save keeps the move shown as not saved and Retry saves it; after a reload of its tab, while another tab saved its own change, it is restored as not saved, not sent on its own, and reapplied with both changes kept; a move based on a board changed elsewhere conflicts, changes nothing, and is reapplied onto the newer board; the other Skill and the peer are untouched')

    // ---- AC10: narrow viewport without WebGPU: column selector, full-width details with the private draft, recovery after reload, visible review errors.
    const narrowContext = await browser.createBrowserContext()
    const narrow = await newPage(browser, errors, { noGpu: true, width: 390, height: 844, context: narrowContext })
    current = narrow
    await authenticate(narrow, 'learner@ux05.test', false)
    await openEnrollment(narrow, enrollment, 'unsupported')
    await openBoard(narrow, V)
    const columns = await shownBoard(narrow)
    check(await visible(narrow, '#board-column-select'), 'no column selector at a narrow viewport')
    const last = columns.at(-1)!
    await narrow.select('#board-column-select', last.id)
    await narrow.waitForFunction((id) => document.activeElement?.id === `board-column-heading-${id}`, {}, last.id)
    const inView = await narrow.$eval(`#board-column-heading-${last.id}`, (el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth })
    check(inView && await narrow.$eval('#board-columns', (el) => el.scrollLeft > 0), 'the column selector did not navigate horizontally')
    await narrow.screenshot({ path: path.join(FRONTEND, '..', '.harness', 'ux05-board-narrow.png') })
    await activate(narrow, `#card-details-${proofs}`)
    const detailsWidth = await narrow.$eval('dialog[aria-label="Task details"]', (el) => el.getBoundingClientRect().width)
    check(Math.abs(detailsWidth - 390) < 2, `details are ${detailsWidth}px wide at a 390px viewport`)
    await narrow.waitForSelector(`#task-work-${proofs}[data-draft-state="ready"]`)
    await setValue(narrow, `#task-work-text-${proofs}`, 'UNSENT proof sketch')
    await narrow.waitForSelector(`#task-work-${proofs}[data-kept-locally="true"]`)
    await narrow.keyboard.press('Escape')
    await narrow.waitForSelector('#card-details', { hidden: true })
    check(await focusedId(narrow) === `card-details-${proofs}`, `focus after closing details is on ${await focusedId(narrow)}`)
    await activate(narrow, `#card-move-${proofs}`)
    await narrow.select(`#card-move-column-${proofs}`, await columnId(narrow, 'Finished'))
    await activate(narrow, `#card-move-apply-${proofs}`)
    check(await focusedId(narrow) === `card-move-${proofs}`, 'focus did not follow the moved card')
    check((await synced(narrow, V)).find((c) => c.taskIds.includes(proofs))!.name === 'Finished', 'the keyboard move went to the wrong column')
    check((await reviewOf(proofs)) === null, 'moving into Finished sent the unsent work')
    await narrow.keyboard.press('Escape')
    await narrow.waitForSelector('#task-board', { hidden: true })
    check(await focusedId(narrow) === 'open-board-btn', `focus after Escape is on ${await focusedId(narrow)}`)
    // The unsent draft edits survive a reload under this Account, and stay unsent.
    await narrow.reload({ waitUntil: 'networkidle0' })
    await narrow.waitForSelector('#enrolled-version[data-gpu-status="unsupported"]', { timeout: 20000 })
    await openBoard(narrow, V)
    await activate(narrow, `#card-details-${proofs}`)
    await narrow.waitForSelector(`#task-work-recovered-${proofs}`)
    check(await narrow.$eval(`#task-work-text-${proofs}`, (el) => (el as HTMLTextAreaElement).value) === 'UNSENT proof sketch', 'unsent draft edits were lost on reload')
    await activate(narrow, '#btn-close-card-details')
    await closeBoard(narrow)
    // A failed read of the learning records is shown on the board rather than stale review state passing silently.
    const failingRecords = (request: HTTPRequest) => request.url().includes('/learning-state') ? request.abort('failed') : request.continue()
    await narrow.setRequestInterception(true)
    narrow.on('request', failingRecords)
    await activate(narrow, '#open-board-btn')
    await narrow.waitForSelector('#board-records-error', { visible: true })
    narrow.off('request', failingRecords)
    await narrow.setRequestInterception(false)
    await closeBoard(narrow)
    pass('AC10 without WebGPU at 390px: column selector navigates and focuses the column; full-width details hold the private draft; keyboard move persists without sending; unsent edits survive reload; a failed records read is visible on the board; Escape restores focus')

    // ---- AC9: identity switching in the same browser shows none of the learner's board, kept changes or draft.
    // A failed change is left kept in this browser before the learner signs out.
    const failingNarrow = (request: HTTPRequest) => request.method() === 'PUT' && request.url().endsWith(`/skills/${V}/board`) ? request.abort('failed') : request.continue()
    await activate(narrow, '#open-board-btn')
    await narrow.waitForSelector('#task-board[open] #board-columns > section')
    await narrow.waitForSelector('#board-save-status[data-state="saved"]')
    await narrow.setRequestInterception(true)
    narrow.on('request', failingNarrow)
    await moveWithMenu(narrow, proofs, 'Backlog')
    await narrow.waitForSelector('#board-error[data-kind="failed"]', { visible: true })
    narrow.off('request', failingNarrow)
    await narrow.setRequestInterception(false)
    await closeBoard(narrow)
    await activate(narrow, '#btn-close-skill-details')
    await narrow.waitForSelector('#skill-detail-panel', { hidden: true })
    await activate(narrow, '#sign-out-btn')
    await narrow.waitForSelector('#sign-in-form')
    await setValue(narrow, '#email-input', 'peer@ux05.test')
    await setValue(narrow, '#password-input', PASSWORD)
    await activate(narrow, '#sign-in-btn')
    await narrow.waitForSelector('#personal-workspace')
    await narrow.goto(`${ORIGIN}/enrollments/${enrollment}`, { waitUntil: 'networkidle0' })
    await narrow.waitForSelector('#enrollment-unavailable')
    const leaked = await bodyText(narrow)
    check(!/Blocked|Finished|UNSENT proof|PRIVATE matrix/.test(leaked) && !await narrow.$('#task-board'), 'another Account sees the learner\'s board or draft')
    check((await api(narrow, boardRoute(V))).status === 404, 'the switched Account reads the board')
    // The learner's unsaved change kept in this browser is theirs: the peer's own board restores nothing of it, and it stays kept.
    await openEnrollment(narrow, peerEnrollment, 'unsupported')
    await selectSkillFromList(narrow, V)
    check(!await narrow.$('#board-kept-note'), 'the peer is told about another Account\'s kept board changes')
    await activate(narrow, '#open-board-btn')
    await narrow.waitForSelector('#task-board[open] #board-columns > section')
    await narrow.waitForSelector('#board-save-status[data-state="saved"]')
    check(!await narrow.$('#board-error') && !await narrow.$('#board-conflict'), 'the peer restored another Account\'s board changes')
    check(same(arrangement(await shownBoard(narrow)), [`Backlog:${drills},${proofs},${reading}`, 'To Do:', 'In Progress:', 'Done:']), `the peer's board shows another Account's change: ${JSON.stringify(arrangement(await shownBoard(narrow)))}`)
    const keptKeys = await narrow.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('gurow:board-intents:')))
    check(keptKeys.length === 1 && keptKeys[0].includes(`:enrollment:${enrollment}:${V}`), `the learner's kept change is not kept under their own Enrollment: ${JSON.stringify(keptKeys)}`)
    await closeBoard(narrow)
    await narrow.close()
    pass('AC9 after switching to the peer in the same browser the Enrollment, its board and the unsent draft are unavailable; the peer\'s own board restores nothing of the learner\'s kept change, which stays kept under the learner\'s Enrollment')

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log('\nUX05 learner board check passed.')
  } catch (error) {
    if (current) await current.screenshot({ path: path.join(FRONTEND, '..', '.harness', 'ux05-failure.png') }).catch(() => {})
    throw error
  } finally {
    await browser?.close()
    backend.kill()
    web.kill()
    resend.stop()
  }
}

if (import.meta.main) main().catch((error) => {
  console.error(error)
  process.exit(1)
})
