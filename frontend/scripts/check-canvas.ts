import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import type { Page } from 'puppeteer-core'
import { INITIAL_LEARNING_PATH_FIXTURE } from '../src/fixtures/learningPath'

// Exercise framebuffer resolution, fixture identity, hit testing, sidebar data,
// and GPU selection pixels through the real browser boundary.
export async function checkCanvas(page: Page, dpr: number) {
  await page.waitForSelector('#card-label-skill-rust-basics')
  const dimensions = await page.$eval('#editor-canvas', (element) => {
    const canvas = element as HTMLCanvasElement
    const rect = canvas.getBoundingClientRect()
    return { width: canvas.width, height: canvas.height, cssWidth: rect.width, cssHeight: rect.height }
  })
  assert.equal(dimensions.width, Math.floor(dimensions.cssWidth * dpr), 'Framebuffer width must retain DPR')
  assert.equal(dimensions.height, Math.floor(dimensions.cssHeight * dpr), 'Framebuffer height must retain DPR')
  const labelIds = await page.$$eval('#labels-overlay [id^="card-label-"]', (elements) => elements.map((el) => el.id).sort())
  assert.deepEqual(labelIds, INITIAL_LEARNING_PATH_FIXTURE.skills.map((skill) => `card-label-${skill.id}`).sort(), 'Exactly one card per fixture Skill')

  const skills = INITIAL_LEARNING_PATH_FIXTURE.skills.slice(0, 2)
  const rectangles = await Promise.all(skills.map((skill) => page.$eval(`#card-label-${skill.id}`, (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })))
  for (const [selectedIndex, skill] of skills.entries()) {
    const rect = rectangles[selectedIndex]
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2)
    await page.waitForFunction((id) => document.querySelector('#selected-skill-id')?.textContent === id, {}, skill.id)
    assert.equal(await page.$eval('#selected-skill-title', (el) => el.textContent), skill.title)
    await page.$eval('#labels-overlay', (el) => { (el as HTMLElement).style.visibility = 'hidden' })
    try {
      for (const [index, clip] of rectangles.entries()) {
        const png = await page.screenshot({ clip, type: 'png' })
        const count = Number(execFileSync('python3', ['-c', `
import sys, io
from PIL import Image
image = Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB')
colors = image.getcolors(image.width * image.height)
targets = [(59, 130, 245), (128, 185, 248)]
print(sum(n for n, c in colors if any(max(abs(a-b) for a,b in zip(c,t)) <= 4 for t in targets)))
`], { input: png, encoding: 'utf8' }).trim())
        assert.ok(index === selectedIndex ? count > 20 * dpr : count === 0,
          `GPU highlight must appear only on selected Skill ${skill.id}; card ${index} has ${count} blue pixels`)
      }
    } finally {
      await page.$eval('#labels-overlay', (el) => { (el as HTMLElement).style.visibility = '' })
    }
  }
  return { dpr, ...dimensions, exactFixtureCards: true, selectionPixelsVerified: true }
}
