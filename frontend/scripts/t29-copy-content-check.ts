#!/usr/bin/env bun
/**
 * T29 copy check (#30): the production frontend build forwarding /api to the
 * production backend entry (Better Auth sessions) on a freshly migrated PostgreSQL
 * database, with email through the Resend HTTP mailer to a local stand-in, in headless
 * Chromium with WebGPU. Real Accounts copy content from the editor's "Copy from a
 * Path" panel: Pat copies two Skills with their Tasks (and the one Prerequisite between
 * them) and a single Task from a personal Path holding his completion, reward and
 * Mastery into another personal Path; Carla copies a Skill of a published Version in
 * which Lena holds an Approval, XP and Mastery, a Task of that Version, and a Skill of
 * her own personal Path into another Path's Draft. Both edit the copies and reload both
 * sides: the copies have new IDs, the sources are unchanged, and no completion, XP,
 * Mastery, Submission or Approval follows a copy, also once Lena joins the Version
 * published from it. Sources list only the Account's own content; a learner's
 * Enrollment is no source; published content takes no copy.
 *
 * Run from frontend: bun run scripts/t29-copy-content-check.ts [--skip-build]
 */
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { startResendStandIn } from '../../backend/test/support/resend-stand-in'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'

const FRONTEND = path.resolve(import.meta.dir, '..')
const BACKEND = path.resolve(FRONTEND, '../backend')
const PORT = Number(process.env.PORT ?? 3551)
const API_PORT = Number(process.env.API_PORT ?? 3552)
const ORIGIN = `http://127.0.0.1:${PORT}`
const SECRET = 't29-browser-check-secret-not-for-production'
const DATABASE_URL = process.env.T29_DATABASE_URL ?? 'postgres://gurow:gurow@127.0.0.1:5433/gurow_t29_browser_test'
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
const labelIds = (page: Page) => page.$$eval('[id^="card-label-"]', (els) => els.map((el) => el.id.replace('card-label-', '')))
async function openEditor(page: Page, url: string, cards: number) {
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#path-editor[data-gpu-status="ready"]', { timeout: 20000 }).catch(async () => {
    throw new Error(`the editor did not reach WebGPU 'ready' (status ${await page.$eval('#path-editor', (el) => (el as HTMLElement).dataset.gpuStatus).catch(() => 'absent')})`)
  })
  await page.waitForFunction((n: number) => document.querySelectorAll('[id^="card-label-"]').length === n, {}, cards)
}
/** Selects a Skill by clicking its card on the WebGPU canvas. */
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
/** Opens the copy panel and reads the source whose option is labelled `label`; returns every offered label. */
async function openSource(page: Page, label: string) {
  await page.click('#open-reuse-btn')
  await page.waitForSelector('#reuse-source')
  const offered = await page.$$eval('#reuse-source option', (els) => els.map((el) => ({ value: (el as HTMLOptionElement).value, label: el.textContent ?? '', group: (el.parentElement as HTMLOptGroupElement).label ?? '' })).filter((o) => o.value !== ''))
  const option = offered.find((o) => o.label === label)
  check(option, `"${label}" is not offered; offered: ${offered.map((o) => o.label).join(' | ')}`)
  await page.select('#reuse-source', option.value)
  await page.waitForSelector('#reuse-skills')
  return offered
}
const sourceSkill = (page: Page, title: string) => page.$eval(`#reuse-skills [data-source-skill="${title}"] input[type="checkbox"]`, (el) => el.id)
const sourceTask = (page: Page, title: string) => page.$eval(`#reuse-skills [data-source-task="${title}"] button`, (el) => el.id)
/** Copies the chosen source Skills; returns the IDs of the cards the copy added. */
async function copySkills(page: Page, titles: string[]) {
  for (const title of titles) await page.click(`#${await sourceSkill(page, title)}`)
  const before = await labelIds(page)
  await page.click('#reuse-copy-skills-btn')
  await page.waitForFunction((n: number) => document.querySelectorAll('[id^="card-label-"]').length === n, {}, before.length + titles.length)
  await page.waitForFunction(() => document.querySelector('#reuse-panel') === null)
  return (await labelIds(page)).filter((id) => !before.includes(id))
}
async function copyTaskInto(page: Page, taskTitle: string, skillId: string) {
  await page.select('#reuse-task-destination', skillId)
  await page.click(`#${await sourceTask(page, taskTitle)}`)
  await page.waitForSelector('#reuse-result')
  const result = await text(page, '#reuse-result')
  await page.click('#reuse-close-btn')
  return result
}
const allIds = (doc: Doc) => doc.application.skills.flatMap((s) => [s.id, ...s.tasks.map((t) => t.id)])
const edges = (connections: { from_id: string; to_id: string }[]) => connections.map((c) => `${c.from_id}>${c.to_id}`).sort()
const skillNamed = (doc: Doc, title: string) => {
  const found = doc.application.skills.filter((s) => s.title === title)
  check(found.length === 1, `expected one Skill "${title}", found ${found.length}`)
  return found[0]
}

