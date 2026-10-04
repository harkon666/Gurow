#!/usr/bin/env bun
/** #44: production browser seam; software GPU is functional, not performance evidence. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { resolveChromiumExecutable, waitForServerReady } from './benchmark/browser'

const root = path.resolve(import.meta.dir, '..')
const port = Number(process.env.LABEL_SCROLL_PORT ?? 3464)
const url = `http://127.0.0.1:${port}`
if (!process.argv.includes('--skip-build')) execFileSync('bun', ['run', 'build'], { cwd: root, stdio: 'inherit' })
const server = spawn('node', ['.output/server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' })
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined
try {
  await waitForServerReady(url)
  browser = await puppeteer.launch({ executablePath: resolveChromiumExecutable(), headless: true,
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-gl=angle', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
  await page.goto(`${url}/editor`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#card-label-skill-rust-basics')
  assert.match(await page.$eval('#gpu-status-badge', el => el.textContent ?? ''), /WebGPU Rust Editor/)
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const snapshot = () => page.evaluate(() => {
    const canvas = document.querySelector('#editor-canvas')!.getBoundingClientRect()
    return [...document.querySelectorAll<HTMLElement>('[id^="card-label-"]')].map(el => {
      const r = el.getBoundingClientRect()
      return { id: el.id, x: r.x - canvas.x, y: r.y - canvas.y, width: r.width, height: r.height }
    })
  })
  const scrolls = () => page.evaluate(() => {
    const overlay = document.querySelector<HTMLElement>('#labels-overlay')!
    const container = document.querySelector('#editor-canvas')!.parentElement!
    const ancestors: HTMLElement[] = []
    for (let el: HTMLElement | null = overlay; el; el = el.parentElement) {
      ancestors.push(el)
      if (el === container) break
    }
    return ancestors.map(el => ({ id: el.id || 'canvas-container', left: el.scrollLeft, top: el.scrollTop }))
  })
  // Actual wheel camera input moves the bottom/right label beyond BOTH edges.
  const canvas = await page.$eval('#editor-canvas', el => el.getBoundingClientRect().toJSON())
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
  await page.mouse.wheel({ deltaX: -500, deltaY: -500 })
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#editor-canvas')!.getBoundingClientRect()
    return [...document.querySelectorAll('[id^="card-label-"]')].some(el => {
      const r = el.getBoundingClientRect()
      return r.right > canvas.right && r.bottom > canvas.bottom
    })
  })
  await settle()
  const before = await snapshot()
  const target = await page.evaluate(() => {
    const canvas = document.querySelector('#editor-canvas')!.getBoundingClientRect()
    return [...document.querySelectorAll('[id^="card-label-"]')].find(el => {
      const r = el.getBoundingClientRect()
      return r.right > canvas.right && r.bottom > canvas.bottom
    })!.id
  })
  await page.$eval(`#${target}`, el => el.scrollIntoView({ block: 'end', inline: 'end', behavior: 'instant' }))
  await settle()
  assert.deepEqual(await scrolls(), [
    { id: 'labels-overlay', left: 0, top: 0 }, { id: 'canvas-container', left: 0, top: 0 },
  ], 'scrollIntoView must not scroll the overlay or canvas container')
  assert.deepEqual(await snapshot(), before, 'every label must stay at its camera-projected card position')
  // Direct programmatic scrolling must also be impossible.
  await page.$eval('#labels-overlay', el => el.scrollTo(500, 500))
  await settle()
  assert.deepEqual(await snapshot(), before)
  console.log('PASS scrollIntoView and scrollTo: all labels unchanged; overlay/container scroll offsets zero')

  // Move Rust Fundamentals partly across the right boundary, using camera input only.
  const rust = before.find(l => l.id === 'card-label-skill-rust-basics')!
  await page.mouse.wheel({ deltaX: rust.x - (canvas.width - rust.width / 2), deltaY: rust.y - 90 })
  await settle()
  const partial = await snapshot()
  const card = partial.find(l => l.id === rust.id)!
  assert.ok(card.x < canvas.width && card.x + card.width > canvas.width, 'title card must straddle the canvas edge')
  const findResult = await page.evaluate(() => {
    window.getSelection()?.removeAllRanges()
    // The labels are user-select:none: Chromium find can return true without
    // exposing a Selection range. Give ONLY this label a unique title probe so
    // a successful search cannot silently match its list/sidebar duplicate.
    const title = document.querySelector('#card-label-skill-rust-basics h3')!
    const original = title.textContent!
    const probe = 'T44 Canvas Find Probe'
    title.textContent = probe
    const occurrences = [...document.querySelectorAll('h3')].filter(el => el.textContent === probe).length
    // Chromium's script find path; does NOT automate the native Ctrl+F toolbar.
    const found = (window as unknown as { find: (text: string) => boolean }).find(probe)
    title.textContent = original
    return { found, occurrences }
  })
  assert.deepEqual(findResult, { found: true, occurrences: 1 }, 'find must match the unique partly clipped canvas title')
  await settle()
  assert.deepEqual(await snapshot(), partial, 'script find must not shift labels')
  assert.ok((await scrolls()).every(s => s.left === 0 && s.top === 0))
  console.log(`PASS script find: ${JSON.stringify(findResult)}; labels and scroll offsets unchanged (native Ctrl+F not tested)`)
  await page.evaluate(() => window.getSelection()?.removeAllRanges())

  // Visual clipping: compare the strip outside the canvas with labels shown/hidden.
  // A deliberate color probe on the actual partly clipped label makes escaped paint detectable.
  await page.$eval(`#${rust.id}`, el => { (el as HTMLElement).style.transition = 'none'; (el as HTMLElement).style.background = '#ff00ff'; (el as HTMLElement).style.boxShadow = 'none' })
  await settle()
  const inside = await page.screenshot({ clip: { x: canvas.right - 24, y: canvas.y + card.y + 65, width: 16, height: 16 }, encoding: 'base64' })
  const magentaPixels = (data: string) => page.evaluate(async data => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    let count = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 240 && pixels[i + 1] < 20 && pixels[i + 2] > 240) count++
    return count
  }, data)
  assert.ok(await magentaPixels(inside as string) > 100, 'positive control: label paint visible inside canvas')
  const outside = await page.screenshot({ clip: { x: canvas.right + 2, y: canvas.y + card.y + 65, width: 16, height: 16 }, encoding: 'base64' })
  assert.equal(await magentaPixels(outside as string), 0, 'label paint must be clipped outside canvas')
  const point = { x: canvas.right - 30, y: canvas.y + card.y + 70 }
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, point), 'editor-canvas', 'label must not intercept pointer input')
  await page.mouse.click(point.x, point.y)
  await page.waitForFunction(() => document.querySelector('#selected-skill-id')?.textContent?.trim() === 'skill-rust-basics')
  console.log('PASS visual clipping (inside positive/outside negative pixel controls) and canvas pointer selection')
  assert.deepEqual(errors, [], 'no page errors')
  console.log(`PASS #44 label scrolling regression: ${await browser.version()}`)
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
