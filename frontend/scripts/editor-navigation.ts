import type { Page } from 'puppeteer-core'

/** Dismiss temporary navigation through its real controls before canvas input. */
export async function closeEditorPanels(page: Page) {
  // A Task Board (and its Task details) sits above everything else: close it first.
  for (const selector of ['#btn-close-card-details', '#board-close-btn']) {
    const button = await page.$(selector)
    if (button && await button.isVisible()) {
      await button.click()
      await page.waitForSelector(selector, { hidden: true })
    }
  }
  for (const selector of ['#btn-close-skill-list', '#btn-close-skill-details', '#btn-close-add-skill', '#btn-close-more-actions', '#btn-close-coach-review']) {
    const button = await page.$(selector)
    if (button && await button.isVisible()) {
      await button.click()
      await page.waitForSelector(selector, { hidden: true })
    }
  }
}

/** Open the actual list, including when the renderer is unavailable. */
export async function openSkillList(page: Page) {
  if (await page.$('#skill-prerequisite-list')) return
  await closeEditorPanels(page)
  await page.waitForSelector('#btn-skill-list:not([disabled])', { visible: true })
  await page.focus('#btn-skill-list')
  await page.keyboard.press('Enter')
  await page.waitForSelector('#skill-prerequisite-list', { visible: true })
}

/** Inspect the temporary list, then return to the previously open Skill. */
export async function readSkillStatus(page: Page, selector: string): Promise<Record<string, string>> {
  const selected = await page.$eval('#selected-skill-id', el => el.textContent?.trim()).catch(() => null)
  const alreadyOpen = await page.$('#skill-prerequisite-list') !== null
  await openSkillList(page)
  const status = await page.$eval(selector, el => ({ ...(el as HTMLElement).dataset })) as Record<string, string>
  if (selected) await selectSkillFromList(page, selected)
  else if (!alreadyOpen) await closeEditorPanels(page)
  return status
}

/** A page-level action followed by an explicit return to the same Skill. */
export async function clickOutsideDetails(page: Page, selector: string) {
  const selected = await page.$eval('#selected-skill-id', el => el.textContent?.trim()).catch(() => null)
  await closeEditorPanels(page)
  await page.click(selector)
  if (selected) await selectSkillFromList(page, selected)
}

/** Open authoring controls rather than filling a permanently mounted sidebar. */
export async function openNewSkill(page: Page) {
  await closeEditorPanels(page)
  await page.click('#editor-add-card-btn')
  await page.waitForSelector('#new-skill-title', { visible: true })
}

/**
 * A Skill's [Access, Mastery] from its always-mounted card label. Reading the Skill list instead
 * would close and reopen an open summary (UX01, #47), remounting in-flight review state.
 */
export async function readCardProgress(page: Page, skillId: string): Promise<[string, string]> {
  return page.$eval(`#card-status-${skillId}`, (el) => {
    const d = (el as HTMLElement).dataset
    return [d.locked === 'true' ? 'locked' : 'open', d.mastered === 'true' ? 'mastered' : 'not-mastered'] as [string, string]
  })
}

/** The Coach's queue of work awaiting Review is a temporary panel since UX01 (#47). */
export async function openCoachReview(page: Page) {
  if (await page.$('#awaiting-review')) return
  await closeEditorPanels(page)
  await page.waitForSelector('#btn-coach-review', { visible: true })
  await page.focus('#btn-coach-review')
  await page.keyboard.press('Enter')
  await page.waitForSelector('#awaiting-review', { visible: true })
}

/**
 * Waits for the Coach's queue to hold `count` revisions. The queue stays open when no Skill
 * was open; otherwise the same Skill is reopened, as a Coach would return to it.
 */
export async function waitAwaitingReview(page: Page, count: number) {
  const selected = await page.$eval('#selected-skill-id', el => el.textContent?.trim()).catch(() => null)
  await openCoachReview(page)
  await page.waitForSelector(`#awaiting-review[data-count="${count}"]`)
  if (selected) await selectSkillFromList(page, selected)
}

export async function openMoreActions(page: Page) {
  await closeEditorPanels(page)
  await page.click('#btn-more-actions')
  await page.waitForSelector('#btn-close-more-actions', { visible: true })
}

/** Keyboard navigation browses options; only Enter commits selection. */
export async function selectSkillFromList(page: Page, id: string) {
  await openSkillList(page)
  const ids = await page.$$eval('#skill-prerequisite-list [role="option"]', els => els.map(el => el.id.slice('skill-list-item-'.length)))
  const index = ids.indexOf(id)
  if (index < 0) throw new Error(`Skill ${id} missing from the open Skill list`)
  await page.focus('#skill-prerequisite-list')
  await page.keyboard.press('Home')
  for (let i = 0; i < index; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.waitForFunction(want => document.querySelector('#selected-skill-id')?.textContent?.trim() === want, {}, id)
  await page.waitForSelector('#btn-close-skill-details', { visible: true })
}

export type SkillView = 'summary' | 'tasks' | 'edit' | 'prerequisites' | 'history'
/** Activates a control itself: panels resize as records arrive, so a screen point can land on a moved control. */
const activate = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLElement).click())
const VIEW_BUTTON: Record<Exclude<SkillView, 'summary'>, string> = {
  tasks: '#open-skill-tasks-btn', edit: '#edit-skill-btn', prerequisites: '#manage-prerequisites-btn', history: '#skill-history-btn',
}

/**
 * Opens one view of the open Skill summary (its Tasks where there is no board, Edit, Manage
 * prerequisites, History) through its real button, returning to the summary first if needed.
 */
