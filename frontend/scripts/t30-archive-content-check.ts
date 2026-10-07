#!/usr/bin/env bun
/**
 * T30 archival check (#31): the production frontend build forwarding /api to the
 * production backend entry (Better Auth sessions) on a freshly migrated PostgreSQL
 * database, with email through the Resend HTTP mailer to a local stand-in, in headless
 * Chromium with WebGPU. Pat archives a completed personal Task from the editor, which
 * stays locked while the archival is pending (an undo that still reaches it is kept
 * for reapplying, not lost): it
 * leaves the Path's editing while its completion, 20 XP, his Mastery and the Access
 * they open stay, and the Skill lists it as retained history across a reload; deleting
 * content with history is refused in favour of archival, and Quinn finds none of it.
 * Carla archives a published Task from a later Draft: the Version published before and
 * Lena's Enrollment on it keep the Task with her Submission, Approval, XP and private
 * draft, the next Version leaves it out, the Draft after that still lists it as kept by
 * Version 1, and published content takes no archival.
 *
 * Run from frontend: bun run scripts/t30-archive-content-check.ts [--skip-build]
 */
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Browser, type HTTPRequest, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'
import { closeEditorPanels, readSkillStatus } from './editor-navigation'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3561)
const API_PORT = Number(process.env.API_PORT ?? 3562)
const ORIGIN = `http://127.0.0.1:${PORT}`
const SECRET = 't30-browser-check-secret-not-for-production'
const DATABASE_URL = process.env.T30_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t30_browser_test'
const PASSWORD = 'correct horse battery staple'

interface Task { id: string; title: string; description: string; required?: boolean; xpReward?: number }
interface Skill { id: string; title: string; outcome: string; optional?: boolean; xpThreshold?: number; tasks: Task[] }
interface Doc {
  learningPath: { id: string; title: string; goal: string; revision: number }
  draft?: { id: string; versionNumber: number } | null
  version?: { id: string; versionNumber: number } | null
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
  check(result.status === 200 || result.status === 201, `${method} ${apiPath} answered ${result.status}: ${JSON.stringify(result.body)}`)
  return result.body
}
const text = (page: Page, selector: string) => page.$eval(selector, (el) => el.textContent?.trim() ?? '')
const fieldValue = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLInputElement).value)
const data = (page: Page, selector: string): Promise<Record<string, string | undefined>> => page.$eval(selector, (el) => ({ ...(el as HTMLElement).dataset }))
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
}
async function signUpVerified(page: Page, email: string) {
  const before = resend.sent.length
  await authenticate(page, 'sign-up', email)
  await page.goto(await emailedLink(email, 'Verify', before), { waitUntil: 'networkidle0' })
  await page.waitForSelector('#email-verification-status[data-verified="true"]')
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
async function waitForSaved(page: Page) {
  await new Promise((r) => setTimeout(r, 700))
  await page.waitForFunction(() => (document.querySelector('#save-status') as HTMLElement | null)?.dataset.state === 'saved', { timeout: 10000 })
    .catch(async () => { throw new Error(`expected "saved", status is ${JSON.stringify(await saveState(page))} ${await text(page, '#save-error').catch(() => '')}`) })
}
async function openEditor(page: Page, url: string, cards: number) {
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#path-editor[data-gpu-status="ready"]', { timeout: 20000 }).catch(async () => {
    throw new Error(`the editor did not reach WebGPU 'ready' (status ${await page.$eval('#path-editor', (el) => (el as HTMLElement).dataset.gpuStatus).catch(() => 'absent')})`)
  })
  await page.waitForFunction((n: number) => document.querySelectorAll('[id^="card-label-"]').length === n, {}, cards)
}
/** A visible canvas point inside the card, so input goes through the engine. */
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
/** Drags a card on the canvas: one completed operation and one undo step. */
async function drag(page: Page, id: string, dx: number, dy: number) {
  const from = await cardPoint(page, id)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8)
  await page.mouse.up()
}

