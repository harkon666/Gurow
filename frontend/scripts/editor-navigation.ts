import type { Page } from 'puppeteer-core'

/** Dismiss temporary navigation through its real controls before canvas input. */
export async function closeEditorPanels(page: Page) {
  for (const selector of ['#btn-close-skill-list', '#btn-close-skill-details', '#btn-close-add-skill', '#btn-close-more-actions']) {
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