export async function openSkillView(page: Page, view: SkillView) {
  await page.waitForSelector('#skill-detail-panel[data-view]', { visible: true })
  const current = () => page.$eval('#skill-detail-panel', (el) => (el as HTMLElement).dataset.view)
  // A records read can re-render the summary as a button is activated: check, then activate again.
  for (let attempt = 0; ; attempt++) {
    const shown = await current()
    if (shown === view) return
    const button = shown !== 'summary' ? '#btn-back-skill-summary' : VIEW_BUTTON[view as Exclude<SkillView, 'summary'>]
    const target = shown !== 'summary' ? 'summary' : view
    try {
      await page.waitForSelector(button, { visible: true, timeout: 3000 })
      await activate(page, button)
      await page.waitForFunction((want: string) => (document.querySelector('#skill-detail-panel') as HTMLElement | null)?.dataset.view === want, { timeout: 3000 }, target)
    } catch (error) {
      if (attempt >= 4) throw error
    }
  }
}

/** Opens the summary's Skill actions menu (archival, deletion). */
export async function openSkillActions(page: Page) {
  await openSkillView(page, 'summary')
  if (!await page.$('#skill-actions-menu')) await activate(page, '#skill-actions-btn')
  await page.waitForSelector('#skill-actions-menu', { visible: true })
}

/**
 * Opens the selected Skill's Task Board from its summary and waits until it is loaded. It may
 * still wait for this tab's Tasks (an unsaved document) or hold unsaved board changes.
 */
export async function openSummaryBoard(page: Page) {
  await openSkillView(page, 'summary')
  await page.waitForSelector('#open-board-btn', { visible: true })
  await activate(page, '#open-board-btn')
  await page.waitForSelector('#task-board[open] #board-columns > section')
  await page.waitForFunction(() => (document.querySelector('#board-save-status') as HTMLElement | null)?.dataset.state !== 'saving')
}

/** Closes an open Task Board (and Task details) back to the Skill summary. */
export async function closeSummaryBoard(page: Page) {
  if (await page.$('#card-details')) {
    await activate(page, '#btn-close-card-details')
    await page.waitForSelector('#card-details', { hidden: true })
  }
  if (!await page.$('#task-board[open]')) return
  await activate(page, '#board-close-btn')
  await page.waitForSelector('#task-board', { hidden: true })
}

/** Adds a Task through the open board's first column and returns its new ID once its card shows. */
export async function addBoardTask(page: Page, title: string, description = '') {
  const before = await page.$$eval('#board-columns [data-card-id]', (cards) => cards.map((c) => (c as HTMLElement).dataset.cardId!))
  const column = await page.$eval('#board-columns > section', (el) => (el as HTMLElement).dataset.dropColumn!)
  await activate(page, `#add-card-${column}`)
  await page.waitForSelector('#new-card-title', { visible: true })
  await page.type('#new-card-title', title)
  if (description) await page.type('#new-card-description', description)
  await activate(page, '#new-card-submit')
  const handle = await page.waitForFunction((known: string[]) => [...document.querySelectorAll<HTMLElement>('#board-columns [data-card-id]')].map((c) => c.dataset.cardId!).find((id) => !known.includes(id)) ?? false, {}, before)
  return await handle.jsonValue() as string
}

/** Opens a board card's Task details. */
export async function openCardDetails(page: Page, taskId: string) {
  if (await page.$(`#card-details[data-task-id="${taskId}"]`)) return
  if (await page.$('#card-details')) {
    await activate(page, '#btn-close-card-details')
    await page.waitForSelector('#card-details', { hidden: true })
  }
  // A board read can move cards between columns at any moment: activate the element itself, not a
  // screen point, and again if a re-render swallowed the activation.
  for (let attempt = 0; ; attempt++) {
    await page.waitForSelector(`#card-details-${taskId}`, { visible: true })
    await page.$eval(`#card-details-${taskId}`, (el) => (el as HTMLButtonElement).click())
    try {
      await page.waitForSelector(`#card-details[data-task-id="${taskId}"]`, { visible: true, timeout: 3000 })
      return
    } catch (error) {
      if (attempt >= 2) throw error
    }
  }
}

/** Edits a Task's title and description from its board details, as an author does. */
export async function editBoardTask(page: Page, taskId: string, change: { title?: string; description?: string }) {
  await openCardDetails(page, taskId)
  const set = async (selector: string, value: string) => page.$eval(selector, (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
  if (change.title !== undefined) await set('#card-edit-title', change.title)
  if (change.description !== undefined) await set('#card-edit-description', change.description)
  await activate(page, '#card-edit-save')
}

/**
 * Opens one Task's own controls wherever the open Skill's context keeps them: a Task Board's
 * details where the context has a board (personal, Coach Draft, learner), otherwise the
 * summary's Tasks view (fixture editor, Coach Review). Returns the ID prefix those controls
 * use there: 'board-' on a personal or Draft board, '' elsewhere.
 */
export async function openTask(page: Page, taskId: string): Promise<string> {
  const prefix = async () => (await page.$('#enrolled-version') ? '' : 'board-')
  if (await page.$('#task-board[open]')) {
    await openCardDetails(page, taskId)
    return prefix()
  }
  await openSkillView(page, 'summary')
  if (await page.$('#open-board-btn')) {
    await openSummaryBoard(page)
    await openCardDetails(page, taskId)
    return prefix()
  }
  await openSkillView(page, 'tasks')
  await page.waitForSelector(`#task-container-${taskId}`)
  return ''
}
