import puppeteer from 'puppeteer-core'
import { closeEditorPanels, openSkillList } from './editor-navigation'
import { spawn, execSync, execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'

const checkOnly = process.argv.includes('--check-only')
const REPO_ROOT = path.resolve(__dirname, '../..')

function sourceIdentity() {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const status = git('status', '--porcelain', '--untracked-files=all')
  const nonReportChanges = status
    .split('\n')
    .filter(Boolean)
    .filter((l) => !l.includes('t05-smoke-report') && !l.includes('webgpu_t05_smoke_check'))
  if (nonReportChanges.length > 0) {
    throw new Error(
      `Smoke evidence requires a clean committed tree. Commit source changes before running:\n${nonReportChanges.join('\n')}`
    )
  }
  return {
    commit: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
  }
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3460
const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR ||
  path.resolve(__dirname, '../../docs/validation/artifacts')

function resolveChromiumExecutable(): string {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH
  }
  if (process.env.CHROME_BIN) {
    return process.env.CHROME_BIN
  }

  const candidates = ['chromium', 'google-chrome-stable', 'google-chrome']
  for (const bin of candidates) {
    try {
      const resolved = execSync(`which ${bin} 2>/dev/null`).toString().trim()
      if (resolved && fs.existsSync(resolved)) {
        return resolved
      }
    } catch {
      // continue
    }
  }

  throw new Error(
    'No Chromium or Google Chrome binary found in PATH. Set PUPPETEER_EXECUTABLE_PATH or CHROME_BIN.'
  )
}

function verifyPrerequisites(): void {
  try {
    execSync('python3 -c "from PIL import Image"', { stdio: 'ignore' })
  } catch {
    throw new Error(
      'Prerequisite missing: python3 with Pillow is required for pixel validation. Install with `pip install Pillow`.'
    )
  }
}

function verifyCanvasCardPixels(
  screenshot: Buffer,
  box: { left: number; top: number; width: number; height: number }
): { pass: boolean; details: string; cardPixels: number } {
  const pythonScript = `
import sys, io, json
from PIL import Image

im = Image.open(io.BytesIO(sys.stdin.buffer.read()))
box = json.loads('${JSON.stringify(box)}')

x1 = int(max(0, box['left'] + 15))
y1 = int(max(0, box['top'] + 15))
x2 = int(min(im.width, box['left'] + box['width'] - 15))
y2 = int(min(im.height, box['top'] + box['height'] - 15))

card_count = 0
for y in range(y1, y2):
    for x in range(x1, x2):
        r, g, b = im.getpixel((x, y))[:3]
        # Background is (18, 20, 28). Card fill is (28, 36, 48), border is (61, 71, 97)
        if r >= 24 and g >= 30 and b >= 40:
            card_count += 1

pass_check = card_count >= 100
print(f"{'PASS' if pass_check else 'FAIL'}|card_pixels={card_count}|region=({x1},{y1},{x2},{y2})")
`
  const result = execFileSync('python3', ['-c', pythonScript], {
    input: screenshot,
    encoding: 'utf8',
  }).trim()
  const parts = result.split('|')
  const pass = parts[0] === 'PASS'
  const match = result.match(/card_pixels=(\d+)/)
  return {
    pass,
    details: result,
    cardPixels: match ? parseInt(match[1], 10) : 0,
  }
}

function verifyConnectionCurvePixels(
  screenshot: Buffer,
  startPoint: { x: number; y: number },
  endPoint: { x: number; y: number },
  cardBoxes: Array<{ left: number; top: number; right: number; bottom: number }>
): { pass: boolean; details: string; bluePixels: number } {
  const pythonScript = `
import sys, io, json
from PIL import Image

im = Image.open(io.BytesIO(sys.stdin.buffer.read()))

min_x = int(min(${startPoint.x}, ${endPoint.x}))
max_x = int(max(${startPoint.x}, ${endPoint.x}))
min_y = int(min(${startPoint.y}, ${endPoint.y}))
max_y = int(max(${startPoint.y}, ${endPoint.y}))

crop_x1 = max(0, min_x - 10)
crop_y1 = max(0, min_y - 10)
crop_x2 = min(im.width, max_x + 10)
crop_y2 = min(im.height, max_y + 10)

card_boxes = json.loads('${JSON.stringify(cardBoxes)}')

blue_count = 0
for y in range(crop_y1, crop_y2):
    for x in range(crop_x1, crop_x2):
        if any(box['left'] - 3 <= x <= box['right'] + 3 and
               box['top'] - 3 <= y <= box['bottom'] + 3 for box in card_boxes):
            continue
        r, g, b = im.getpixel((x, y))[:3]
        if (b > 160 and b > r + 40) or (b > 80 and b > r + 30 and g > 30):
            blue_count += 1

pass_check = blue_count >= 15
print(f"{'PASS' if pass_check else 'FAIL'}|blue_pixels={blue_count}|region=({crop_x1},{crop_y1},{crop_x2},{crop_y2})")
`
  const result = execFileSync('python3', ['-c', pythonScript], {
    input: screenshot,
    encoding: 'utf8',
  }).trim()
  const parts = result.split('|')
  const pass = parts[0] === 'PASS'
  const match = result.match(/blue_pixels=(\d+)/)
  return {
    pass,
    details: result,
    bluePixels: match ? parseInt(match[1], 10) : 0,
  }
}

async function waitForServerReady(url: string, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 200) return
    } catch {
      // continue waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Server at ${url} failed to respond after ${maxAttempts} attempts.`)
}

