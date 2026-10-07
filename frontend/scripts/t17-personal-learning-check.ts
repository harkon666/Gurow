#!/usr/bin/env bun
/**
 * T17 personal learning check (#18): the production frontend build forwarding /api to
 * the production backend entry (Better Auth sessions) on a freshly migrated PostgreSQL
 * database, in headless Chromium with WebGPU. A signed-in owner authors a Path, then
 * completes Tasks, edits rewards (20 → 50), declares and withdraws Mastery, sets an XP
 * Threshold, bypasses gates and watches Skills relock, all from the canvas, list and
 * learning panels. A lost answer is retried without doubling XP, a failed write is
 * reported without claiming success, another Path's XP never counts, a keyboard-only
 * owner (also without WebGPU) reaches the same actions, and a reload restores it all.
 *
 * Run from frontend: bun run scripts/t17-personal-learning-check.ts [--skip-build]
 */
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type HTTPRequest, type Page } from 'puppeteer-core'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'
import { closeEditorPanels, openSkillList, openNewSkill, readSkillStatus, clickOutsideDetails } from './editor-navigation'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3493)
const API_PORT = Number(process.env.API_PORT ?? 3494)
const ORIGIN = `http://127.0.0.1:${PORT}`
const DATABASE_URL = process.env.T17_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t17_browser_test'
const PASSWORD = 'correct horse battery staple'