/** A personal Path written through the owner's API: the source Pat copies from. */
async function personalSource(page: Page) {
  const created = await ok(page, '/personal/learning-paths', 'POST', { title: 'Rust Basics', goal: 'Write safe Rust' })
  const id = { ownership: crypto.randomUUID(), lifetimes: crypto.randomUUID(), traits: crypto.randomUUID(), borrow: crypto.randomUUID(), chapter: crypto.randomUUID(), annotate: crypto.randomUUID(), impl: crypto.randomUUID() }
  const card = (skill: string, title: string, x: number, y: number) => ({ id: skill, title, position: { x, y } })
  await ok(page, `/personal/learning-paths/${created.learningPath.id}/document`, 'PUT', {
    expectedRevision: created.learningPath.revision, title: 'Rust Basics', goal: 'Write safe Rust',
    editor: { format_version: 1, cards: [card(id.ownership, 'Ownership', 80, 120), card(id.lifetimes, 'Lifetimes', 420, 80), card(id.traits, 'Traits', 420, 300)], connections: [{ from_id: id.ownership, to_id: id.lifetimes }, { from_id: id.ownership, to_id: id.traits }] },
    application: { skills: [
      { id: id.ownership, title: 'Ownership', outcome: 'Explain moves and borrows', tasks: [{ id: id.borrow, title: 'Borrow checker exercises', description: 'Fix ten borrow errors' }, { id: id.chapter, title: 'Read the ownership chapter', description: 'Chapter 4' }] },
      { id: id.lifetimes, title: 'Lifetimes', outcome: 'Annotate lifetimes', tasks: [{ id: id.annotate, title: 'Annotate lifetimes', description: 'Five functions' }] },
      { id: id.traits, title: 'Traits', outcome: 'Implement traits', tasks: [{ id: id.impl, title: 'Implement Display', description: '' }] },
    ] },
  })
  const at = `/personal/learning-paths/${created.learningPath.id}`
  // Pat's own learning records in the source: a 20-XP completion and declared Mastery.
  await ok(page, `${at}/tasks/${id.borrow}/reward`, 'PUT', { xpReward: 20 })
  await ok(page, `${at}/tasks/${id.borrow}/completion`, 'PUT')
  await ok(page, `${at}/skills/${id.ownership}/mastery`, 'PUT')
  return { pathId: created.learningPath.id as string, ...id }
}

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

    // 1. Pat copies two Skills with their Tasks from a personal Path holding his records into another one.
    const pat = await newPage(browser, errors)
    await act(pat)
    await authenticate(pat, 'sign-up', 'pat@gurow.test')
    const rust = await personalSource(pat)
    const sourceBefore: Doc = await ok(pat, `/personal/learning-paths/${rust.pathId}`)
    const sourceRecords = (await ok(pat, `/personal/learning-paths/${rust.pathId}/learning-state`)).learningState
    check(sourceRecords.xp === 20 && sourceRecords.skills.find((s: any) => s.skillId === rust.ownership).mastery === true, `source records: ${JSON.stringify(sourceRecords)}`)
    const systems = await ok(pat, '/personal/learning-paths', 'POST', { title: 'Systems Programming', goal: 'Build a small OS' })
    const memory = crypto.randomUUID()
    await ok(pat, `/personal/learning-paths/${systems.learningPath.id}/document`, 'PUT', {
      expectedRevision: systems.learningPath.revision, title: 'Systems Programming', goal: 'Build a small OS',
      editor: { format_version: 1, cards: [{ id: memory, title: 'Memory', position: { x: 80, y: 120 } }], connections: [] },
      application: { skills: [{ id: memory, title: 'Memory', outcome: 'Manage memory by hand', tasks: [] }] },
    })
    const systemsUrl = `${ORIGIN}/paths/${systems.learningPath.id}`
    await openEditor(pat, systemsUrl, 1)
    const patOffered = await openSource(pat, 'Rust Basics')
    check(patOffered.every((o) => o.group === 'Personal Workspace') && patOffered.map((o) => o.label).sort().join('|') === 'Rust Basics|Systems Programming', `Pat is offered ${JSON.stringify(patOffered)}`)
    await pat.click(`#${await sourceSkill(pat, 'Ownership')}`)
    await pat.click(`#${await sourceSkill(pat, 'Lifetimes')}`)
    const prerequisiteNote = await text(pat, '#reuse-prerequisites')
    check(prerequisiteNote === 'Keeps 1 Prerequisite between the chosen Skills. 1 Prerequisite on Skills not chosen is not copied; connect the copies in this Path instead.', `prerequisite note: ${prerequisiteNote}`)
    await pat.click(`#${await sourceSkill(pat, 'Ownership')}`)
    await pat.click(`#${await sourceSkill(pat, 'Lifetimes')}`)
    const added = await copySkills(pat, ['Ownership', 'Lifetimes'])
    await waitForSaved(pat)
    let copied: Doc = await ok(pat, `/personal/learning-paths/${systems.learningPath.id}`)
    const ownershipCopy = skillNamed(copied, 'Ownership'), lifetimesCopy = skillNamed(copied, 'Lifetimes')
    check(added.sort().join() === [ownershipCopy.id, lifetimesCopy.id].sort().join(), `added cards ${added} are not the stored copies`)
    const sourceIds = new Set(allIds(sourceBefore))
    const copyIds = [...allIds(copied)].filter((id) => id !== memory)
    check(copyIds.length === 5 && copyIds.every((id) => !sourceIds.has(id)), `copy IDs ${copyIds} reuse a source ID`)
    check(JSON.stringify(ownershipCopy.tasks.map((t) => [t.title, t.description])) === JSON.stringify([['Borrow checker exercises', 'Fix ten borrow errors'], ['Read the ownership chapter', 'Chapter 4']]) && ownershipCopy.outcome === 'Explain moves and borrows', `Ownership copy: ${JSON.stringify(ownershipCopy)}`)
    check(JSON.stringify(edges(copied.editor.connections)) === JSON.stringify([`${ownershipCopy.id}>${lifetimesCopy.id}`]), `copied Prerequisites: ${JSON.stringify(copied.editor.connections)}`)
    const memoryCard = copied.editor.cards.find((c) => c.id === memory)!
    const copyCards = copied.editor.cards.filter((c) => c.id !== memory)
    check(copyCards.every((c) => c.position.x > memoryCard.position.x + 200), `copied cards overlap the destination: ${JSON.stringify(copied.editor.cards)}`)
    const notice = await text(pat, '#reuse-notice')
    check(notice === 'Copied 2 Skills with 3 Tasks from Rust Basics as new content of this Path.', `notice: ${notice}`)
    check(await text(pat, '#selected-skill-id') === ownershipCopy.id, 'the first copy is not selected')
    pass('personal Skill copy', `Ownership + Lifetimes copied with 3 Tasks and the 1 Prerequisite between them (Ownership → Traits left behind); 5 new IDs, none from the source; rev ${copied.learningPath.revision}`)

    // 2. One Task copied alone into a Skill of the destination.
    await openSource(pat, 'Rust Basics')
    const taskResult = await copyTaskInto(pat, 'Implement Display', memory)
    check(taskResult === 'Copied “Implement Display” into “Memory” as a new Task.', `task result: ${taskResult}`)
    await waitForSaved(pat)
    copied = await ok(pat, `/personal/learning-paths/${systems.learningPath.id}`)
    const memoryTasks = skillNamed(copied, 'Memory').tasks
    check(memoryTasks.length === 1 && memoryTasks[0].title === 'Implement Display' && memoryTasks[0].id !== rust.impl && !sourceIds.has(memoryTasks[0].id), `Memory's Tasks: ${JSON.stringify(memoryTasks)}`)
    pass('personal Task copy', `"Implement Display" copied alone into Memory as Task ${memoryTasks[0].id.slice(0, 8)} (source ${rust.impl.slice(0, 8)})`)

    // 3. The copies carry no records; editing them leaves the source and its records alone, across reloads.
    await select(pat, ownershipCopy.id)
    await pat.waitForSelector(`#task-learning-${ownershipCopy.tasks[0].id}[data-completed="false"]`)
    check((await data(pat, '#skill-mastery')).mastery === 'unclaimed' && (await data(pat, '#path-xp')).xp === '0', `copy shows records: mastery ${(await data(pat, '#skill-mastery')).mastery}, XP ${(await data(pat, '#path-xp')).xp}`)
    await setValue(pat, '#skill-outcome-input', 'Explain moves in kernel code')
    await setValue(pat, `#task-edit-title-${ownershipCopy.tasks[0].id}`, 'Borrow checker kata')
    await waitForSaved(pat)
    const copyRecords = (await ok(pat, `/personal/learning-paths/${systems.learningPath.id}/learning-state`)).learningState
    check(copyRecords.xp === 0 && copyRecords.xpHistory.length === 0 && copyRecords.masteryHistory.length === 0 && copyRecords.tasks.every((t: any) => !t.completed && t.xpReward === 0), `copy records: ${JSON.stringify(copyRecords)}`)
    await pat.reload({ waitUntil: 'networkidle0' })
    await openEditor(pat, systemsUrl, 3)
    await select(pat, ownershipCopy.id)
    check(await fieldValue(pat, '#skill-outcome-input') === 'Explain moves in kernel code' && await fieldValue(pat, `#task-edit-title-${ownershipCopy.tasks[0].id}`) === 'Borrow checker kata', 'the edited copy did not reload')
    await openEditor(pat, `${ORIGIN}/paths/${rust.pathId}`, 3)
    await select(pat, rust.ownership)
    check(await fieldValue(pat, '#skill-outcome-input') === 'Explain moves and borrows' && await fieldValue(pat, `#task-edit-title-${rust.borrow}`) === 'Borrow checker exercises', 'the source shows the copy\'s edits')
    check((await data(pat, '#skill-mastery')).mastery === 'declared' && (await data(pat, '#path-xp')).xp === '20', 'the source lost its records')
    check(JSON.stringify(await ok(pat, `/personal/learning-paths/${rust.pathId}`)) === JSON.stringify(sourceBefore), 'the source document changed')
    pass('personal independence', `copy edited (outcome, Task title) and reloaded with XP 0, no completion or Mastery; source reloads unchanged with XP 20 and declared Mastery`)

    // 4. Carla's published Version, in which Lena holds an Approval, 20 XP and Mastery of Vectors.
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
    const sent = await ok(lena, `/enrollments/${enrollment}/tasks/${la.drills}/submission/revisions`, 'POST', { text: 'Vector evidence', urls: [] })
    await ok(carla, `/enrollments/${enrollment}/tasks/${la.drills}/submission/revisions/${sent.revision.id}/review`, 'POST', { decision: 'approval' })
    const lenaBefore = (await ok(lena, `/enrollments/${enrollment}/learning-state`)).learningState
    check(lenaBefore.xp === 20 && lenaBefore.skills.find((s: any) => s.skillId === la.vectors).mastery === true, `Lena's records: ${JSON.stringify(lenaBefore)}`)
    const versionBefore: Doc = await ok(carla, `/coach/learning-path-versions/${la.versionId}`)
    // Carla's own personal Path, a source for her Draft too.
    const notes = await ok(carla, '/personal/learning-paths', 'POST', { title: 'Carla notes', goal: '' })
    const proofs = crypto.randomUUID(), proofTask = crypto.randomUUID()
    await ok(carla, `/personal/learning-paths/${notes.learningPath.id}/document`, 'PUT', {
      expectedRevision: notes.learningPath.revision, title: 'Carla notes', goal: '',
      editor: { format_version: 1, cards: [{ id: proofs, title: 'Proof writing', position: { x: 0, y: 0 } }], connections: [] },
      application: { skills: [{ id: proofs, title: 'Proof writing', outcome: 'Write a direct proof', tasks: [{ id: proofTask, title: 'Prove the triangle inequality', description: 'One page' }] }] },
    })
    pass('coach source', `Version 1 of Linear Algebra published; Lena approved on Vector drills: XP 20, Mastery of Vectors`)

    // 5. Carla copies from the Version into another Path's Draft, with its Draft rules.
    const engineers = await ok(carla, `/coach/workspaces/${workspace.id}/learning-paths`, 'POST', { title: 'Linear Algebra for Engineers', goal: 'Forces and frames' })
    const engineersUrl = `${ORIGIN}/coach/paths/${engineers.learningPath.id}`
    await openEditor(carla, engineersUrl, 0)
    const carlaOffered = await openSource(carla, 'Linear Algebra · Version 1')
    const carlaLabels = carlaOffered.map((o) => o.label)
    check(carlaLabels.includes('Carla notes') && carlaLabels.includes('Linear Algebra for Engineers · Draft (Version 1)') && !carlaLabels.some((l) => l.includes('Rust') || l.includes('Systems')), `Carla is offered ${carlaLabels.join(' | ')}`)
    check(await text(carla, '#reuse-rules-note') === 'Required and Enrichment Tasks, rewards, Optional Skills and XP Thresholds are copied as Draft rules.', `rules note: ${await text(carla, '#reuse-rules-note')}`)
    const [vectorsCopyId] = await copySkills(carla, ['Vectors'])
    await waitForSaved(carla)
    await openSource(carla, 'Linear Algebra · Version 1')
    check(await carla.$eval(`#${await sourceTask(carla, 'Matrix drills')}`, (el) => (el as HTMLButtonElement).disabled) === false, 'Task copy is disabled')
    await copyTaskInto(carla, 'Matrix drills', vectorsCopyId)
    await waitForSaved(carla)
    await openSource(carla, 'Carla notes')
    check(await text(carla, '#reuse-rules-note') === 'Copies start as required Skills without a threshold and Required Tasks worth 0 XP; set their rules in this Draft.', `personal → Draft note: ${await text(carla, '#reuse-rules-note')}`)
    const [proofsCopyId] = await copySkills(carla, ['Proof writing'])
    await waitForSaved(carla)
    let draft: Doc = await ok(carla, `/coach/learning-paths/${engineers.learningPath.id}`)
    const vectorsCopy = skillNamed(draft, 'Vectors'), proofsCopy = skillNamed(draft, 'Proof writing')
    check(vectorsCopy.id === vectorsCopyId && proofsCopy.id === proofsCopyId && draft.editor.connections.length === 0, `Draft copies: ${JSON.stringify(draft.application.skills.map((s) => s.id))}, connections ${JSON.stringify(draft.editor.connections)}`)
    check(JSON.stringify(vectorsCopy.tasks.map((t) => [t.title, t.required, t.xpReward])) === JSON.stringify([['Vector drills', true, 20], ['Read chapter 1', false, 0], ['Matrix drills', true, 15]]), `Vectors copy Tasks: ${JSON.stringify(vectorsCopy.tasks)}`)
    check(JSON.stringify(proofsCopy) === JSON.stringify({ id: proofsCopyId, title: 'Proof writing', outcome: 'Write a direct proof', optional: false, xpThreshold: 0, tasks: [{ id: proofsCopy.tasks[0].id, title: 'Prove the triangle inequality', description: 'One page', required: true, xpReward: 0 }] }), `Proof writing copy: ${JSON.stringify(proofsCopy)}`)
    const versionIds = new Set(allIds(versionBefore))
    check(allIds(draft).every((id) => !versionIds.has(id) && id !== proofs && id !== proofTask), 'a Draft copy reuses a source ID')
    pass('coach copies', `Vectors (Vector drills Required 20 XP, Read chapter 1 Enrichment) from Version 1 without its Prerequisite to Matrices, "Matrix drills" (Required 15 XP) alone into it, and "Proof writing" from Carla's personal Path as Required 0 XP; all IDs new`)

    // 6. Carla edits the copy and reloads both sides: the Version and Lena's records stay as they were.
    await select(carla, vectorsCopyId)
    await setValue(carla, '#skill-outcome-input', 'Resolve forces into components')
    await setValue(carla, `#task-xp-reward-${vectorsCopy.tasks[0].id}`, '35')
    await waitForSaved(carla)
    await carla.reload({ waitUntil: 'networkidle0' })
    await openEditor(carla, engineersUrl, 2)
    await select(carla, vectorsCopyId)
    check(await fieldValue(carla, '#skill-outcome-input') === 'Resolve forces into components' && await fieldValue(carla, `#task-xp-reward-${vectorsCopy.tasks[0].id}`) === '35', 'the Draft copy edits did not reload')
    await carla.goto(`${ORIGIN}/coach/paths/${la.pathId}`, { waitUntil: 'networkidle0' })
    await carla.waitForSelector('#published-version')
    check(await carla.$('#open-reuse-btn') === null, 'a published Version offers a copy into it')
    check(!(await carla.$eval('body', (el) => el.innerText)).includes('Resolve forces'), 'the source Version shows the copy\'s edit')
    check(JSON.stringify(await ok(carla, `/coach/learning-path-versions/${la.versionId}`)) === JSON.stringify(versionBefore), 'the source Version changed')
    // Without an open Draft, nothing can be written into the published Path.
    const published: Doc = await ok(carla, `/coach/learning-paths/${la.pathId}`)
    const extra = crypto.randomUUID()
    const intoPublished = await api(carla, `/coach/learning-paths/${la.pathId}/draft`, 'PUT', {
      expectedRevision: published.learningPath.revision, title: published.learningPath.title, goal: published.learningPath.goal,
      editor: { ...published.editor, cards: [...published.editor.cards, { id: extra, title: 'Proof writing', position: { x: 800, y: 120 } }] },
      application: { skills: [...published.application.skills, { ...proofsCopy, id: extra, tasks: proofsCopy.tasks.map((t) => ({ ...t, id: crypto.randomUUID() })) }] },
    })
    check(intoPublished.status === 409 && intoPublished.body.error === 'no_open_draft', `a write into the published Path answered ${intoPublished.status} ${JSON.stringify(intoPublished.body)}`)
    check(JSON.stringify((await ok(lena, `/enrollments/${enrollment}/learning-state`)).learningState) === JSON.stringify(lenaBefore), 'Lena\'s records changed')
    pass('coach independence', 'Draft copy edited (outcome, reward 35) and reloaded; Version 1 unchanged, offers no copy, takes no write (409 no_open_draft); Lena\'s records unchanged')

    // 7. Published, the copy is a new learning contract: Lena starts it with nothing.
    draft = await ok(carla, `/coach/learning-paths/${engineers.learningPath.id}`)
    const engineersVersion = (await ok(carla, `/coach/learning-paths/${engineers.learningPath.id}/publication`, 'POST', { expectedRevision: draft.learningPath.revision })).version.id as string
    await act(carla)
    const copyEnrollment = await inviteAndAccept(carla, lena, engineersVersion, 'lena@gurow.test')
    await act(lena)
    await lena.goto(`${ORIGIN}/enrollments/${copyEnrollment}`, { waitUntil: 'networkidle0' })
    await lena.waitForSelector('#enrolled-version[data-gpu-status="ready"]', { timeout: 20000 })
    await lena.waitForFunction(() => (document.querySelector('#enrollment-xp') as HTMLElement | null)?.dataset.xp === '0')
    const copyProgress = (await ok(lena, `/enrollments/${copyEnrollment}/learning-state`)).learningState
    check(copyProgress.xp === 0 && copyProgress.skills.every((s: any) => !s.mastery) && copyProgress.tasks.every((t: any) => !t.approved && t.xpContribution === 0), `the copy's Enrollment: ${JSON.stringify(copyProgress)}`)
    const copiedSubmission = await api(lena, `/enrollments/${copyEnrollment}/tasks/${vectorsCopy.tasks[0].id}/submission`)
    const sourceSubmission = await api(lena, `/enrollments/${copyEnrollment}/tasks/${la.drills}/submission`)
    check(copiedSubmission.status === 404 && copiedSubmission.body.error === 'submission_not_found', `the copied Task has a Submission: ${JSON.stringify(copiedSubmission)}`)
    check(sourceSubmission.status === 404 && sourceSubmission.body.error === 'task_not_found', `the source Task reaches the copy's Enrollment: ${JSON.stringify(sourceSubmission)}`)
    await lena.goto(`${ORIGIN}/enrollments/${enrollment}`, { waitUntil: 'networkidle0' })
    await lena.waitForFunction(() => (document.querySelector('#enrollment-xp') as HTMLElement | null)?.dataset.xp === '20')
    pass('no inherited progress', `Lena's Enrollment in the Version published from the copy shows XP 0, no Mastery, no Approval or Submission; the source Task is not part of it; her first Enrollment still shows XP 20`)

    // 8. Sources are the Account's own content only; an Enrollment is none.
    const lenaSources = await ok(lena, '/reuse/sources')
    check(lenaSources.coach.length === 0 && lenaSources.personal.length === 0, `Lena is offered ${JSON.stringify(lenaSources)}`)
    await act(pat)
    const patSources = await ok(pat, '/reuse/sources')
    check(patSources.coach.length === 0 && patSources.personal.map((p: any) => p.title).sort().join('|') === 'Rust Basics|Systems Programming', `Pat is offered ${JSON.stringify(patSources)}`)
    const patReads = [
      await api(pat, `/coach/learning-path-versions/${la.versionId}`), await api(pat, `/coach/learning-paths/${engineers.learningPath.id}`),
      await api(pat, `/personal/learning-paths/${notes.learningPath.id}`),
    ]
    const carlaReads = [await api(carla, `/personal/learning-paths/${rust.pathId}`), await api(lena, `/personal/learning-paths/${rust.pathId}`)]
    check([...patReads, ...carlaReads].every((r) => r.status === 404), `cross-Account source reads answered ${[...patReads, ...carlaReads].map((r) => r.status)}`)
    pass('source privacy', `Lena (enrolled) has no source; Pat is offered only his Paths; reads of another Account's Version, Draft or Path answer 404`)

    check(errors.length === 0, `page errors: ${errors.join('; ')}`)
    console.log(`\nT29 copy check passed (${steps.length} steps).`)
  } catch (error) {
    const shot = path.resolve(FRONTEND, '../.harness/t29-failure.png')
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
  console.error(`\nT29 copy check FAILED after ${steps.length} steps: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`)
  process.exit(1)
})