async function main() {
  console.log('=== Gurow P1/T05 Smoke Check (Renderer Recovery & Prerequisite List) ===')
  const identity = checkOnly ? null : sourceIdentity()
  console.log(`Source Tree: ${identity?.tree ?? 'development check (existing build)'}`)
  console.log(`Source Commit: ${identity?.commit ?? 'unrecorded'}`)

  verifyPrerequisites()
  const chromiumPath = resolveChromiumExecutable()
  console.log(`Using Chromium: ${chromiumPath}`)

  if (!fs.existsSync(ARTIFACT_DIR)) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
  }

  if (!checkOnly) {
    console.log('\n[1/4] Running Rust engine-core unit tests...')
    execSync('cargo test --manifest-path editor/Cargo.toml --package engine-core', {
      stdio: 'inherit',
      cwd: REPO_ROOT,
    })

    console.log('\n[2/4] Running TypeScript SDD schema & invariant tests...')
    execSync('bun run typecheck', { stdio: 'inherit', cwd: path.resolve(REPO_ROOT, 'frontend') })
    execSync('bun test', { stdio: 'inherit', cwd: path.resolve(REPO_ROOT, 'frontend') })

    console.log('\n[3/4] Building WebAssembly & frontend bundle...')
    execSync('bun run build', { stdio: 'inherit', cwd: path.resolve(REPO_ROOT, 'frontend') })
  }

  console.log(`\n[4/4] Starting local server on port ${PORT}...`)
  const server = spawn('node', ['.output/server/index.mjs'], {
    cwd: path.resolve(REPO_ROOT, 'frontend'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'inherit',
  })

  const serverUrl = `http://localhost:${PORT}`

  let browser: any = null
  try {
    await waitForServerReady(serverUrl)
    console.log(`Server ready at ${serverUrl}`)

    console.log('\nLaunching Chromium with WebGPU...')
    browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--enable-unsafe-webgpu',
        '--use-gl=angle',
      ],
    })

    const page = await browser.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (error: Error) => pageErrors.push(error.message))
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })

    page.on('console', (msg: any) => {
      const text = msg.text()
      if (text.includes('[WebGPU]') || text.includes('Error') || text.includes('error')) {
        console.log(`  [Browser] ${text}`)
      }
    })

    await page.goto(`${serverUrl}/editor`, { waitUntil: 'networkidle0' })
    await page.evaluate(() => localStorage.clear())
    await page.reload({ waitUntil: 'networkidle0' })

    // =========================================================================
    // Phase 1: Real Rendering Path & Initial Canvas State (AC 1, AC 5)
    // =========================================================================
    console.log('\n--- Phase 1: Real Rendering Path & Canvas Baseline (AC 1, AC 5) ---')
    await page.waitForSelector('#editor-canvas', { timeout: 10000 })
    await page.waitForSelector('#card-label-skill-rust-basics', { timeout: 10000 })
    await openSkillList(page)
    // Initialization can outlast networkidle when other checks share the machine (#52); it must still end ready.
    await page.waitForFunction(() => (document.querySelector('#gpu-status-badge') as HTMLElement | null)?.dataset.status !== 'initializing', { timeout: 15000 })
      .catch(() => undefined)

    const gpuStatusText = await page.$eval('#gpu-status-badge', (el: HTMLElement) => el.dataset.status)
    console.log(`  GPU Status: "${gpuStatusText}"`)
    if (gpuStatusText !== 'ready') {
      throw new Error(`Expected active WebGPU status, got "${gpuStatusText}"`)
    }

    // Verify Skill & Prerequisite list rendered initial skills
    const listItems = await page.$$eval('#skill-prerequisite-list [role="option"]', (els: any[]) =>
      els.map((el) => ({
        id: el.id,
        text: el.textContent?.trim(),
        selected: el.getAttribute('aria-selected') === 'true',
      }))
    )
    console.log(`  Rendered Skill List Items: ${listItems.length}`)
    if (listItems.length < 4) {
      throw new Error(`Expected at least 4 skills in prerequisite list, found ${listItems.length}`)
    }
    console.log('  Verified: Skill/Prerequisite list renders all active fixture skills.')

    // A half-tiled window is ordinary use on a tiling desktop. Below the md
    // breakpoint the three panes stack, and the editor used to be squeezed to
    // zero CSS height inside a fixed-height row while its backing buffer stayed
    // full size: a blank editor with a live renderer behind it.
    await page.setViewport({ width: 621, height: 694, deviceScaleFactor: 1 })
    await new Promise((resolve) => setTimeout(resolve, 600))
    const narrowCanvas = await page.$eval('#editor-canvas', (el: any) => {
      const rect = el.getBoundingClientRect()
      return { width: rect.width, height: rect.height, backing: { width: el.width, height: el.height } }
    })
    const narrowLabels = await page.$$eval('[id^="card-label-"]', (els: any[]) =>
      els.filter((el) => el.getBoundingClientRect().height > 0).length
    )
    console.log(
      `  Narrow 621×694 canvas: ${narrowCanvas.width.toFixed(1)}×${narrowCanvas.height.toFixed(1)} CSS, ` +
        `${narrowCanvas.backing.width}×${narrowCanvas.backing.height} backing, ${narrowLabels} visible labels`
    )
    if (narrowCanvas.height < 200 || narrowCanvas.width < 200) {
      throw new Error(
        `Editor canvas collapsed in a narrow window: ${narrowCanvas.width}×${narrowCanvas.height} CSS pixels.`
      )
    }
    if (narrowLabels < 1) {
      throw new Error('No HTML card label remained visible in a narrow window.')
    }
    console.log('  Verified: editor keeps a usable canvas and labels in a half-tiled window.')
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
    await new Promise((resolve) => setTimeout(resolve, 600))

    // =========================================================================
    // Phase 2: Graph Setup & Card Movement Before Failure (AC 5, Spec 3)
    // =========================================================================
    console.log('\n--- Phase 2: Graph Setup (Edge + Card Move) Before Failure (AC 5) ---')

    // Step A: Select "Rust Fundamentals"
    await closeEditorPanels(page)
    await page.click('#card-label-skill-rust-basics')
    await page.waitForSelector('#selected-skill-title')

    // Step B: Connect "Rust Fundamentals" -> "WebGPU Pipeline" to create an edge
    console.log('  Connecting "Rust Fundamentals" -> "WebGPU Pipeline" to establish prerequisite edge...')
    await page.waitForSelector('#connect-skill-select')
    await page.select('#connect-skill-select', 'skill-wgpu-pipeline')
    await page.click('#btn-add-dependent')

    await page.waitForSelector('#outgoing-prerequisites-list')
    const outgoingPrereqText = await page.$eval(
      '#outgoing-prerequisites-list',
      (el: any) => el.textContent?.trim()
    )
    console.log(`  Outgoing Prerequisite Text: "${outgoingPrereqText}"`)
    if (!outgoingPrereqText?.includes('WebGPU Pipeline')) {
      throw new Error('Failed to create prerequisite edge before failure')
    }

    // Step C: Drag "Rust Fundamentals" to a distinct coordinate
    await closeEditorPanels(page)
    await page.evaluate(() => window.scrollTo(0, 0))
    const cardEl = await page.$('#card-label-skill-rust-basics')
    const boxBeforeDrag = await cardEl.boundingBox()
    console.log('  Card position before drag:', boxBeforeDrag)

    await page.mouse.move(boxBeforeDrag.x + 30, boxBeforeDrag.y + 30)
    await page.mouse.down()
    await page.mouse.move(boxBeforeDrag.x + 90, boxBeforeDrag.y + 70, { steps: 10 })
    await page.mouse.up()
    await new Promise((resolve) => setTimeout(resolve, 300))

    await page.evaluate(() => window.scrollTo(0, 0))
    const movedBox = await cardEl.boundingBox()
    console.log('  Card position after drag:', movedBox)
    const dragDistance = Math.hypot(movedBox.x - boxBeforeDrag.x, movedBox.y - boxBeforeDrag.y)
    if (dragDistance < 20) {
      throw new Error(`Expected card to move at least 20px, moved ${dragDistance}px`)
    }
    console.log(`  Verified: Card moved by ${dragDistance.toFixed(1)}px to new position before failure.`)

    // =========================================================================
    // Phase 3: Keyboard Navigation & Task Draft Edit (AC 1, AC 3)
    // =========================================================================
    console.log('\n--- Phase 3: Keyboard Navigation & Task Edit Setup (AC 1, AC 3) ---')

    // Navigate to second skill via keyboard list
    await openSkillList(page)
    await page.focus('#skill-prerequisite-list')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await page.waitForFunction(
      () => document.querySelector('#selected-skill-id')?.textContent?.trim() !== 'skill-rust-basics'
    )
    const keyboardSelectedSkillId = await page.$eval('#selected-skill-id', (el: any) => el.textContent?.trim())
    console.log(`  Keyboard selected skill: "${keyboardSelectedSkillId}"`)

    // Selection closes the list; reopen it before navigating back.
    await openSkillList(page)
    await page.focus('#skill-prerequisite-list')
    await page.keyboard.press('Home')
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => document.querySelector('#selected-skill-id')?.textContent?.trim() === 'skill-rust-basics'
    )

    // Type a draft edit on rust-basics task
    const unsavedText = ' [PRE-FAILURE DRAFT EDIT]'
    await page.type('#task-edit-title-task-rust-toolchain', unsavedText)
    const taskTitleBeforeFailure = await page.$eval(
      '#task-edit-title-task-rust-toolchain',
      (el: any) => el.value
    )
    console.log(`  Task title with active edit: "${taskTitleBeforeFailure}"`)

    // =========================================================================
    // Phase 4: Real Device Loss & Editing During Interruption (AC 3, Spec 1, Spec 2)
    // =========================================================================
    console.log('\n--- Phase 4: Real Device Loss & Edit During Interruption (AC 3, Spec 1, Spec 2) ---')

    // Delay the automatic attempt so navigation and saves run during actual GPU setup.
    await page.evaluate(() => {
      const scope = window as any
      scope.__origRequestAdapter = navigator.gpu.requestAdapter
      scope.__recoveryRequests = 0
      navigator.gpu.requestAdapter = async () => {
        scope.__recoveryRequests++
        return new Promise(resolve => { scope.__finishRecoveryAttempt = () => resolve(null) })
      }
    })

    // Destroy active WebGPU device to trigger real device.lost promise (Spec 2)
    await page.evaluate(() => {
      const dev = (window as any).__gurowActiveDevice
      if (dev && typeof dev.destroy === 'function') {
        dev.destroy()
      } else {
        throw new Error('No __gurowActiveDevice found on window')
      }
    })

    await page.waitForFunction(() => (window as any).__recoveryRequests === 1, { timeout: 5000 })

    // Wait for the renderer error notice to appear via real device.lost handler
    await page.waitForSelector('#editor-gpu-error-notice', { timeout: 5000 })
    const failureNoticeText = await page.$eval('#editor-gpu-error-notice h3', (el: any) => el.textContent?.trim())
    console.log(`  Renderer Failure Notice: "${failureNoticeText}"`)
    if (!failureNoticeText?.includes('Renderer Failure')) {
      throw new Error(`Expected Renderer Failure notice, got "${failureNoticeText}"`)
    }

    // Verify CPU document and task edits are retained
    const taskTitleAfterFailure = await page.$eval(
      '#task-edit-title-task-rust-toolchain',
      (el: any) => el.value
    )
    if (taskTitleAfterFailure !== taskTitleBeforeFailure) {
      throw new Error(`Task edit was lost during GPU failure! Expected "${taskTitleBeforeFailure}", got "${taskTitleAfterFailure}"`)
    }

    // Navigate with keyboard list and EDIT TASK during failure (Spec 1: verifies no unsafe aliasing)
    console.log('  Testing navigation and task editing while renderer is failed (Spec 1)...')
    await openSkillList(page)
    await page.focus('#skill-prerequisite-list')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await page.waitForFunction(
      () => document.querySelector('#selected-skill-id')?.textContent?.trim() !== 'skill-rust-basics'
    )
    const secondSkillId = await page.$eval('#selected-skill-id', (el: any) => el.textContent?.trim())
    console.log(`  Selected during failure: "${secondSkillId}"`)

    // Edit task on the second skill while recovery is pending/interrupted
    const recoveryEditText = ' [EDITED DURING RECOVERY]'
    const secondSkillTaskInput = await page.waitForSelector('[id^="task-edit-title-task-"]')
    await secondSkillTaskInput.type(recoveryEditText)
    const secondSkillTaskVal = await page.$eval('[id^="task-edit-title-task-"]', (el: any) => el.value)
    console.log(`  Second skill task title with edit: "${secondSkillTaskVal}"`)

    // Navigate back to rust-basics
    await openSkillList(page)
    await page.focus('#skill-prerequisite-list')
    await page.keyboard.press('Home')
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => document.querySelector('#selected-skill-id')?.textContent?.trim() === 'skill-rust-basics'
    )
    console.log('  Verified: Document navigation and editing are fully usable during renderer failure without aliasing error.')

    // =========================================================================
    // Phase 5: Injected Unsuccessful Recovery Feedback (AC 4, Standards 2)
    // =========================================================================
    console.log('\n--- Phase 5: Serialized Automatic Recovery & Failed Adapter Feedback (AC 4, Standards 2) ---')

    // Repeated clicks during the automatic attempt must not start other requests.
    await closeEditorPanels(page)
    await page.click('#btn-retry-renderer')
    await closeEditorPanels(page)
    await page.click('#btn-retry-renderer')
    await new Promise(resolve => setTimeout(resolve, 100))
    const recoveryRequests = await page.evaluate(() => (window as any).__recoveryRequests)
    if (recoveryRequests !== 1) throw new Error(`Overlapping recovery attempts: ${recoveryRequests}`)

    // Confirm the Task was saved while GPU setup was still pending.
    await page.waitForFunction((text: string) => {
      const raw = localStorage.getItem('gurow:checkpoint:fixture-user:lp-rust-graphics-mvp')
      return raw !== null && JSON.parse(raw).application.skills.some((skill: any) =>
        skill.tasks.some((task: any) => task.title.includes(text)))
    }, {}, recoveryEditText)
    await page.evaluate(() => (window as any).__finishRecoveryAttempt())

    // Verify recovery error banner appears with the real caught exception
    await page.waitForSelector('#recovery-error-banner', { timeout: 5000 })
    const recoveryErrorMsg = await page.$eval('#recovery-error-banner', (el: any) => el.textContent?.trim())
    console.log(`  Observed Real Unsuccessful Recovery Banner: "${recoveryErrorMsg}"`)
    if (!recoveryErrorMsg?.includes('No suitable WebGPU adapter found')) {
      throw new Error(`Expected real adapter error in banner, got "${recoveryErrorMsg}"`)
    }

    // Verify retry button remains visible
    const hasRetryBtn = await page.$('#btn-retry-renderer')
    if (!hasRetryBtn) {
      throw new Error('Retry button #btn-retry-renderer must remain available after unsuccessful recovery')
    }
    console.log('  Verified: Injected failure ran through real recreation and catch handlers.')

    // =========================================================================
    // Phase 6: Successful Recreation & Full Document Retention (AC 4, AC 5, Spec 1, Spec 3)
    // =========================================================================
    console.log('\n--- Phase 6: Successful Recreation & Document Retention (AC 4, AC 5, Spec 3) ---')

    // Restore real requestAdapter
    await page.evaluate(() => {
      navigator.gpu.requestAdapter = (window as any).__origRequestAdapter
    })

    // Click standard Retry button again
    await closeEditorPanels(page)
    await page.click('#btn-retry-renderer')

    // Wait for error notice to disappear and badge to indicate ready
    await page.waitForFunction(
      () => !document.querySelector('#editor-gpu-error-notice'),
      { timeout: 10000 }
    )
    await page.waitForFunction(
      () => (document.querySelector('#gpu-status-badge') as HTMLElement | null)?.dataset.status === 'ready'
    )
    console.log('  WebGPU Editor successfully recovered and active.')

    // 1. Verify card moved position is preserved after recovery
    await page.evaluate(() => window.scrollTo(0, 0))
    const postRecoveryCardEl = await page.$('#card-label-skill-rust-basics')
    const postRecoveryBox = await postRecoveryCardEl.boundingBox()
    console.log('  Card position after recovery:', postRecoveryBox)
    if (
      Math.abs(postRecoveryBox.x - movedBox.x) > 5 ||
      Math.abs(postRecoveryBox.y - movedBox.y) > 5
    ) {
      throw new Error(
        `Card position lost upon recovery! Expected (${movedBox.x}, ${movedBox.y}), got (${postRecoveryBox.x}, ${postRecoveryBox.y})`
      )
    }
    console.log('  Verified: Card moved position preserved across device loss and recreation.')

    // 2. Verify graph edge connection is preserved after recovery
    await closeEditorPanels(page)
    await page.click('#card-label-skill-rust-basics')
    await page.waitForSelector('#outgoing-prerequisites-list')
    const postRecoveryOutgoing = await page.$eval(
      '#outgoing-prerequisites-list',
      (el: any) => el.textContent?.trim()
    )
    if (!postRecoveryOutgoing?.includes('WebGPU Pipeline')) {
      throw new Error('Prerequisite connection lost upon renderer recovery!')
    }
    console.log('  Verified: Prerequisite connection edge preserved across recovery.')

    // 3. Verify task edit made during recovery is preserved
    await openSkillList(page)
    await page.focus('#skill-prerequisite-list')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => document.querySelector('#selected-skill-id')?.textContent?.trim() !== 'skill-rust-basics'
    )
    const postRecoveryTaskVal = await page.$eval('[id^="task-edit-title-task-"]', (el: any) => el.value)
    if (!postRecoveryTaskVal.includes(recoveryEditText)) {
      throw new Error(
        `Task edit made during recovery was lost! Expected to include "${recoveryEditText}", got "${postRecoveryTaskVal}"`
      )
    }
    console.log('  Verified: Task edit made during recovery is preserved after renderer recreation.')

    // Select rust-basics again for pixel verification
    await openSkillList(page)
    await page.focus('#skill-prerequisite-list')
    await page.keyboard.press('Home')
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => document.querySelector('#selected-skill-id')?.textContent?.trim() === 'skill-rust-basics'
    )

    // =========================================================================
    // Phase 7: Real GPU Redraw Pixel Inspection (Standards 1, ENGINE_VALIDATION_PLAN.md)
    // =========================================================================
    console.log('\n--- Phase 7: Real GPU Redraw Pixel Inspection (Standards 1) ---')
    await closeEditorPanels(page)

    await page.evaluate(() => window.scrollTo(0, 0))
    const rustBox = await page.$eval('#card-label-skill-rust-basics', (el: any) => {
      const r = el.getBoundingClientRect()
      return {
        left: Math.round(r.left + window.scrollX),
        top: Math.round(r.top + window.scrollY),
        right: Math.round(r.right + window.scrollX),
        bottom: Math.round(r.bottom + window.scrollY),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }
    })
    const wgpuBox = await page.$eval('#card-label-skill-wgpu-pipeline', (el: any) => {
      const r = el.getBoundingClientRect()
      return {
        left: Math.round(r.left + window.scrollX),
        top: Math.round(r.top + window.scrollY),
        right: Math.round(r.right + window.scrollX),
        bottom: Math.round(r.bottom + window.scrollY),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }
    })
    const startPoint = {
      x: rustBox.left + rustBox.width,
      y: rustBox.top + Math.round(rustBox.height / 2),
    }
    const endPoint = {
      x: wgpuBox.left,
      y: wgpuBox.top + Math.round(wgpuBox.height / 2),
    }
    const cardBoxes = await page.$$eval('#labels-overlay [id^="card-label-"]', (els: Element[]) =>
      els.map((el) => {
        const r = el.getBoundingClientRect()
        return {
          left: Math.round(r.left + window.scrollX),
          top: Math.round(r.top + window.scrollY),
          right: Math.round(r.right + window.scrollX),
          bottom: Math.round(r.bottom + window.scrollY),
        }
      })
    )

    // Hide HTML overlay to sample pure WebGPU canvas framebuffer
    await page.evaluate(() => {
      const overlay = document.querySelector('#labels-overlay') as HTMLElement
      if (overlay) overlay.style.display = 'none'
    })
    const recoveredCanvasScreenshot = await page.screenshot({ fullPage: false })
    await page.evaluate(() => {
      const overlay = document.querySelector('#labels-overlay') as HTMLElement
      if (overlay) overlay.style.display = ''
    })

    // Inspect card pixels at the moved card position
    const cardPixelCheck = verifyCanvasCardPixels(recoveredCanvasScreenshot, rustBox)
    console.log(`  Canvas Card Pixel Check at moved position: ${cardPixelCheck.details}`)
    if (!cardPixelCheck.pass) {
      throw new Error(`WebGPU card pixel check failed on recovered canvas: ${cardPixelCheck.details}`)
    }

    // Inspect connection curve blue pixels on recovered canvas
    const curvePixelCheck = verifyConnectionCurvePixels(
      recoveredCanvasScreenshot,
      startPoint,
      endPoint,
      cardBoxes
    )
    console.log(`  Canvas Connection Curve Pixel Check: ${curvePixelCheck.details}`)
    if (!curvePixelCheck.pass) {
      throw new Error(`WebGPU connection curve pixel check failed on recovered canvas: ${curvePixelCheck.details}`)
    }
    console.log('  Verified: Pure WebGPU canvas framebuffer contains rendered card quads and connection curve.')

    // A later device loss must recover successfully without a Retry click.
    await page.evaluate(() => {
      const scope = window as any
      scope.__deviceBeforeAutomaticRecovery = scope.__gurowActiveDevice
      scope.__deviceBeforeAutomaticRecovery.destroy()
    })
    await page.waitForFunction(() => {
      const scope = window as any
      return scope.__gurowActiveDevice !== scope.__deviceBeforeAutomaticRecovery
        && !document.querySelector('#editor-gpu-error-notice')
    }, { timeout: 10000 })
    console.log('  Verified: subsequent device loss recovers automatically without user action.')

    // =========================================================================
    // Phase 8: No-WebGPU Startup Verification (AC 2, AC 5)
    // =========================================================================
    console.log('\n--- Phase 8: No-WebGPU Startup Verification (AC 2, AC 5) ---')
    const noGpuContext = await browser.createBrowserContext()
    const noGpuPage = await noGpuContext.newPage()
    noGpuPage.on('pageerror', (error: Error) => pageErrors.push(error.message))
    await noGpuPage.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })

    // Simulate browser without WebGPU support before navigation
    await noGpuPage.evaluateOnNewDocument(() => {
      try {
        delete (Navigator.prototype as any).gpu
      } catch {}
      try {
        delete (navigator as any).gpu
      } catch {}
      Object.defineProperty(Navigator.prototype, 'gpu', {
        get: () => undefined,
        configurable: true,
      })
      Object.defineProperty(navigator, 'gpu', {
        get: () => undefined,
        configurable: true,
      })
    })

    await noGpuPage.goto(`${serverUrl}/editor`, { waitUntil: 'networkidle0' })

    // Wait for WebGPU unavailable notice
    await noGpuPage.waitForSelector('#editor-gpu-notice', { timeout: 10000 })
    const noGpuTitle = await noGpuPage.$eval('#editor-gpu-notice h3', (el: any) => el.textContent?.trim())
    console.log(`  No-WebGPU Notice: "${noGpuTitle}"`)

    // Verify explanation of canvas availability
    await noGpuPage.waitForSelector('#canvas-availability-explanation')
    const explanationText = await noGpuPage.$eval(
      '#canvas-availability-explanation',
      (el: any) => el.textContent?.trim()
    )
    console.log(`  Canvas Availability Explanation: "${explanationText}"`)
    if (!explanationText?.includes('Card positioning remains a canvas operation')) {
      throw new Error(`Explanation must state positioning remains a canvas operation: got "${explanationText}"`)
    }

    await openSkillList(noGpuPage)
    // Verify positioning note in list footer
    const listPositioningNote = await noGpuPage.$eval(
      '#list-positioning-note',
      (el: any) => el.textContent?.trim()
    )
    console.log(`  List Positioning Note: "${listPositioningNote}"`)
    if (!listPositioningNote?.includes('Card positioning remains a canvas operation')) {
      throw new Error(`Expected list note stating positioning is canvas operation, got "${listPositioningNote}"`)
    }

    // Verify list navigation and Task editing work in no-WebGPU mode
    await noGpuPage.waitForSelector('#skill-prerequisite-list')
    await noGpuPage.focus('#skill-prerequisite-list')
    await noGpuPage.keyboard.press('ArrowDown')
    await noGpuPage.keyboard.press('Enter')

    await noGpuPage.waitForSelector('#selected-skill-title')
    const noGpuSelectedTitle = await noGpuPage.$eval('#selected-skill-title', (el: any) => el.textContent?.trim())
    console.log(`  Selected Skill without WebGPU: "${noGpuSelectedTitle}"`)

    // Verify editing task without WebGPU
    const noGpuTaskTitleInput = await noGpuPage.waitForSelector('[id^="task-edit-title-"]')
    if (!noGpuTaskTitleInput) {
      throw new Error('Task editing input must be available without WebGPU')
    }
    await noGpuTaskTitleInput.type(' [EDITED WITHOUT GPU]')
    await noGpuPage.waitForFunction(() => {
      const raw = localStorage.getItem('gurow:checkpoint:fixture-user:lp-rust-graphics-mvp')
      return raw !== null && JSON.parse(raw).application.skills.some((skill: any) =>
        skill.tasks.some((task: any) => task.title.includes('[EDITED WITHOUT GPU]')))
    })
    console.log('  Verified: No-WebGPU startup supports list navigation and persisted Task edits.')

    await noGpuContext.close()

    // =========================================================================
    // Visual Evidence Screenshot
    // =========================================================================
    if (!checkOnly) {
      const screenshotPath = path.join(ARTIFACT_DIR, 'webgpu_t05_smoke_check.png')
      await page.screenshot({ path: screenshotPath, fullPage: false })
      console.log(`\nScreenshot saved: ${screenshotPath}`)
    }

    console.log('\n=============================================================')
    if (pageErrors.length) throw new Error(`Unhandled browser errors: ${pageErrors.join('; ')}`)
    console.log('ALL P1/T05 ACCEPTANCE CRITERIA VERIFIED SUCCESSFULLY:')
    console.log('  [x] AC 1: Keyboard list navigation selects correct Skill and opens Task panel')
    console.log('  [x] AC 2: No-WebGPU startup provides usable list and explains positioning')
    console.log('  [x] AC 3: Renderer failure/device loss retains CPU document and task edits')
    console.log('  [x] AC 4: Recreation redraws document; unsuccessful recovery keeps retry & list')
    console.log('  [x] AC 5: Browser checks exercise real rendering, failure, and list paths')
    console.log('=============================================================')

    if (checkOnly) {
      console.log('\nBrowser development checks passed; no validation report published.')
    }
  } finally {
    if (browser) {
      await browser.close()
    }
    console.log('Stopping server gracefully (5s)... Press Ctrl+C again to force close.')
    server.kill('SIGTERM')
    setTimeout(() => server.kill('SIGKILL'), 5000)
  }
}

main().catch((err) => {
  console.error('\n❌ T05 Smoke Check FAILED:', err)
  process.exit(1)
})