const steps: string[] = []
function pass(step: string, detail: string) {
  steps.push(step)
  console.log(`  ✓ ${step}: ${detail}`)
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Calls the backend from the page, with the page's own session cookie. */
async function api(page: Page, apiPath: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(async (p: string, m: string, b: string | null) => {
    const response = await fetch(`/api${p}`, { method: m, headers: b === null ? undefined : { 'content-type': 'application/json' }, body: b ?? undefined })
    return { status: response.status, body: await response.json().catch(() => null) }
  }, apiPath, method, body === undefined ? null : JSON.stringify(body))
}
/** The backend's records, read independently of what the page shows. */
async function stored(page: Page, pathId: string) {
  const result = await api(page, `/personal/learning-paths/${pathId}/learning-state`)
  check(result.status === 200, `reading learning state of ${pathId} answered ${result.status}`)
  return result.body.learningState
}
const storedSkill = (state: any, id: string) => state.skills.find((s: any) => s.skillId === id)
const storedTask = (state: any, id: string) => state.tasks.find((t: any) => t.taskId === id)
const revisionOf = async (page: Page, pathId: string) => (await api(page, `/personal/learning-paths/${pathId}`)).body.learningPath.revision as number

const text = (page: Page, selector: string) => page.$eval(selector, (el) => el.textContent?.trim() ?? '')
const attr = (page: Page, selector: string, name: string) => page.$eval(selector, (el, n) => el.getAttribute(n), name)
const fieldValue = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLInputElement).value)
const saveState = (page: Page) => page.$eval('#save-status', (el) => ({ state: (el as HTMLElement).dataset.state!, revision: Number((el as HTMLElement).dataset.revision) }))
async function waitForState(page: Page, state: string) {
  await page.waitForFunction((want: string) => (document.querySelector('#save-status') as HTMLElement | null)?.dataset.state === want, { timeout: 10000 }, state)
    .catch(async () => { throw new Error(`expected save state ${state}, status is ${JSON.stringify(await saveState(page))}`) })
}
/** React-controlled fields need the native value setter before the input event. */
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
async function openEditor(page: Page, cards: number, gpu: 'ready' | 'unsupported' = 'ready') {
  await page.waitForSelector(`#path-editor[data-gpu-status="${gpu}"]`, { timeout: 20000 }).catch(async () => {
    throw new Error(`the editor did not reach '${gpu}' (status ${await page.$eval('#path-editor', (el) => (el as HTMLElement).dataset.gpuStatus).catch(() => 'absent')})`)
  })
  if (gpu === 'ready') await page.waitForFunction((n: number) => document.querySelectorAll('[id^="card-label-"]').length === n, {}, cards)
  return page.$eval('#path-editor', (el) => (el as HTMLElement).dataset.pathId!)
}
async function createPath(page: Page, title: string, goal: string) {
  await setValue(page, '#new-path-title', title)
  await setValue(page, '#new-path-goal', goal)
  await page.click('#create-path-btn')
  return openEditor(page, 0)
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
/** Clicks a visible canvas point of the card, so selection goes through the engine. */
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
async function addTask(page: Page, title: string) {
  const before = await page.$$eval('[id^="task-edit-title-"]', (els) => els.map((el) => el.id))
  await page.click('#add-task-btn')
  await page.waitForFunction((n: number) => document.querySelectorAll('[id^="task-edit-title-"]').length === n, {}, before.length + 1)
  const id = (await page.$$eval('[id^="task-edit-title-"]', (els) => els.map((el) => el.id))).find((x) => !before.includes(x))!.replace('task-edit-title-', '')
  await setValue(page, `#task-edit-title-${id}`, title)
  return id
}

/** The panel's view of the selected Skill and the Path, as text and data attributes. */
const shown = (page: Page) => page.evaluate(() => {
  const q = (s: string) => document.querySelector(s) as HTMLElement | null
  return {
    xp: q('#path-xp')?.dataset.xp ?? null,
    access: q('#skill-access')?.dataset.access ?? null,
    accessText: q('#skill-access-state')?.textContent ?? null,
    reasons: [...document.querySelectorAll('#lock-reasons li')].map((li) => li.textContent ?? ''),
    mastery: q('#skill-mastery')?.dataset.mastery ?? null,
    history: [...document.querySelectorAll('#xp-history li')].map((li) => li.textContent ?? ''),
    pending: q('#learning-pending') !== null,
    error: q('#learning-error')?.textContent ?? null,
  }
})
/** Waits until no action is pending, then until the shown records match. */
async function waitShown(page: Page, want: { xp?: number; access?: string; mastery?: string }) {
  await page.waitForFunction((w: { xp?: number; access?: string; mastery?: string }) => {
    const q = (s: string) => document.querySelector(s) as HTMLElement | null
    if (q('#learning-pending')) return false
    return (w.xp === undefined || q('#path-xp')?.dataset.xp === String(w.xp)) &&
      (w.access === undefined || q('#skill-access')?.dataset.access === w.access) &&
      (w.mastery === undefined || q('#skill-mastery')?.dataset.mastery === w.mastery)
  }, { timeout: 10000 }, want).catch(async () => { throw new Error(`expected ${JSON.stringify(want)}, page shows ${JSON.stringify(await shown(page))}`) })
}
const contribution = (page: Page, task: string) => text(page, `#task-contribution-${task}`)
/** Sets a number through its own Set button and waits for the backend to confirm it. */
async function setNumber(page: Page, id: string, value: number, confirmed = true) {
  await setValue(page, `#${id}`, String(value))
  await page.click(`#${id}-set`)
  // Set is disabled once the confirmed value equals the typed one and nothing is pending.
  if (confirmed) {
    await page.waitForFunction((i: string) => !document.querySelector('#learning-pending') && !document.querySelector('#learning-error') &&
      (document.querySelector(`#${i}-set`) as HTMLButtonElement | null)?.disabled === true, {}, id)
      .catch(async () => { throw new Error(`${id} = ${value} was not confirmed; page shows ${JSON.stringify(await shown(page))}`) })
  }
}
/** Presses Tab until `selector` has focus: the control is reachable by keyboard alone. */
async function tabTo(page: Page, selector: string, limit = 200) {
  for (let i = 0; i < limit; i++) {
    if (await page.evaluate((s) => document.activeElement === document.querySelector(s), selector)) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`${selector} was not reached by ${limit} Tab presses (focus on ${await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName)})`)
}
/** Selects a Skill in the keyboard list: focus it, Home, ArrowDown n times, Enter. */
async function keyboardSelect(page: Page, index: number, id: string) {
  await openSkillList(page)
  await page.focus('#skill-prerequisite-list')
  await page.keyboard.press('Home')
  for (let i = 0; i < index; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.waitForFunction((want: string) => document.querySelector('#selected-skill-id')?.textContent?.trim() === want, {}, id)
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
    env: { ...process.env, DATABASE_URL, PORT: String(API_PORT), BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_SECRET: 't17-browser-check-secret-not-for-production', NODE_ENV: 'test', RESEND_API_KEY: '' },
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
    // No action here asks for a reason or confirmation: any dialog is a failure.
    page.on('dialog', (dialog) => { dialogs.push(`${dialog.type()}: ${dialog.message()}`); void dialog.accept() })
    current = page
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })

    // 1. Authoring, then the three separate states: Access, Path XP and Mastery.
    await page.goto(ORIGIN, { waitUntil: 'networkidle0' })
    await authenticate(page, 'sign-up', 'ada@gurow.test')
    const pathA = await createPath(page, 'Systems Rust', 'Ship a small allocator')
    const ownership = await addSkill(page, 'Ownership', 'Explain moves and borrows')
    const borrow = await addTask(page, 'Borrow exercises')
    const chapter = await addTask(page, 'Read the chapter')
    const lifetimes = await addSkill(page, 'Lifetimes', 'Annotate lifetimes in signatures')
    const annotate = await addTask(page, 'Annotate a parser')
    await select(page, ownership)
    await page.select('#connect-skill-select', lifetimes)
    await page.click('#btn-add-dependent')
    await waitForState(page, 'saved')
    await page.waitForFunction(() => (document.querySelector('[id^="task-learning-"]') as HTMLElement | null)?.dataset.tracked === 'true')
    let authoredRevision = (await saveState(page)).revision
    await page.waitForSelector(`#task-learning-${borrow}[data-tracked="true"]`)
    await waitShown(page, { xp: 0, access: 'open', mastery: 'unclaimed' })
    check((await readSkillStatus(page, `#skill-status-${lifetimes}`)).access === 'locked', 'the list does not show Lifetimes as locked')
    check(await attr(page, `#card-status-${lifetimes}`, 'data-locked') === 'true', 'the canvas label does not show Lifetimes as locked')
    await select(page, lifetimes)
    await waitShown(page, { access: 'locked', mastery: 'unclaimed' })
    let view = await shown(page)
    check(JSON.stringify(view.reasons) === JSON.stringify(['Requires Mastery of “Ownership”, which is not declared']), `Lifetimes lock reasons: ${JSON.stringify(view.reasons)}`)
    check(await text(page, '#selected-skill-title') === 'Lifetimes' && await fieldValue(page, '#skill-outcome-input') === 'Annotate lifetimes in signatures', 'the locked Skill lost its title or outcome')
    check(await page.$eval(`#task-completion-btn-${annotate}`, (el) => (el as HTMLButtonElement).disabled), 'a locked Skill\'s Task can be marked complete')
    // A threshold typed for one Skill but not set stays with it: another Skill with the same threshold shows its own.
    await setValue(page, '#xp-threshold-input', '100')
    await select(page, ownership)
    check(await fieldValue(page, '#xp-threshold-input') === '0' && await page.$eval('#xp-threshold-input-set', (el) => (el as HTMLButtonElement).disabled),
      `Ownership shows the threshold typed for Lifetimes: "${await fieldValue(page, '#xp-threshold-input')}"`)
    pass('separate states', `Path XP ${view.xp}; Ownership open/unclaimed; Lifetimes "${view.accessText}" because "${view.reasons[0]}", title and outcome kept, completion unavailable`)

    // 2. Completion and rewards: 20 on an incomplete Task, completion, 20 → 50, undo, completion again.
    await select(page, ownership)
    await setNumber(page, `task-reward-${borrow}`, 20)
    await waitShown(page, { xp: 0 })
    check(await contribution(page, borrow) === 'Not complete · contributes 0 XP', `incomplete Task shows ${await contribution(page, borrow)}`)
    await page.click(`#task-completion-btn-${borrow}`)
    await waitShown(page, { xp: 20, mastery: 'unclaimed' })
    check(await contribution(page, borrow) === 'Complete · contributes 20 XP', `completed Task shows ${await contribution(page, borrow)}`)
    await setNumber(page, `task-reward-${borrow}`, 50)
    await waitShown(page, { xp: 50 })
    await page.click(`#task-completion-btn-${borrow}`)
    await waitShown(page, { xp: 0 })
    await page.click(`#task-completion-btn-${borrow}`)
    await waitShown(page, { xp: 50, mastery: 'unclaimed' })
    // An incomplete Task's reward edit leaves its contribution at zero.
    await setNumber(page, `task-reward-${chapter}`, 15)
    await waitShown(page, { xp: 50 })
    view = await shown(page)
    check(JSON.stringify(view.history) === JSON.stringify([
      '“Borrow exercises” completed: +20 XP (award)',
      '“Borrow exercises” reward changed while complete: +30 XP (correction)',
      '“Borrow exercises” completion undone: −50 XP (correction)',
      '“Borrow exercises” completed again: +50 XP (correction)',
    ]), `shown XP record: ${JSON.stringify(view.history)}`)
    let s = await stored(page, pathA)
    check(s.xp === 50 && JSON.stringify(s.xpHistory.map((e: any) => [e.kind, e.cause, e.amount])) === JSON.stringify([['award', 'completion', 20], ['correction', 'reward_change', 30], ['correction', 'completion_undone', -50], ['correction', 'completion', 50]]), `stored XP ${s.xp} ${JSON.stringify(s.xpHistory)}`)
    check(storedTask(s, chapter).xpReward === 15 && storedTask(s, chapter).xpContribution === 0, 'the incomplete Task contributes after its reward edit')
    check(!storedSkill(s, ownership).mastery && s.masteryHistory.length === 0, 'completing Tasks declared Mastery')
    pass('completion and corrections', `20 → complete +20 → reward 50 +30 → undo −50 → complete +50; backend XP ${s.xp}; incomplete reward 15 contributes 0; Mastery still unclaimed`)

    // 3. Independent Mastery: declaring it is free and opens the dependent Skill without spending XP.
    // Its answer is held while an autosave asks for fresh records; the read that answers
    // first must not hide the declaration once it is confirmed.
    const heldMastery: { request: HTTPRequest | null; released: boolean } = { request: null, released: false }
    const reads: string[] = []
    const holdMastery = (request: HTTPRequest) => {
      if (request.isInterceptResolutionHandled()) return
      if (request.url().endsWith('/learning-state')) reads.push(heldMastery.request && !heldMastery.released ? 'during' : 'after')
      if (heldMastery.request === null && request.method() === 'PUT' && request.url().endsWith(`/skills/${ownership}/mastery`)) heldMastery.request = request
      else void request.continue()
    }
    await page.setRequestInterception(true)
    page.on('request', holdMastery)
    await page.click('#mastery-btn')
    for (let i = 0; i < 50 && heldMastery.request === null; i++) await new Promise((r) => setTimeout(r, 50))
    check(heldMastery.request, 'the Mastery declaration never reached the network')
    await closeEditorPanels(page)
    await setValue(page, '#path-goal-input', 'Ship a small allocator, then a GC')
    await keyboardSelect(page, 0, ownership)
    await waitForState(page, 'saved')
    authoredRevision = (await saveState(page)).revision
    await new Promise((r) => setTimeout(r, 300))
    heldMastery.released = true
    await heldMastery.request.continue()
    await waitShown(page, { xp: 50, mastery: 'declared' })
    // The records refresh after the declaration, and still show it.
    await page.waitForFunction(() => !document.querySelector('#learning-pending'))
    await new Promise((r) => setTimeout(r, 600))
    page.off('request', holdMastery)
    await page.setRequestInterception(false)
    check((await shown(page)).mastery === 'declared' && (await readSkillStatus(page, `#skill-status-${ownership}`)).mastery === 'declared', `a read during the held declaration hid it: ${JSON.stringify(await shown(page))}`)
    check(!reads.includes('during') && reads.includes('after'), `records read while the declaration was in flight, or never after it: ${reads}`)
    await select(page, lifetimes)
    await waitShown(page, { access: 'open' })
    await setNumber(page, 'xp-threshold-input', 40)
    await waitShown(page, { xp: 50, access: 'open' })
    await setNumber(page, `task-reward-${annotate}`, 10)
    await page.click(`#task-completion-btn-${annotate}`)
    await waitShown(page, { xp: 60 })
    await page.click('#mastery-btn')
    await waitShown(page, { xp: 60, mastery: 'declared' })
    s = await stored(page, pathA)
    check(s.xp === 60 && storedSkill(s, lifetimes).access && storedSkill(s, lifetimes).xpThreshold === 40 && storedSkill(s, lifetimes).mastery, `stored after unlock: ${JSON.stringify(storedSkill(s, lifetimes))}, XP ${s.xp}`)
    pass('independent Mastery', 'a declaration answered after an autosave asked for records stays shown (the read waited for it); declaring Ownership opened Lifetimes; threshold 40 met by 50 XP spent nothing; Lifetimes Task +10 and its Mastery declared freely (XP stays 60)')

    // 4. Relock: withdrawing the Prerequisite's Mastery, then falling below the threshold, keep work and Mastery.
    await select(page, ownership)
    await page.click('#mastery-btn')
    await waitShown(page, { mastery: 'unclaimed' })
    await select(page, lifetimes)
    await waitShown(page, { xp: 60, access: 'locked', mastery: 'declared' })
    view = await shown(page)
    check(JSON.stringify(view.reasons) === JSON.stringify(['Requires Mastery of “Ownership”, which is not declared']), `prerequisite relock reasons ${JSON.stringify(view.reasons)}`)
    check(await contribution(page, annotate) === 'Complete · contributes 10 XP', 'relocking dropped the started work')
    await select(page, ownership)
    await page.click('#mastery-btn')
    await waitShown(page, { mastery: 'declared' })
    await page.click(`#task-completion-btn-${borrow}`)
    await waitShown(page, { xp: 10 })
    await select(page, lifetimes)
    await waitShown(page, { xp: 10, access: 'locked', mastery: 'declared' })
    view = await shown(page)
    check(JSON.stringify(view.reasons) === JSON.stringify(['Needs 30 more XP: the threshold is 40 and this Path has 10 XP']), `threshold relock reasons ${JSON.stringify(view.reasons)}`)
    check(await contribution(page, annotate) === 'Complete · contributes 10 XP', 'the threshold relock dropped the started work')
    s = await stored(page, pathA)
    check(!storedSkill(s, lifetimes).access && storedSkill(s, lifetimes).mastery && storedTask(s, annotate).completed && s.xp === 10, `stored relock ${JSON.stringify(storedSkill(s, lifetimes))}`)
    // Evidence of the relocked panel for the review packet.
    await page.screenshot({ path: path.resolve(FRONTEND, '../.harness/t17-relock.png') }).catch(() => {})
    pass('relock', `withdrawn Prerequisite Mastery → "${(await shown(page)).accessText}"; undoing 50 XP → "${view.reasons[0]}"; Lifetimes keeps its completed Task and declared Mastery`)

    // 5. An explicit bypass without a reason; XP and Mastery stay, and removing it relocks.
    const before = await stored(page, pathA)
    await page.click('#access-override-btn')
    await waitShown(page, { xp: 10, access: 'override', mastery: 'declared' })
    check((await shown(page)).reasons.length === 1, 'the waived requirement is no longer explained')
    s = await stored(page, pathA)
    check(storedSkill(s, lifetimes).access && s.xp === before.xp && JSON.stringify(s.xpHistory) === JSON.stringify(before.xpHistory) &&
      JSON.stringify(s.masteryHistory) === JSON.stringify(before.masteryHistory) && s.overrideHistory.map((r: any) => r.action).join() === 'grant', 'the bypass changed XP or Mastery')
    check(!(await page.$eval(`#task-completion-btn-${annotate}`, (el) => (el as HTMLButtonElement).disabled)), 'the bypassed Skill still blocks its Task')
    await page.click('#access-override-btn')
    await waitShown(page, { xp: 10, access: 'locked' })
    pass('bypass', 'no reason asked; Lifetimes "Open by override" with XP 10 and Mastery unchanged; removing the bypass relocks it')

    // 6. Retry: the backend records a completion but its answer is lost; the retry does not double it.
    await select(page, ownership)
    await page.evaluate((suffix: string) => {
      const original = window.fetch
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith(suffix) && init?.method === 'PUT') {
          window.fetch = original
          await original(input, init)
          throw new TypeError('Failed to fetch')
        }
        return original(input, init)
      }) as typeof fetch
    }, `/tasks/${chapter}/completion`)
    await page.click(`#task-completion-btn-${chapter}`)
    await page.waitForSelector('#learning-error')
    view = await shown(page)
    check(view.xp === '10' && await contribution(page, chapter) === 'Not complete · contributes 0 XP', `an unconfirmed completion was shown: ${JSON.stringify(view)}`)
    check((await stored(page, pathA)).xp === 25, 'the lost completion did not reach the backend')
    await clickOutsideDetails(page, '#learning-retry-btn')
    await waitShown(page, { xp: 25 })
    s = await stored(page, pathA)
    check(s.xp === 25 && s.xpHistory.filter((e: any) => e.taskId === chapter).length === 1, `the retry multiplied the reward: ${JSON.stringify(s.xpHistory.filter((e: any) => e.taskId === chapter))}`)
    check(await page.$('#learning-error') === null, 'the error stayed after a confirmed retry')
    pass('retry', `"${view.error?.slice(0, 70)}…" while the backend already had it; Retry showed XP 25 with one award for the Task`)

    // 7. A failed write is reported and changes nothing shown or stored; Retry then records it.
    await page.evaluate(() => {
      const seen: string[] = ((window as any).__xpSeen = [])
      const el = document.querySelector('#path-xp')!
      new MutationObserver(() => seen.push((el as HTMLElement).dataset.xp!)).observe(el, { attributes: true, attributeFilter: ['data-xp'] })
    })
    const blockRewards = (request: HTTPRequest) => {
      if (request.isInterceptResolutionHandled()) return
      if (request.method() === 'PUT' && request.url().endsWith('/reward')) void request.abort('connectionfailed')
      else void request.continue()
    }
    await page.setRequestInterception(true)
    page.on('request', blockRewards)
    await setNumber(page, `task-reward-${chapter}`, 25, false)
    await page.waitForSelector('#learning-error')
    const failure = await text(page, '#learning-error')
    check(await contribution(page, chapter) === 'Complete · contributes 15 XP' && await fieldValue(page, `#task-reward-${chapter}`) === '25', 'the failed reward edit was shown as applied or the typed value was dropped')
    check(storedTask(await stored(page, pathA), chapter).xpReward === 15, 'the failed write reached the backend')
    page.off('request', blockRewards)
    await page.setRequestInterception(false)
    check(!(await page.evaluate(() => (window as any).__xpSeen as string[])).includes('35'), 'the failed write was shown as XP')
    await clickOutsideDetails(page, '#learning-retry-btn')
    await waitShown(page, { xp: 35 })
    s = await stored(page, pathA)
    check(storedTask(s, chapter).xpReward === 25 && s.xpHistory.at(-1).amount === 10 && s.xpHistory.at(-1).cause === 'reward_change', 'the retried reward edit was not recorded as a +10 correction')
    pass('failed write', `"${failure.slice(0, 70)}…"; the Task still showed 15 XP, Path XP never showed 35, backend kept reward 15; Retry recorded +10 (XP 35)`)

    // 8. Keyboard only, from the list: select a Skill, set its threshold, bypass and undo work.
    await keyboardSelect(page, 1, lifetimes)
    await waitShown(page, { access: 'locked' })
    await tabTo(page, '#xp-threshold-input')
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control')
    await page.keyboard.type('1000')
    await page.keyboard.press('Enter')
    await waitShown(page, { access: 'locked' })
    await page.waitForFunction(() => document.querySelector('#lock-reasons')?.textContent?.includes('Needs 965 more XP'))
    await openSkillList(page)
    check((await readSkillStatus(page, `#skill-status-${lifetimes}`)).access === 'locked' && (await text(page, `#skill-list-item-${lifetimes}`)).includes('Lifetimes'), 'the list lost the locked Skill')
    await keyboardSelect(page, 1, lifetimes)
    await tabTo(page, '#access-override-btn')
    await page.keyboard.press('Enter')
    await waitShown(page, { access: 'override' })
    await tabTo(page, '#access-override-btn')
    await page.keyboard.press('Enter')
    await waitShown(page, { access: 'locked' })
    await tabTo(page, `#task-completion-btn-${annotate}`)
    await page.keyboard.press('Space')
    await waitShown(page, { xp: 25 })
    check(await page.$eval(`#task-completion-btn-${annotate}`, (el) => (el as HTMLButtonElement).disabled) && await page.$(`#task-locked-${annotate}`) !== null, 'a locked Skill offers completion after undo')
    s = await stored(page, pathA)
    check(storedSkill(s, lifetimes).xpThreshold === 1000 && !storedTask(s, annotate).completed && storedSkill(s, lifetimes).mastery && s.xp === 25, 'keyboard actions were not stored')
    pass('keyboard and list', 'list ↓ Enter selected locked Lifetimes; Tab/Enter set threshold 1000 ("Needs 965 more XP"), toggled the bypass, and Space undid its Task (XP 25); Mastery stays declared')

    // 9. Another Path's XP never counts here.
    const recordBefore = (await shown(page)).history
    await closeEditorPanels(page)
    await page.click('#back-to-workspace')
    await page.waitForSelector('#personal-workspace')
    const pathB = await createPath(page, 'Jazz Guitar', 'Comp through a blues')
    await addSkill(page, 'Shell voicings', 'Voice ii-V-I changes')
    const voicingTask = await addTask(page, 'Learn three voicings')
    await waitForState(page, 'saved')
    await page.waitForSelector(`#task-learning-${voicingTask}[data-tracked="true"]`)
    await setNumber(page, `task-reward-${voicingTask}`, 2000)
    await page.click(`#task-completion-btn-${voicingTask}`)
    await waitShown(page, { xp: 2000 })
    await closeEditorPanels(page)
    await page.click('#back-to-workspace')
    await page.waitForSelector(`[data-learning-path-id="${pathA}"] a`)
    await page.click(`[data-learning-path-id="${pathA}"] a`)
    await openEditor(page, 2)
    await select(page, lifetimes)
    await waitShown(page, { xp: 25, access: 'locked' })
    check((await shown(page)).reasons.includes('Needs 975 more XP: the threshold is 1000 and this Path has 25 XP'), `cross-Path reasons ${JSON.stringify((await shown(page)).reasons)}`)
    check((await stored(page, pathB)).xp === 2000 && (await stored(page, pathA)).xp === 25, 'the Paths share XP')
    pass('cross-Path XP', `Jazz Guitar shows Path XP 2000; Systems Rust still shows 25 and keeps Lifetimes locked at threshold 1000`)

    // 10. Reload restores every learning record; none of the learning actions changed the document revision.
    const beforeReload = await stored(page, pathA)
    await page.reload({ waitUntil: 'networkidle0' })
    await openEditor(page, 2)
    await select(page, lifetimes)
    await waitShown(page, { xp: 25, access: 'locked', mastery: 'declared' })
    check(await fieldValue(page, '#xp-threshold-input') === '1000' && await contribution(page, annotate) === 'Not complete · contributes 0 XP', 'Lifetimes reopened differently')
    check(JSON.stringify((await shown(page)).history) === JSON.stringify(recordBefore), 'the XP record of Lifetimes changed on reload')
    await select(page, ownership)
    await waitShown(page, { mastery: 'declared' })
    check(await contribution(page, chapter) === 'Complete · contributes 25 XP' && await contribution(page, borrow) === 'Not complete · contributes 0 XP' && await fieldValue(page, `#task-reward-${borrow}`) === '50', 'Ownership reopened differently')
    check(recordBefore.length === 2 && (await shown(page)).history.length === 7, `Ownership XP record after reload: ${JSON.stringify((await shown(page)).history)}`)
    check(JSON.stringify(await stored(page, pathA)) === JSON.stringify(beforeReload), 'reloading changed the records')
    check(await revisionOf(page, pathA) === authoredRevision && (await saveState(page)).revision === authoredRevision, `learning actions changed the document revision (${authoredRevision} → ${await revisionOf(page, pathA)})`)
    pass('reload', `Path XP 25, thresholds, rewards, completions, both declarations and the XP records (7 for Ownership, 2 for Lifetimes) reopen; document revision still ${authoredRevision}`)

    // 11. Without WebGPU, the list still reaches the same records and actions by keyboard.
    const noGpu = await context.newPage()
    noGpu.setDefaultTimeout(10000)
    noGpu.on('pageerror', (error) => pageErrors.push(String(error)))
    noGpu.on('dialog', (dialog) => { dialogs.push(`${dialog.type()}: ${dialog.message()}`); void dialog.accept() })
    await noGpu.evaluateOnNewDocument(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true })
    })
    await noGpu.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
    await noGpu.goto(`${ORIGIN}/paths/${pathA}`, { waitUntil: 'networkidle0' })
    await openEditor(noGpu, 2, 'unsupported')
    await openSkillList(noGpu)
    await noGpu.waitForSelector(`#skill-status-${lifetimes}[data-access="locked"]`)
    await keyboardSelect(noGpu, 1, lifetimes)
    await waitShown(noGpu, { xp: 25, access: 'locked', mastery: 'declared' })
    check((await shown(noGpu)).reasons.length === 1 && await text(noGpu, '#selected-skill-title') === 'Lifetimes', 'the list-only view lost the lock reason or title')
    await tabTo(noGpu, '#mastery-btn')
    await noGpu.keyboard.press('Enter')
    await waitShown(noGpu, { mastery: 'unclaimed', xp: 25 })
    check(!storedSkill(await stored(noGpu, pathA), lifetimes).mastery, 'the list-only withdrawal was not stored')
    await tabTo(noGpu, '#mastery-btn')
    await noGpu.keyboard.press('Enter')
    await waitShown(noGpu, { mastery: 'declared', xp: 25 })
    await noGpu.close()
    pass('no WebGPU', 'list-only page shows Lifetimes locked with its reason; keyboard withdrew and re-declared its Mastery (XP 25 throughout)')

    // 12. Another Account cannot read or change these records.
    const beforeGrace = await stored(page, pathA)
    await signOut(page)
    await authenticate(page, 'sign-up', 'grace@gurow.test')
    const graceRead = await api(page, `/personal/learning-paths/${pathA}/learning-state`)
    const graceActs = await Promise.all([
      api(page, `/personal/learning-paths/${pathA}/tasks/${chapter}/completion`, 'DELETE'),
      api(page, `/personal/learning-paths/${pathA}/skills/${lifetimes}/xp-threshold`, 'PUT', { xpThreshold: 0 }),
      api(page, `/personal/learning-paths/${pathA}/skills/${lifetimes}/access-override`, 'PUT'),
    ])
    check(graceRead.status === 404 && graceActs.every((r) => r.status === 404), `another Account answered ${graceRead.status}, ${graceActs.map((r) => r.status)}`)
    await signOut(page)
    await authenticate(page, 'sign-in', 'ada@gurow.test')
    check(JSON.stringify(await stored(page, pathA)) === JSON.stringify(beforeGrace), 'another Account changed the records')
    pass('unauthorized Account', `Grace: read ${graceRead.status}, actions ${graceActs.map((r) => r.status).join('/')}; Ada's records unchanged`)

    check(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
    check(dialogs.length === 0, `unexpected dialogs (a reason or confirmation was asked): ${dialogs}`)
    console.log(`\nT17 personal learning check passed (${steps.length} steps).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t17-failure.png')
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
  console.error(`\nT17 personal learning check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
