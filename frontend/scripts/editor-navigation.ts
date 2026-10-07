import type { Page } from 'puppeteer-core'

/** Dismiss temporary navigation through its real controls before canvas input. */
export async function closeEditorPanels(page: Page) {
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