const taskIds = (page: Page) => page.$$eval('[id^="task-container-"]', (els) => els.map((el) => el.id.replace('task-container-', '')))
/** Starts archiving a Task from the editor: the button, then the in-place confirmation. */
async function startArchive(page: Page, taskId: string) {
  await page.$eval(`#task-archive-${taskId}`, (el) => el.scrollIntoView({ block: 'center' }))
  await page.click(`#task-archive-${taskId}`)
  await page.waitForSelector(`#task-archive-confirm-${taskId}`)
  await page.click(`#task-archive-confirm-btn-${taskId}`)
}
async function archiveFromUi(page: Page, taskId: string) {
  await startArchive(page, taskId)
  return archived(page)
}
/** Waits for the archival's outcome, which must be done. */
async function archived(page: Page) {
  await page.waitForSelector('#archive-status')
  const status = await data(page, '#archive-status')
  check(status.outcome === 'done', `archiving answered: ${await text(page, '#archive-status')}`)
  return text(page, '#archive-status')
}
const retainedText = (page: Page, taskId: string) => text(page, `#retained-task-${taskId}`)

/** Linear Algebra, published through Carla's API: Vectors (20-XP Required drills, Enrichment reading) before Matrices. */
async function publishLinearAlgebra(page: Page, workspaceId: string) {
  const created = await ok(page, `/coach/workspaces/${workspaceId}/learning-paths`, 'POST', { title: 'Linear Algebra', goal: 'Linear maps with confidence' })
  const id = { vectors: crypto.randomUUID(), matrices: crypto.randomUUID(), drills: crypto.randomUUID(), reading: crypto.randomUUID(), matrixDrills: crypto.randomUUID() }
  const saved = await ok(page, `/coach/learning-paths/${created.learningPath.id}/draft`, 'PUT', {
    expectedRevision: created.learningPath.revision, title: 'Linear Algebra', goal: 'Linear maps with confidence',
    editor: { format_version: 1, cards: [{ id: id.vectors, title: 'Vectors', position: { x: 80, y: 120 } }, { id: id.matrices, title: 'Matrices', position: { x: 420, y: 160 } }], connections: [{ from_id: id.vectors, to_id: id.matrices }] },
    application: { skills: [
      { id: id.vectors, title: 'Vectors', outcome: 'Add and scale vectors in R^n', optional: false, xpThreshold: 0, tasks: [
        { id: id.drills, title: 'Vector drills', description: 'Exercises 1–10', required: true, xpReward: 20 },
        { id: id.reading, title: 'Read chapter 1', description: 'Optional background', required: false, xpReward: 0 },
      ] },
      { id: id.matrices, title: 'Matrices', outcome: 'Multiply matrices as linear maps', optional: false, xpThreshold: 20, tasks: [
        { id: id.matrixDrills, title: 'Matrix drills', description: 'Exercises 11–20', required: true, xpReward: 15 },
      ] },
    ] },
  })
  const published = await ok(page, `/coach/learning-paths/${created.learningPath.id}/publication`, 'POST', { expectedRevision: saved.learningPath.revision })
  return { pathId: created.learningPath.id as string, versionId: published.version.id as string, ...id }
}
async function inviteAndAccept(coach: Page, learner: Page, versionId: string, email: string) {
  const before = resend.sent.length
  const invited = await ok(coach, `/coach/learning-path-versions/${versionId}/invitations`, 'POST', { email })
  check(invited.delivered === true, `invitation to ${email} not delivered`)
  await learner.goto(await emailedLink(email, 'You are invited', before), { waitUntil: 'networkidle0' })
  await learner.waitForSelector('#accept-invitation-btn')
  await learner.click('#accept-invitation-btn')
  await learner.waitForSelector('#invitation-result[data-outcome="enrolled"]')
  return (await data(learner, '#invitation-result')).enrollmentId!
}

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
  let current = null as Page | null
  const act = async (page: Page) => { current = page; await page.bringToFront() }
  try {
    await waitForServerReady(ORIGIN)
    for (let i = 0; i < 30; i++) {
      if ((await fetch(`${ORIGIN}/api/account`).catch(() => null))?.status === 401) break
      await new Promise((r) => setTimeout(r, 300))
    }

    // 1. Pat archives a completed 20-XP Task of a Skill whose declared Mastery opens the next one.
    const pat = await newPage(browser, errors)
    await act(pat)
    await authenticate(pat, 'sign-up', 'pat@gurow.test')
    const created = await ok(pat, '/personal/learning-paths', 'POST', { title: 'Rust Basics', goal: 'Write safe Rust' })
    const pathId = created.learningPath.id as string
    const id = { ownership: crypto.randomUUID(), lifetimes: crypto.randomUUID(), borrow: crypto.randomUUID(), chapter: crypto.randomUUID(), annotate: crypto.randomUUID() }
    await ok(pat, `/personal/learning-paths/${pathId}/document`, 'PUT', {
      expectedRevision: created.learningPath.revision, title: 'Rust Basics', goal: 'Write safe Rust',
      editor: { format_version: 1, cards: [{ id: id.ownership, title: 'Ownership', position: { x: 80, y: 120 } }, { id: id.lifetimes, title: 'Lifetimes', position: { x: 420, y: 120 } }], connections: [{ from_id: id.ownership, to_id: id.lifetimes }] },
      application: { skills: [
        { id: id.ownership, title: 'Ownership', outcome: 'Explain moves and borrows', tasks: [{ id: id.borrow, title: 'Borrow checker exercises', description: 'Fix ten errors' }, { id: id.chapter, title: 'Read the ownership chapter', description: 'Chapter 4' }] },
        { id: id.lifetimes, title: 'Lifetimes', outcome: 'Annotate lifetimes', tasks: [{ id: id.annotate, title: 'Annotate lifetimes', description: '' }] },
      ] },
    })
    const at = `/personal/learning-paths/${pathId}`
    await ok(pat, `${at}/tasks/${id.borrow}/reward`, 'PUT', { xpReward: 20 })
    await ok(pat, `${at}/tasks/${id.borrow}/completion`, 'PUT')
    await ok(pat, `${at}/skills/${id.ownership}/mastery`, 'PUT')
    await ok(pat, `${at}/skills/${id.lifetimes}/xp-threshold`, 'PUT', { xpThreshold: 20 })
    const before = (await ok(pat, `${at}/learning-state`)).learningState
    check(before.xp === 20 && before.skills.find((s: any) => s.skillId === id.lifetimes).access === true, `records before archiving: ${JSON.stringify(before)}`)
    const pathUrl = `${ORIGIN}/paths/${pathId}`
    await openEditor(pat, pathUrl, 2)
    const revisionBefore = (await saveState(pat)).revision
    await select(pat, id.ownership)
    await pat.waitForSelector(`#task-learning-${id.borrow}[data-completed="true"]`)
    // Archiving waits for the document to be saved.
    await setValue(pat, '#skill-outcome-input', 'Explain moves, borrows and drops')
    check(await pat.$eval(`#task-archive-${id.borrow}`, (el) => (el as HTMLButtonElement).disabled), 'archiving is offered with unsaved changes')
    await waitForSaved(pat)
    // Cancelling the confirmation archives nothing.
    await pat.click(`#task-archive-${id.borrow}`)
    await pat.click(`#task-archive-cancel-${id.borrow}`)
    check(await pat.$(`#task-container-${id.borrow}`) !== null && await pat.$('#archive-status') === null, 'a cancelled archival changed something')
    // A move to undo later, saved first.
    await drag(pat, id.lifetimes, 120, 60)
    await waitForSaved(pat)
    const movedLifetimes = (await ok(pat, at) as Doc).editor.cards.find((c) => c.id === id.lifetimes)!.position
    await select(pat, id.ownership)
    const savedRevision = (await saveState(pat)).revision
    // The archival is held; meanwhile Ctrl+Z (a window shortcut the locked editor still receives) undoes the move.
    let held: HTTPRequest | null = null
    const hold = (request: HTTPRequest) => {
      if (request.isInterceptResolutionHandled()) return
      if (request.method() === 'POST' && request.url().endsWith(`/tasks/${id.borrow}/archive`) && held === null) held = request
      else void request.continue()
    }
    const sentRequests: string[] = []
    const record = (request: HTTPRequest) => { if (request.url().includes('/api/')) sentRequests.push(`${request.method()} ${new URL(request.url()).pathname}`) }
    await pat.setRequestInterception(true)
    pat.on('request', hold)
    await startArchive(pat, id.borrow)
    for (let i = 0; i < 100 && held === null; i++) await new Promise((r) => setTimeout(r, 50))
    check(held !== null, 'the archival was not sent')
    pat.on('request', record)
    const locked = await pat.evaluate(() => ['#path-goal-input', '#editor-add-card-btn', '#editor-canvas', '#skill-outcome-input'].map((sel) => Boolean(document.querySelector(sel)?.closest('[inert]'))))
    check((await data(pat, '#path-editor')).reapplying === 'true' && locked.every(Boolean), `the editor is not locked while archiving: ${locked}`)
    await pat.keyboard.down('Control')
    await pat.keyboard.press('z')
    await pat.keyboard.up('Control')
    await pat.waitForFunction((x: number, card: string) => Object.keys(localStorage).filter((k) => k.startsWith('gurow:kept-work:'))
      .some((k) => JSON.parse(localStorage.getItem(k)!).mine.editor.cards.find((c: any) => c.id === card)?.position.x !== x), {}, movedLifetimes.x, id.lifetimes)
    await new Promise((r) => setTimeout(r, 900))
    check(!sentRequests.some((r) => r.startsWith('PUT ')), `a save was sent while the archival was pending: ${sentRequests}`)
    await (held as HTTPRequest | null)!.continue()
    pat.off('request', hold)
    pat.off('request', record)
    await pat.setRequestInterception(false)
    const notice = await archived(pat)
    check(notice === 'Archived “Borrow checker exercises”. Its completion and XP stay in this Path\'s history.', `notice: ${notice}`)
    await waitForSaved(pat)
    check((await saveState(pat)).revision === savedRevision + 1, `revision after archiving: ${JSON.stringify(await saveState(pat))}`)
    // The undo made meanwhile is not lost: it is kept for reapplying, based on the archived document.
    await pat.waitForSelector('#kept-work [data-kept-entry]')
    const slipped = await pat.$$eval('#kept-work [data-kept-entry]', (els) => els.map((el) => ({ id: (el as HTMLElement).dataset.keptEntry!, text: el.textContent ?? '' })))
    check(slipped.length === 1 && slipped[0].text.includes('Moved the card “Lifetimes”') && (await data(pat, '#path-editor')).reapplying === 'false', `edit made while archiving: ${JSON.stringify(slipped)}`)
    await pat.click(`#kept-work [data-kept-entry="${slipped[0].id}"] [data-action="discard"]`)
    await pat.waitForFunction(() => document.querySelector('#kept-work [data-kept-entry]') === null)
    await pat.waitForFunction((want: string) => document.querySelector('#selected-skill-id')?.textContent?.trim() === want, {}, id.ownership)
    check(JSON.stringify(await taskIds(pat)) === JSON.stringify([id.chapter]), `Ownership's editable Tasks: ${await taskIds(pat)}`)
    await pat.waitForSelector(`#retained-task-${id.borrow}`)
    check(await retainedText(pat, id.borrow) === 'Borrow checker exercises · Completed · 20 XP still counted', `retained: ${await retainedText(pat, id.borrow)}`)
    check((await data(pat, '#path-xp')).xp === '20' && (await data(pat, '#skill-mastery')).mastery === 'declared', 'archiving changed XP or Mastery')
    check((await readSkillStatus(pat, `#skill-status-${id.lifetimes}`)).access !== 'locked', 'Lifetimes locked after archiving')
    pass('personal archival', `"Borrow checker exercises" archived from rev ${savedRevision} (rev ${savedRevision + 1}, started at ${revisionBefore}); it leaves the editable Tasks and is listed as retained, Completed · 20 XP still counted; XP 20, declared Mastery and Lifetimes' Access unchanged; blocked while unsaved, cancel archives nothing; while the request was held the editor was locked, no save was sent, and the Ctrl+Z it still received was kept as "Moved the card “Lifetimes”"`)

    // 2. Reload: the archived Task stays out of editing and in the retained history.
    await pat.reload({ waitUntil: 'networkidle0' })
    await openEditor(pat, pathUrl, 2)
    await select(pat, id.ownership)
    await pat.waitForSelector(`#retained-task-${id.borrow}`)
    check(JSON.stringify(await taskIds(pat)) === JSON.stringify([id.chapter]) && await fieldValue(pat, '#skill-outcome-input') === 'Explain moves, borrows and drops', 'the archived state did not reload')
    const doc: Doc = await ok(pat, at)
    const records = (await ok(pat, `${at}/learning-state`)).learningState
    const archivedRecord = records.tasks.find((t: any) => t.taskId === id.borrow)
    check(!JSON.stringify(doc.application).includes(id.borrow) && archivedRecord.archivedAt && archivedRecord.completed && archivedRecord.xpContribution === 20, `stored: ${JSON.stringify(archivedRecord)}`)
    check(records.xp === before.xp && JSON.stringify(records.xpHistory) === JSON.stringify(before.xpHistory) && JSON.stringify(records.masteryHistory) === JSON.stringify(before.masteryHistory), 'archiving rewrote the history')
    pass('reload', 'after a reload the Task is still out of the document and listed as retained; stored completion, 20 XP contribution, XP and Mastery history unchanged')

    // 3. Deleting content with history is refused in favour of archival; the archived Task takes no action.
    await ok(pat, `${at}/tasks/${id.chapter}/completion`, 'PUT')
    const fresh: Doc = await ok(pat, at)
    const save = (change: (d: Doc) => void) => {
      const next = structuredClone(fresh)
      change(next)
      return api(pat, `${at}/document`, 'PUT', { expectedRevision: fresh.learningPath.revision, title: next.learningPath.title, goal: next.learningPath.goal, editor: next.editor, application: next.application })
    }
    const dropTask = await save((d) => { d.application.skills[0].tasks = d.application.skills[0].tasks.filter((t) => t.id !== id.chapter) })
    const dropSkill = await save((d) => {
      d.application.skills = d.application.skills.filter((s) => s.id !== id.ownership)
      d.editor.cards = d.editor.cards.filter((c) => c.id !== id.ownership)
      d.editor.connections = []
    })
    check(dropTask.status === 409 && dropTask.body.error === 'task_has_history' && /archive it instead/.test(dropTask.body.detail), `deleting a completed Task: ${JSON.stringify(dropTask)}`)
    check(dropSkill.status === 409 && dropSkill.body.error === 'skill_has_history', `deleting a Skill with history: ${JSON.stringify(dropSkill)}`)
    const onArchived = await api(pat, `${at}/tasks/${id.borrow}/completion`, 'DELETE')
    check(onArchived.status === 409 && onArchived.body.error === 'task_archived', `undoing an archived Task: ${JSON.stringify(onArchived)}`)
    check(JSON.stringify(await ok(pat, at)) === JSON.stringify(fresh), 'a refused deletion changed the Path')
    pass('blocked deletion', `deleting a completed Task 409 task_has_history ("${dropTask.body.detail}"), its Skill 409 skill_has_history; the archived Task refuses actions (409 task_archived); Path unchanged`)

    // 4. Quinn finds none of it.
    const quinn = await newPage(browser, errors)
    await act(quinn)
    await authenticate(quinn, 'sign-up', 'quinn@gurow.test')
    const quinnCalls = [await api(quinn, `${at}/tasks/${id.chapter}/archive`, 'POST', {}), await api(quinn, `${at}/learning-state`), await api(quinn, at)]
    check(quinnCalls.every((r) => r.status === 404), `Quinn's calls answered ${quinnCalls.map((r) => r.status)}`)
    await quinn.goto(pathUrl, { waitUntil: 'networkidle0' })
    await quinn.waitForSelector('#path-unavailable')
    check(!(await quinn.$eval('body', (el) => el.innerText)).includes('Borrow checker'), 'Quinn sees the archived Task')
    check(!(await ok(pat, `${at}/learning-state`)).learningState.tasks.find((t: any) => t.taskId === id.chapter).archivedAt, 'Quinn archived Pat\'s Task')
    pass('personal privacy', `Quinn's archive, records and Path reads answer ${quinnCalls.map((r) => r.status).join('/')}; the Path page is not available and shows no archived Task`)

    // 5. Carla's Version 1, with Lena's Approval, Submissions and a private unsent draft.
    const carla = await newPage(browser, errors)
    await act(carla)
    await signUpVerified(carla, 'carla@gurow.test')
    const workspace = (await ok(carla, '/coach/workspaces', 'POST', { name: 'Linear Algebra Studio' })).workspace
    const la = await publishLinearAlgebra(carla, workspace.id)
    const lena = await newPage(browser, errors)
    await act(lena)
    await signUpVerified(lena, 'lena@gurow.test')
    await act(carla)
    const enrollment = await inviteAndAccept(carla, lena, la.versionId, 'lena@gurow.test')
    const taskRoute = (taskId: string) => `/enrollments/${enrollment}/tasks/${taskId}`
    const sent = await ok(lena, `${taskRoute(la.drills)}/submission/revisions`, 'POST', { text: 'Vector evidence', urls: [] })
    await ok(carla, `${taskRoute(la.drills)}/submission/revisions/${sent.revision.id}/review`, 'POST', { decision: 'approval' })
    await ok(lena, `${taskRoute(la.reading)}/submission/revisions`, 'POST', { text: 'Chapter 1 notes', urls: [] })
    await ok(lena, `${taskRoute(la.reading)}/draft`, 'PUT', { text: 'Unsent second thoughts', urls: [] })
    const lenaBefore = (await ok(lena, `/enrollments/${enrollment}/learning-state`)).learningState
    const version1: Doc = await ok(carla, `/coach/learning-path-versions/${la.versionId}`)
    check(lenaBefore.xp === 20, `Lena's XP: ${lenaBefore.xp}`)
    pass('coach evidence', 'Version 1 published; Lena approved on Vector drills (20 XP), sent "Chapter 1 notes" for Read chapter 1 and keeps an unsent draft of it')

    // 6. Carla prepares Version 2 as a Draft and archives "Read chapter 1" from it.
    const coachUrl = `${ORIGIN}/coach/paths/${la.pathId}`
    await carla.goto(coachUrl, { waitUntil: 'networkidle0' })
    await carla.waitForSelector('#published-version')
    check(await carla.$('[id^="task-archive-"]') === null, 'published content offers archival')
    await carla.click('#prepare-draft-btn')
    await carla.waitForSelector('#path-editor[data-gpu-status="ready"]', { timeout: 20000 })
    await carla.waitForFunction(() => document.querySelectorAll('[id^="card-label-"]').length === 2)
    await select(carla, la.vectors)
    await carla.waitForSelector(`#task-archive-${la.reading}`)
    const before6 = await taskIds(carla)
    await carla.click('#add-task-btn')
    await carla.waitForFunction((n: number) => document.querySelectorAll('[id^="task-container-"]').length === n, {}, before6.length + 1)
    const draftOnly = (await taskIds(carla)).find((x) => !before6.includes(x))!
    await waitForSaved(carla)
    check(await carla.$(`#task-archive-${draftOnly}`) === null && await carla.$(`#task-archive-${la.drills}`) !== null, 'archival is offered for a Task only this Draft holds, or not for a published one')
    const draftRevision = (await saveState(carla)).revision
    const coachNotice = await archiveFromUi(carla, la.reading)
    check(coachNotice === 'Archived “Read chapter 1” from this Draft. Version 1 and its learners\' work keep it.', `notice: ${coachNotice}`)
    await waitForSaved(carla)
    check((await saveState(carla)).revision === draftRevision + 1 && !(await taskIds(carla)).includes(la.reading), 'the Draft still holds the archived Task')
    await carla.waitForSelector(`#retained-task-${la.reading}`)
    check(await retainedText(carla, la.reading) === 'Read chapter 1 · Archived from a Draft · Version 1 keeps it with its learners\' work', `retained: ${await retainedText(carla, la.reading)}`)
    const notPublished = await api(carla, `/coach/learning-paths/${la.pathId}/draft/tasks/${draftOnly}/archive`, 'POST', { expectedRevision: draftRevision + 1 })
    check(notPublished.status === 409 && notPublished.body.error === 'task_not_published', `archiving a Draft-only Task: ${JSON.stringify(notPublished)}`)
    const draftDoc: Doc = await ok(carla, `/coach/learning-paths/${la.pathId}`)
    const dropDrills = await api(carla, `/coach/learning-paths/${la.pathId}/draft`, 'PUT', {
      expectedRevision: draftDoc.learningPath.revision, title: draftDoc.learningPath.title, goal: draftDoc.learningPath.goal, editor: draftDoc.editor,
      application: { skills: draftDoc.application.skills.map((s) => ({ ...s, tasks: s.tasks.filter((t) => t.id !== la.drills) })) },
    })
    check(dropDrills.status === 409 && dropDrills.body.error === 'task_has_history', `deleting a published Task from the Draft: ${JSON.stringify(dropDrills)}`)
    await carla.reload({ waitUntil: 'networkidle0' })
    await carla.waitForSelector('#path-editor[data-gpu-status="ready"]', { timeout: 20000 })
    await carla.waitForFunction(() => document.querySelectorAll('[id^="card-label-"]').length === 2)
    await select(carla, la.vectors)
    await carla.waitForSelector(`#retained-task-${la.reading}`)
    check(!(await taskIds(carla)).includes(la.reading), 'the archived Task came back after reload')
    pass('draft archival', `"Read chapter 1" archived from the Version 2 Draft (rev ${draftRevision} → ${draftRevision + 1}) and listed as kept by Version 1, also after reload; a Draft-only Task offers no archival (API 409 task_not_published); deleting published "Vector drills" 409 task_has_history`)

    // 7. Version 2 leaves the Task out; Version 1 and Lena's Enrollment keep it with her work.
    const v2 = await ok(carla, `/coach/learning-paths/${la.pathId}/publication`, 'POST', { expectedRevision: draftDoc.learningPath.revision })
    check(!JSON.stringify(v2.application).includes(la.reading), 'Version 2 holds the archived Task')
    const version1After: Doc = await ok(carla, `/coach/learning-path-versions/${la.versionId}`)
    check(JSON.stringify(version1After.application) === JSON.stringify(version1.application) && JSON.stringify(version1After.editor) === JSON.stringify(version1.editor), 'Version 1 changed')
    const noDraft = await api(carla, `/coach/learning-paths/${la.pathId}/draft/tasks/${la.drills}/archive`, 'POST', { expectedRevision: v2.learningPath.revision })
    check(noDraft.status === 409 && noDraft.body.error === 'no_open_draft', `archiving without a Draft: ${JSON.stringify(noDraft)}`)
    await carla.goto(`${ORIGIN}/coach/versions/${la.versionId}`, { waitUntil: 'networkidle0' })
    await carla.waitForFunction(() => document.querySelectorAll('[id^="card-label-"]').length === 2, { timeout: 20000 })
    check(await carla.$('[id^="task-archive-"]') === null, 'a published Version page offers archival')
    await act(lena)
    await lena.goto(`${ORIGIN}/enrollments/${enrollment}`, { waitUntil: 'networkidle0' })
    await lena.waitForSelector('#enrolled-version[data-gpu-status="ready"]', { timeout: 20000 })
    await lena.waitForFunction(() => (document.querySelector('#enrollment-xp') as HTMLElement | null)?.dataset.xp === '20')
    await select(lena, la.vectors)
    await lena.waitForSelector(`#task-history-${la.reading}[data-revisions="1"]`)
    check((await text(lena, `#task-history-${la.reading}`)).includes('Chapter 1 notes'), 'Lena\'s sent work for the archived Task is not shown')
    check(JSON.stringify((await ok(lena, `/enrollments/${enrollment}/learning-state`)).learningState) === JSON.stringify(lenaBefore), 'Lena\'s records changed')
    check((await ok(lena, `${taskRoute(la.reading)}/draft`)).draft.text === 'Unsent second thoughts', 'Lena\'s draft was lost')
    const carlaDraft = await api(carla, `${taskRoute(la.reading)}/draft`)
    const carlaSubmission = await api(carla, `${taskRoute(la.reading)}/submission`)
    const quinnSubmission = await api(quinn, `${taskRoute(la.reading)}/submission`)
    check(carlaDraft.status === 403 && carlaDraft.body.error === 'draft_private', `Carla reading Lena's draft: ${JSON.stringify(carlaDraft)}`)
    check(carlaSubmission.status === 200 && quinnSubmission.status === 404, `submission reads: Carla ${carlaSubmission.status}, Quinn ${quinnSubmission.status}`)
    pass('retained evidence', 'Version 2 leaves the Task out, Version 1 is unchanged and takes no archival (409 no_open_draft, no archive control on its page); Lena still sees XP 20 and her sent revision for "Read chapter 1", her draft stays hers (Carla 403 draft_private), Carla reads the Submission, Quinn 404')

    // 8. The Draft after Version 2 still reports the Task as kept by Version 1.
    await act(carla)
    const path2 = await ok(carla, `/coach/learning-paths/${la.pathId}`)
    await ok(carla, `/coach/learning-paths/${la.pathId}/drafts`, 'POST', { expectedRevision: path2.learningPath.revision })
    await carla.goto(coachUrl, { waitUntil: 'networkidle0' })
    await carla.waitForSelector('#path-editor[data-gpu-status="ready"]', { timeout: 20000 })
    await carla.waitForFunction(() => document.querySelectorAll('[id^="card-label-"]').length === 2)
    await select(carla, la.vectors)
    await carla.waitForSelector(`#retained-task-${la.reading}`)
    check(await retainedText(carla, la.reading) === 'Read chapter 1 · Archived from a Draft · Version 1 keeps it with its learners\' work', `Draft 3 retained: ${await retainedText(carla, la.reading)}`)
    check(!(await taskIds(carla)).includes(la.reading) && await carla.$(`#task-archive-${la.drills}`) !== null, 'Draft 3 holds the archived Task, or cannot archive a published one')
    pass('next Draft', 'the Version 3 Draft, prepared after Version 2 left the Task out, still lists "Read chapter 1" as kept by Version 1')

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log(`\nT30 archival check passed (${steps.length} steps).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t30-failure.png')
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
  console.error(`\nT30 archival check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
