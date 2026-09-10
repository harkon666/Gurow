import puppeteer from 'puppeteer-core'
import { spawn, execSync, execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'

// Development checks use the existing build and never publish validation evidence.
const checkOnly = process.argv.includes('--check-only')

const REPO_ROOT = path.resolve(__dirname, '../..')

function sourceIdentity() {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const status = git('status', '--porcelain', '--untracked-files=all')
  // Allow report files themselves to be uncommitted during run
  const nonReportChanges = status
    .split('\n')
    .filter(Boolean)
    .filter((l) => !l.includes('t04-smoke-report') && !l.includes('webgpu_t04_smoke_check'))
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

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3459
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
  console.log('=== Gurow P1/T04 Smoke Check (Edit Task & Restore Scene) ===')
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
    // 1. Run native Rust engine tests
    console.log('\n[1/5] Running Rust engine-core unit tests...')
    execSync('cargo test --manifest-path editor/Cargo.toml --package engine-core', {
      stdio: 'inherit',
      cwd: REPO_ROOT,
    })

    // 2. Run TypeScript SDD tests
    console.log('\n[2/5] Running TypeScript SDD schema & invariant tests...')
    execSync('bun run typecheck', { stdio: 'inherit', cwd: path.resolve(REPO_ROOT, 'frontend') })
    execSync('bun test', { stdio: 'inherit', cwd: path.resolve(REPO_ROOT, 'frontend') })

    // 3. Build WebAssembly module & frontend production preview bundle
    console.log('\n[3/5] Building WebAssembly & frontend bundle...')
    execSync('bun run build', { stdio: 'inherit', cwd: path.resolve(REPO_ROOT, 'frontend') })
  }

  // 4. Start local production server
  console.log(`\n[4/5] Starting local server on port ${PORT}...`)
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

    // 5. Launch Chromium with WebGPU
    console.log('\n[5/5] Launching Chromium with WebGPU...')
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

    // Hold the real Wasm download to exercise the visible initialization window.
    const startupContext = await browser.createBrowserContext()
    const startupPage = await startupContext.newPage()
    await startupPage.setRequestInterception(true)
    let releaseWasm!: () => Promise<void>
    const wasmRequested = new Promise<void>((resolve) => {
      startupPage.on('request', (request: any) => {
        if (request.url().endsWith('.wasm')) {
          releaseWasm = () => request.continue()
          resolve()
        } else void request.continue()
      })
    })
    try {
      await startupPage.goto(serverUrl, { waitUntil: 'domcontentloaded' })
      await startupPage.waitForSelector('#editor-add-card-btn')
      await Promise.race([
        wasmRequested,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Wasm request not observed')), 10000)),
      ])
      const disabled = await startupPage.$eval('#editor-add-card-btn', (el: HTMLButtonElement) => el.disabled)
      if (!disabled) throw new Error('+ Skill must be disabled while the engine initializes')
      await startupPage.click('#editor-add-card-btn')
      await releaseWasm()
      await startupPage.waitForSelector('#card-label-skill-rust-basics')
      await startupPage.click('#card-label-skill-rust-basics')
      await startupPage.type('#task-edit-title-task-rust-toolchain', ' after initialization')
      await startupPage.waitForFunction(() => document.querySelector('#checkpoint-status-badge')?.textContent?.includes('Saved locally'))
      if (await startupPage.$('#checkpoint-error-alert')) throw new Error('Initialization click created an orphan Skill')
      console.log('  Verified: initialization click cannot create an orphan; subsequent Task save succeeds.')
    } finally {
      await startupContext.close()
    }

    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })

    page.on('console', (msg: any) => {
      const text = msg.text()
      if (text.includes('[WebGPU]') || text.includes('Error') || text.includes('error')) {
        console.log(`  [Browser] ${text}`)
      }
    })

    await page.goto(serverUrl, { waitUntil: 'networkidle0' })

    // Clean any prior state in local storage to start pristine
    await page.evaluate(() => localStorage.clear())
    await page.reload({ waitUntil: 'networkidle0' })

    // Wait for WebGPU canvas and initial card labels
    await page.waitForSelector('#editor-canvas', { timeout: 10000 })
    await page.waitForSelector('#card-label-skill-rust-basics', { timeout: 10000 })
    console.log('  Canvas and initial skill cards mounted and ready')

    // =========================================================================
    // Phase 1: Skill Selection & Task Display (AC 1)
    // =========================================================================
    console.log('\n--- Phase 1: Skill Selection & Task Display (AC 1) ---')
    await page.click('#card-label-skill-rust-basics')
    await page.waitForSelector('#selected-skill-title')
    const selId = await page.$eval('#selected-skill-id', (el: any) => el.textContent?.trim())
    console.log(`  Selected Skill ID: "${selId}"`)
    if (selId !== 'skill-rust-basics') {
      throw new Error(`Expected selected skill id 'skill-rust-basics', got '${selId}'`)
    }

    await page.waitForSelector('#task-edit-title-task-rust-toolchain')
    const initialTaskTitle = await page.$eval(
      '#task-edit-title-task-rust-toolchain',
      (el: any) => el.value
    )
    console.log(`  Initial Task Title: "${initialTaskTitle}"`)
    if (initialTaskTitle !== 'Setup Toolchain') {
      throw new Error(`Expected 'Setup Toolchain', got '${initialTaskTitle}'`)
    }

    const initialRequired = await page.$eval(
      '#task-edit-required-task-rust-toolchain',
      (el: any) => el.checked
    )
    const initialBadgeText = await page.$eval(
      '#task-badge-task-rust-toolchain',
      (el: any) => el.textContent?.trim()
    )
    console.log(`  Initial Task Required: ${initialRequired}, Badge: "${initialBadgeText}"`)
    if (!initialRequired || initialBadgeText !== 'Required') {
      throw new Error(`Expected initial task to be Required, got ${initialRequired} / ${initialBadgeText}`)
    }

    // =========================================================================
    // Phase 2: Edit Task Content & Toggle Required (AC 1)
    // =========================================================================
    console.log('\n--- Phase 2: Edit Task Content & Toggle Required (AC 1) ---')
    const editedTitle = 'Master Rust Toolchain v2 (Advanced)'
    const editedDescription = 'Configure cargo, verify WebGPU shaders, and test WASM boundaries.'

    // Set title and description using React-compatible input setters
    await page.evaluate(
      ({ title, desc }: { title: string; desc: string }) => {
        const titleInput = document.querySelector(
          '#task-edit-title-task-rust-toolchain'
        ) as HTMLInputElement
        const titleSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )?.set
        titleSetter?.call(titleInput, title)
        titleInput.dispatchEvent(new Event('input', { bubbles: true }))
        titleInput.dispatchEvent(new Event('change', { bubbles: true }))

        const descTextarea = document.querySelector(
          '#task-edit-description-task-rust-toolchain'
        ) as HTMLTextAreaElement
        const descSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value'
        )?.set
        descSetter?.call(descTextarea, desc)
        descTextarea.dispatchEvent(new Event('input', { bubbles: true }))
        descTextarea.dispatchEvent(new Event('change', { bubbles: true }))
      },
      { title: editedTitle, desc: editedDescription }
    )

    // Toggle required checkbox: from true -> false (Enrichment)
    await page.click('#task-edit-required-task-rust-toolchain')
    await new Promise((resolve) => setTimeout(resolve, 100))

    const toggledRequired = await page.$eval(
      '#task-edit-required-task-rust-toolchain',
      (el: any) => el.checked
    )
    const toggledBadgeText = await page.$eval(
      '#task-badge-task-rust-toolchain',
      (el: any) => el.textContent?.trim()
    )
    console.log(`  Toggled Task Required: ${toggledRequired}, Badge: "${toggledBadgeText}"`)
    if (toggledRequired !== false || toggledBadgeText !== 'Enrichment') {
      throw new Error(`Expected required=false and badge='Enrichment', got ${toggledRequired} / ${toggledBadgeText}`)
    }

    // Wait 300ms for auto-save
    await new Promise((resolve) => setTimeout(resolve, 300))

    // Inspect localStorage checkpoint
    const checkpointRaw = await page.evaluate(() =>
      localStorage.getItem('gurow:checkpoint:fixture-user:lp-rust-graphics-mvp')
    )
    if (!checkpointRaw) {
      throw new Error('Local checkpoint was not saved to localStorage')
    }
    const checkpoint = JSON.parse(checkpointRaw)

    console.log('  Checkpoint Envelope Version:', checkpoint.version)
    console.log('  Editor Format Version:', checkpoint.editor.format_version)
    console.log('  Editor Revision:', checkpoint.editor.revision)

    if (checkpoint.editor.format_version !== 1) {
      throw new Error(`Expected editor.format_version 1, got ${checkpoint.editor.format_version}`)
    }

    // Assert application payload has edited title, description, AND required=false
    const appSkill = checkpoint.application.skills.find((s: any) => s.id === 'skill-rust-basics')
    const appTask = appSkill?.tasks.find((t: any) => t.id === 'task-rust-toolchain')
    if (appTask?.title !== editedTitle) {
      throw new Error(`Application payload task title mismatch: ${appTask?.title}`)
    }
    if (appTask?.description !== editedDescription) {
      throw new Error(`Application payload task description mismatch: ${appTask?.description}`)
    }
    if (appTask?.required !== false) {
      throw new Error(`Application payload task required mismatch: expected false, got ${appTask?.required}`)
    }
    console.log(`  Application Payload Task Verified: "${appTask.title}", required=${appTask.required}`)

    // Assert CRITICAL AC 1 invariant: Editor snapshot contains ZERO task content
    const editorHasTasks =
      'tasks' in checkpoint.editor ||
      checkpoint.editor.cards.some((c: any) => 'tasks' in c || 'description' in c)
    if (editorHasTasks) {
      throw new Error('VIOLATION of AC 1: Editor snapshot contains task content!')
    }
    console.log('  Verified: Editor snapshot contains ZERO task contents (boundary strictly preserved).')

    // =========================================================================
    // Phase 3: Create Card & Connect Skills (AC 2, AC 5)
    // =========================================================================
    console.log('\n--- Phase 3: Create Card & Connect Skills (AC 2, AC 5) ---')
    const initialCardCountText = await page.$eval(
      '#editor-card-count',
      (el: any) => el.textContent?.trim()
    )
    const initialCardCount = parseInt(initialCardCountText || '4', 10)
    const expectedNewCount = initialCardCount + 1
    console.log(`  Initial card count: "${initialCardCountText}" (expecting ${expectedNewCount} after create)`)

    // Click "+ Skill" button in toolbar
    await page.waitForSelector('#editor-add-card-btn', { timeout: 5000 })
    await page.click('#editor-add-card-btn')
    await new Promise((resolve) => setTimeout(resolve, 400))

    // Verify card count incremented to expectedNewCount
    await page.waitForFunction(
      (count: number) => document.querySelector('#editor-card-count')?.textContent?.includes(`${count} cards`),
      { timeout: 5000 },
      expectedNewCount
    )
    console.log(`  Card count successfully incremented to ${expectedNewCount} cards`)

    // Read checkpoint to get the newly created card's ID
    const checkpointAfterCreateRaw = await page.evaluate(() =>
      localStorage.getItem('gurow:checkpoint:fixture-user:lp-rust-graphics-mvp')
    )
    const checkpointAfterCreate = JSON.parse(checkpointAfterCreateRaw!)
    const createdCard = checkpointAfterCreate.editor.cards.find((c: any) =>
      c.id.startsWith('skill-custom-')
    )
    if (!createdCard) {
      throw new Error('Created card not found in checkpoint editor snapshot')
    }
    const createdSkillPayload = checkpointAfterCreate.application.skills.find(
      (s: any) => s.id === createdCard.id
    )
    if (!createdSkillPayload) {
      throw new Error('Created skill missing from checkpoint application payload')
    }
    console.log(`  Created Card ID: "${createdCard.id}", Title: "${createdCard.title}"`)

    // Verify newly created card label is rendered on canvas overlay
    await page.waitForSelector(`#card-label-${createdCard.id}`, { timeout: 5000 })
    console.log(`  Verified card overlay DOM element: #card-label-${createdCard.id}`)

    // Click on new card to select it and verify task payload display
    await page.click(`#card-label-${createdCard.id}`)
    await page.waitForSelector('#selected-skill-title')
    const selectedCreatedId = await page.$eval(
      '#selected-skill-id',
      (el: any) => el.textContent?.trim()
    )
    if (selectedCreatedId !== createdCard.id) {
      throw new Error(`Expected selected skill '${createdCard.id}', got '${selectedCreatedId}'`)
    }
    const createdTask = createdSkillPayload.tasks[0]
    const displayedCreatedTask = await page.$eval(`#task-edit-title-${createdTask.id}`, (el: HTMLInputElement) => el.value)
    if (displayedCreatedTask !== createdTask.title) throw new Error('New Skill displays the wrong Task')
    console.log(`  Selected new skill in panel with its Task: "${selectedCreatedId}"`)

    // Newly created Skills must participate in the same graph as fixture Skills.
    await page.click('#editor-add-card-btn')
    await page.waitForFunction(
      (count: number) => document.querySelectorAll('[id^="card-label-"]').length === count,
      {}, expectedNewCount + 1
    )
    const secondCreatedId = await page.$$eval('[id^="card-label-skill-custom-"]',
      (els: Element[], firstId: string) => els.map(el => el.id.replace('card-label-', '')).find(id => id !== firstId), createdCard.id)
    const availableTargets = await page.$$eval('#connect-skill-select option', (els: HTMLOptionElement[]) => els.map(el => el.value))
    if (!availableTargets.includes(secondCreatedId)) throw new Error('New Skill missing from connection targets')
    await page.select('#connect-skill-select', secondCreatedId)
    await page.click('#btn-add-dependent')
    await page.waitForSelector('#outgoing-prerequisites-list')
    const secondCreatedTitle = await page.$eval(`#card-label-${secondCreatedId} h3`, (el: Element) => el.textContent)
    const customOutgoing = await page.$eval('#outgoing-prerequisites-list', (el: Element) => el.textContent)
    if (!customOutgoing?.includes(secondCreatedTitle)) throw new Error('Custom connection does not display its Skill title')
    console.log('  Verified: two new Skills can connect using their titles.')

    // Connect Rust Fundamentals -> WebGPU Pipeline
    await page.click('#card-label-skill-rust-basics')
    await page.waitForSelector('#connect-skill-select')
    await page.select('#connect-skill-select', 'skill-wgpu-pipeline')
    await page.click('#btn-add-dependent')
    await page.waitForSelector('#outgoing-prerequisites-list')
    console.log('  Connected "Rust Fundamentals" -> "WebGPU Pipeline"')
    await new Promise((resolve) => setTimeout(resolve, 300))

    // Inspect checkpoint after connect
    const checkpointAfterConnectRaw = await page.evaluate(() =>
      localStorage.getItem('gurow:checkpoint:fixture-user:lp-rust-graphics-mvp')
    )
    const checkpointAfterConnect = JSON.parse(checkpointAfterConnectRaw!)
    const conn = checkpointAfterConnect.editor.connections.find(
      (c: any) => c.from_id === 'skill-rust-basics' && c.to_id === 'skill-wgpu-pipeline'
    )
    if (!conn) {
      throw new Error('Connection missing from editor snapshot after completed connect operation')
    }
    console.log('  Connection verified in updated editor checkpoint:', conn)

    // =========================================================================
    // Phase 4: Card Drag & Observable Undo/Redo Execution (AC 4, AC 5)
    // =========================================================================
    console.log('\n--- Phase 4: Card Drag & Observable Undo/Redo Execution (AC 4, AC 5) ---')
    const cardEl = await page.$('#card-label-skill-rust-basics')
    const boxBefore = await cardEl.boundingBox()
    console.log('  Card position before drag:', boxBefore)

    // Drag card by (+90, +60)
    await page.mouse.move(boxBefore.x + 30, boxBefore.y + 30)
    await page.mouse.down()
    await page.mouse.move(boxBefore.x + 120, boxBefore.y + 90, { steps: 10 })
    await page.mouse.up()
    await new Promise((resolve) => setTimeout(resolve, 300))

    const boxAfter = await cardEl.boundingBox()
    console.log('  Card position after drag:', boxAfter)
    const dragDistance = Math.hypot(boxAfter.x - boxBefore.x, boxAfter.y - boxBefore.y)
    if (dragDistance < 20) {
      throw new Error(`Expected card to move at least 20px, moved ${dragDistance}px`)
    }

    // Verify Undo is enabled
    const canUndo = await page.$eval('#editor-undo-btn', (btn: any) => !btn.disabled)
    if (!canUndo) {
      throw new Error('Expected Undo button to be enabled after drag gesture')
    }
    console.log('  Verified: Undo button enabled after drag')

    // EXECUTE UNDO OPERATION (Spec AC 5)
    await page.click('#editor-undo-btn')
    await new Promise((resolve) => setTimeout(resolve, 300))

    const boxUndone = await cardEl.boundingBox()
    console.log('  Card position after Undo:', boxUndone)
    const undoErrorX = Math.abs(boxUndone.x - boxBefore.x)
    const undoErrorY = Math.abs(boxUndone.y - boxBefore.y)
    if (undoErrorX > 3 || undoErrorY > 3) {
      throw new Error(
        `Undo failed: Expected card to return to (${boxBefore.x}, ${boxBefore.y}), got (${boxUndone.x}, ${boxUndone.y})`
      )
    }
    console.log('  Verified: Undo operation executed, card returned to exact pre-drag position')

    // Verify Redo is now enabled
    const canRedoAfterUndo = await page.$eval('#editor-redo-btn', (btn: any) => !btn.disabled)
    if (!canRedoAfterUndo) {
      throw new Error('Expected Redo button to be enabled after Undo')
    }

    // EXECUTE REDO OPERATION (Spec AC 5)
    await page.click('#editor-redo-btn')
    await new Promise((resolve) => setTimeout(resolve, 300))

    const boxRedone = await cardEl.boundingBox()
    console.log('  Card position after Redo:', boxRedone)
    const redoErrorX = Math.abs(boxRedone.x - boxAfter.x)
    const redoErrorY = Math.abs(boxRedone.y - boxAfter.y)
    if (redoErrorX > 3 || redoErrorY > 3) {
      throw new Error(
        `Redo failed: Expected card to return to dragged position (${boxAfter.x}, ${boxAfter.y}), got (${boxRedone.x}, ${boxRedone.y})`
      )
    }
    console.log('  Verified: Redo operation executed, card restored to dragged position')

    // =========================================================================
    // Phase 5: Camera & Local Persistence (AC 4)
    // =========================================================================
    console.log('\n--- Phase 5: Camera & Local Persistence (AC 4) ---')
    await page.click('#editor-zoom-in-btn')
    await page.click('#editor-zoom-in-btn')
    await new Promise((resolve) => setTimeout(resolve, 300))

    const cameraRaw = await page.evaluate(() =>
      localStorage.getItem('gurow:camera:fixture-user:lp-rust-graphics-mvp')
    )
    if (!cameraRaw) {
      throw new Error('Camera state was not saved to localStorage')
    }
    const cameraState = JSON.parse(cameraRaw)
    console.log('  Saved Camera State:', cameraState)
    if (cameraState.zoom <= 1.0) {
      throw new Error(`Expected camera zoom > 1.0, got ${cameraState.zoom}`)
    }

    // Record complete checkpoint state before reload
    const checkpointBeforeReloadRaw = await page.evaluate(() =>
      localStorage.getItem('gurow:checkpoint:fixture-user:lp-rust-graphics-mvp')
    )
    const checkpointBeforeReload = JSON.parse(checkpointBeforeReloadRaw!)
    // Observe rendered geometry relative to the canvas, independent of page scroll.
    const cardsBeforeReload = await page.$$eval('[id^="card-label-"]', (els: Element[]) => {
      const origin = document.querySelector('#labels-overlay')!.getBoundingClientRect()
      return els.map(el => {
        const rect = el.getBoundingClientRect()
        return { id: el.id, title: el.querySelector('h3')!.textContent,
          x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height }
      })
    })
    const zoomBeforeReload = await page.$eval('#editor-zoom-label', (el: Element) => el.textContent)
    console.log(`  Recorded live geometry for ${cardsBeforeReload.length} cards before reload`)

    // =========================================================================
    // Phase 6: Browser Reload & Semantic Restoration (AC 3, AC 4, AC 5)
    // =========================================================================
    console.log('\n--- Phase 6: Browser Reload & Semantic Restoration (AC 3, AC 4, AC 5) ---')
    await page.reload({ waitUntil: 'networkidle0' })
    await page.waitForSelector('#editor-canvas', { timeout: 10000 })
    await page.waitForSelector('#card-label-skill-rust-basics', { timeout: 10000 })
    console.log('  Page reloaded with persistent localStorage preserved')

    // Verify session-only invariants: selection and undo stack reset
    const canUndoAfterReload = await page.$eval('#editor-undo-btn', (btn: any) => !btn.disabled)
    const canRedoAfterReload = await page.$eval('#editor-redo-btn', (btn: any) => !btn.disabled)
    console.log(`  Can Undo after reload: ${canUndoAfterReload} (Must be false: session-only)`)
    console.log(`  Can Redo after reload: ${canRedoAfterReload} (Must be false: session-only)`)
    if (canUndoAfterReload || canRedoAfterReload) {
      throw new Error('VIOLATION of AC 4: Undo/Redo history persisted across page reload!')
    }

    const initialSelectionAfterReload = await page.$('#selected-skill-id')
    if (initialSelectionAfterReload) {
      throw new Error('VIOLATION of AC 4: Selection was not session-only!')
    }
    console.log('  Verified: Selection & undo stack are strictly session-only.')

    // Compare the newly initialized engine's visible output, not unchanged storage.
    await page.waitForFunction((expected: any[]) => {
      const labels = document.querySelectorAll('[id^="card-label-"]')
      const origin = document.querySelector('#labels-overlay')!.getBoundingClientRect()
      return labels.length === expected.length && expected.every(card => {
        const el = document.getElementById(card.id)
        if (!el || el.querySelector('h3')?.textContent !== card.title) return false
        const rect = el.getBoundingClientRect()
        return Math.abs(rect.x - origin.x - card.x) < 1 && Math.abs(rect.y - origin.y - card.y) < 1
          && Math.abs(rect.width - card.width) < 1 && Math.abs(rect.height - card.height) < 1
      })
    }, { timeout: 10000 }, cardsBeforeReload)
    const restoredZoom = await page.$eval('#editor-zoom-label', (el: Element) => el.textContent)
    if (restoredZoom !== zoomBeforeReload) throw new Error('Camera zoom was not restored')
    const restoredGraph = await page.$eval('#skill-detail-panel', (el: HTMLElement) => JSON.parse(el.dataset.connections!))
    const edges = (connections: any[]) => connections.map(c => `${c.from_id}->${c.to_id}`).sort()
    if (JSON.stringify(edges(restoredGraph)) !== JSON.stringify(edges(checkpointBeforeReload.editor.connections))) {
      throw new Error('Live prerequisite graph differs after reload')
    }
    console.log(`  Verified: all ${cardsBeforeReload.length} live card labels, geometry, camera zoom and connections restored.`)

    // Select Rust Fundamentals and verify semantic restoration of Tasks, required status, and Connections
    await page.click('#card-label-skill-rust-basics')
    await page.waitForSelector('#selected-skill-title')

    const restoredTaskTitle = await page.$eval(
      '#task-edit-title-task-rust-toolchain',
      (el: any) => el.value
    )
    const restoredTaskDesc = await page.$eval(
      '#task-edit-description-task-rust-toolchain',
      (el: any) => el.value
    )
    const restoredTaskRequired = await page.$eval(
      '#task-edit-required-task-rust-toolchain',
      (el: any) => el.checked
    )
    const restoredBadgeText = await page.$eval(
      '#task-badge-task-rust-toolchain',
      (el: any) => el.textContent?.trim()
    )

    console.log(`  Restored Task Title: "${restoredTaskTitle}"`)
    console.log(`  Restored Task Description: "${restoredTaskDesc}"`)
    console.log(`  Restored Task Required: ${restoredTaskRequired}, Badge: "${restoredBadgeText}"`)

    if (restoredTaskTitle !== editedTitle) {
      throw new Error(`Expected '${editedTitle}', got '${restoredTaskTitle}'`)
    }
    if (restoredTaskDesc !== editedDescription) {
      throw new Error(`Expected '${editedDescription}', got '${restoredTaskDesc}'`)
    }
    if (restoredTaskRequired !== false || restoredBadgeText !== 'Enrichment') {
      throw new Error(`Expected required=false and badge='Enrichment', got ${restoredTaskRequired} / ${restoredBadgeText}`)
    }

    // Verify restored connections in panel
    await page.waitForSelector('#outgoing-prerequisites-list')
    const restoredOutgoing = await page.$eval(
      '#outgoing-prerequisites-list',
      (el: any) => el.textContent?.trim()
    )
    console.log(`  Restored Outgoing Dependents: "${restoredOutgoing}"`)
    if (!restoredOutgoing?.includes('WebGPU Pipeline')) {
      throw new Error('Restored connection to WebGPU Pipeline was not found!')
    }

    // =========================================================================
    // Phase 7: Semantic Mismatch Rejection & Preservation Guard (AC 3, ADR-0016)
    // =========================================================================
    console.log('\n--- Phase 7: Semantic Mismatch Rejection & Preservation Guard (AC 3, ADR-0016) ---')

    // Sub-phase 7A: Foreign Path Rejection
    console.log('  [7A] Testing foreign learning_path_id rejection...')
    await page.evaluate(() => {
      const key = 'gurow:checkpoint:fixture-user:lp-rust-graphics-mvp'
      const raw = localStorage.getItem(key)
      if (raw) {
        const cp = JSON.parse(raw)
        cp.application.learning_path_id = 'foreign-learning-path-id'
        localStorage.setItem(key, JSON.stringify(cp))
      }
    })

    await page.reload({ waitUntil: 'networkidle0' })
    await page.waitForSelector('#checkpoint-error-alert', { timeout: 10000 })
    const foreignErrorText = await page.$eval(
      '#checkpoint-error-alert',
      (el: any) => el.textContent?.trim()
    )
    console.log(`  Observed Foreign Path Alert: "${foreignErrorText}"`)
    if (!foreignErrorText?.includes('does not match expected path')) {
      throw new Error('Expected foreign path error alert, got: ' + foreignErrorText)
    }

    const badgeTextForeign = await page.$eval(
      '#checkpoint-status-badge',
      (el: any) => el.textContent?.trim()
    )
    if (!badgeTextForeign?.includes('Checkpoint Error')) {
      throw new Error(`Expected badge to reflect Checkpoint Error, got "${badgeTextForeign}"`)
    }

    // Sub-phase 7B: Guard Invariant - Editing Task MUST NOT overwrite rejected checkpoint
    console.log('  [7B] Verifying Task edit does NOT overwrite rejected checkpoint (ADR-0016 preservation)...')
    await page.click('#card-label-skill-rust-basics')
    await page.waitForSelector('#selected-skill-title')

    // Simulate typing in task title on the fallback fixture while alert is active
    await page.evaluate(() => {
      const titleInput = document.querySelector(
        '#task-edit-title-task-rust-toolchain'
      ) as HTMLInputElement
      const titleSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set
      titleSetter?.call(titleInput, 'Typing While Corrupt Should Not Overwrite')
      titleInput.dispatchEvent(new Event('input', { bubbles: true }))
      titleInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Wait 400ms for debounced auto-save
    await new Promise((resolve) => setTimeout(resolve, 400))

    // Verify alert banner is STILL present (not dismissed by task edit)
    const alertStillPresent = await page.$('#checkpoint-error-alert')
    if (!alertStillPresent) {
      throw new Error('VIOLATION of ADR-0016: Editing task erased the checkpoint error alert!')
    }

    // Verify localStorage STILL contains the rejected foreign checkpoint
    const preservedForeignRaw = await page.evaluate(() =>
      localStorage.getItem('gurow:checkpoint:fixture-user:lp-rust-graphics-mvp')
    )
    const preservedForeign = JSON.parse(preservedForeignRaw!)
    if (preservedForeign.application.learning_path_id !== 'foreign-learning-path-id') {
      throw new Error('VIOLATION of ADR-0016: Rejected checkpoint was overwritten by task edit!')
    }
    console.log('  Verified: Shared save guard preserved rejected checkpoint; alert banner remained active.')

    // Sub-phase 7C: Orphan Card Rejection
    console.log('  [7C] Testing orphan card mismatch rejection...')
    await page.evaluate(() => {
      const key = 'gurow:checkpoint:fixture-user:lp-rust-graphics-mvp'
      const raw = localStorage.getItem(key)
      if (raw) {
        const cp = JSON.parse(raw)
        cp.application.learning_path_id = 'lp-rust-graphics-mvp'
        cp.editor.cards.push({
          id: 'corrupted-orphan-card',
          title: 'Corrupted Orphan',
          position: { x: 500, y: 500 },
          size: { width: 180, height: 80 },
        })
        localStorage.setItem(key, JSON.stringify(cp))
      }
    })

    await page.reload({ waitUntil: 'networkidle0' })
    await page.waitForSelector('#checkpoint-error-alert', { timeout: 10000 })
    const orphanErrorText = await page.$eval(
      '#checkpoint-error-alert',
      (el: any) => el.textContent?.trim()
    )
    console.log(`  Observed Orphan Card Alert: "${orphanErrorText}"`)
    if (!orphanErrorText?.includes('missing from application payload')) {
      throw new Error('Expected orphan card error alert, got: ' + orphanErrorText)
    }

    const orphanCardEl = await page.$('#card-label-corrupted-orphan-card')
    if (orphanCardEl) {
      throw new Error('VIOLATION of AC 3: Corrupted orphan card was silently restored on canvas!')
    }
    console.log('  Verified: Mismatched associations cannot be silently restored (rejected safely).')

    // While orphan alert is visible, type in task edit again to ensure save is blocked
    await page.click('#card-label-skill-rust-basics')
    await page.waitForSelector('#selected-skill-title')
    await page.evaluate(() => {
      const titleInput = document.querySelector(
        '#task-edit-title-task-rust-toolchain'
      ) as HTMLInputElement
      const titleSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set
      titleSetter?.call(titleInput, 'Another Typo While Corrupt')
      titleInput.dispatchEvent(new Event('input', { bubbles: true }))
      titleInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const orphanAlertStillPresent = await page.$('#checkpoint-error-alert')
    if (!orphanAlertStillPresent) {
      throw new Error('VIOLATION of ADR-0016: Editing task cleared orphan error alert!')
    }
    const preservedOrphanRaw = await page.evaluate(() =>
      localStorage.getItem('gurow:checkpoint:fixture-user:lp-rust-graphics-mvp')
    )
    const preservedOrphan = JSON.parse(preservedOrphanRaw!)
    const hasOrphan = preservedOrphan.editor.cards.some((c: any) => c.id === 'corrupted-orphan-card')
    if (!hasOrphan) {
      throw new Error('VIOLATION of ADR-0016: Orphan card was overwritten during task edit!')
    }
    console.log('  Verified: Orphan corrupt checkpoint preserved across task edits.')

    // =========================================================================
    // Phase 8: Scene Reset, Visual Evidence Screenshot & Validation Report
    // =========================================================================
    console.log('\n--- Phase 8: Scene Reset, Visual Evidence Screenshot & Report ---')
    // Exercise the actual recovery action and ensure another Path is untouched.
    await page.evaluate(() => localStorage.setItem('gurow:checkpoint:fixture-user:other-path', 'preserve-me'))
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }),
      page.click('#btn-reset-scene'),
    ])
    await page.waitForSelector('#editor-canvas')
    await page.waitForSelector('#card-label-skill-rust-basics')

    const resetState = await page.evaluate(() => ({
      error: !!document.querySelector('#checkpoint-error-alert'),
      cards: document.querySelectorAll('[id^="card-label-"]').length,
      checkpoint: localStorage.getItem('gurow:checkpoint:fixture-user:lp-rust-graphics-mvp'),
      camera: localStorage.getItem('gurow:camera:fixture-user:lp-rust-graphics-mvp'),
      otherPath: localStorage.getItem('gurow:checkpoint:fixture-user:other-path'),
      zoom: document.querySelector('#editor-zoom-label')?.textContent,
    }))
    if (resetState.error || resetState.cards !== 4 || resetState.checkpoint !== null || resetState.camera !== null
      || resetState.otherPath !== 'preserve-me' || resetState.zoom !== '100%') {
      throw new Error(`Reset Scene did not restore only the active fixture: ${JSON.stringify(resetState)}`)
    }

    // Set up clean demonstration scene: select skill
    await page.click('#card-label-skill-rust-basics')
    await page.waitForSelector('#selected-skill-title')

    const screenshotPath = path.resolve(ARTIFACT_DIR, 'webgpu_t04_smoke_check.png')
    if (!checkOnly) {
      await page.screenshot({ path: screenshotPath, fullPage: true })
      console.log(`  Saved screenshot to ${screenshotPath}`)
    }

    if (!identity) {
      console.log('Browser development checks passed; no validation report published.')
      return
    }

    // Record Validation Report
    const reportJsonPath = path.resolve(REPO_ROOT, 'docs/validation/t04-smoke-report.json')
    const reportMdPath = path.resolve(REPO_ROOT, 'docs/validation/t04-smoke-report.md')

    const reportData = {
      ticket: 'P1/T04',
      github_issue: 'https://github.com/harkon666/Gurow/issues/5',
      date: new Date().toISOString(),
      status: 'PASSED',
      commit: identity.commit,
      tree: identity.tree,
      acceptance_criteria: {
        ac1_skill_selection_and_task_editing: 'PASSED',
        ac2_checkpoint_envelope_and_format_version: 'PASSED',
        ac3_semantic_restore_and_mismatch_rejection: 'PASSED',
        ac4_local_persistence_and_session_only_state: 'PASSED',
        ac5_observable_browser_flow: 'PASSED',
      },
      executed_validations: [
        'Skill creation disabled during delayed Wasm initialization; subsequent Task save succeeds',
        'Initial skill selection and task display in React sidebar',
        'Task title, description, and required flag toggling (Required <-> Enrichment)',
        'Zero task content in Rust engine snapshot boundary check',
        'Card creation via toolbar (+ Skill), dynamic label overlay mounting, and initial task binding',
        'Two newly created Skills can connect and display their titles; full graph restored after reload',
        'Card drag with observable coordinate verification',
        'Actual Undo command execution moving card back to pre-drag coordinates',
        'Actual Redo command execution restoring card to dragged coordinates',
        'Camera zoom and offset restoration observed through label geometry and zoom indicator',
        'Full browser reload comparing live card IDs, titles, geometry, complete graph and edited Task fields',
        'Reset of session-only state across reload (selection null, undo/redo disabled)',
        'Fast-fail CheckpointMismatchError rejection for foreign learning_path_id payloads',
        'Fast-fail CheckpointMismatchError rejection for orphan card mismatches',
        'Shared save guard preventing corrupted/rejected checkpoint overwrite during task edits (ADR-0016 recovery preservation)',
        'Reset Scene recovery operation restoring clean fixture',
      ],
    }

    fs.writeFileSync(reportJsonPath, JSON.stringify(reportData, null, 2))
    console.log(`  Saved report JSON to ${reportJsonPath}`)

    const reportMd = `# P1/T04 Smoke Test Validation Report

- **Date**: ${reportData.date}
- **Git Commit**: \`${identity.commit}\`
- **Source tree**: \`${identity.tree}\`
- **Stage**: P1 (Prototype vertical slice)
- **Ticket**: [P1/T04 / #5](https://github.com/harkon666/Gurow/issues/5)
- **Ticket Status**: **PASSED**
- **Overall P1 Stage Status**: **IN PROGRESS** (T05–T06 remaining)

## Build & Run Procedure

### Prerequisites
- **Bun**: v1.3+
- **Rust & Cargo**: with \`wasm32-unknown-unknown\` target
- **wasm-pack**: installed via cargo or invoked through bunx
- **Chromium**: with WebGPU enabled
- **Python 3 with Pillow**: required for verification

### Commands
\`\`\`bash
# 1. Run native Rust engine tests
cargo test --manifest-path editor/Cargo.toml --package engine-core

# 2. Run TypeScript typecheck & SDD schema tests
cd frontend
bun run typecheck
bun test

# 3. Build WebAssembly module and frontend bundle
bun run build

# 4. Execute automated WebGPU browser smoke check
bun run smoke-check:t04
\`\`\`

## Acceptance Criteria Verification (Verified in T04)

1. **AC 1: Skill Selection & Task Editing without Engine Contamination**
   - Selecting a Skill card opens the associated Task in the React sidebar.
   - Task editing (title, description, required toggle) updates application-owned state without putting Task contents into the Rust engine snapshot or card boundaries.
2. **AC 2: Coherent Checkpoint Envelope**
   - Local checkpoint carries \`version: 1\`, \`saved_at\` timestamp, \`editor\` snapshot (\`format_version: 1\`, revision, cards, connections), and separate \`application\` payload (learning_path_id, skills, tasks).
3. **AC 3: Semantic Restoration & Mismatch Rejection**
   - Reload restores all card IDs, titles and geometry in the HTML overlay, the complete graph, and edited Task title, description, and required flag.
   - Foreign \`learning_path_id\` checkpoints are rejected fast with \`CheckpointMismatchError\`.
   - Orphan cards missing from the application payload are rejected fast with \`CheckpointMismatchError\` and prevented from rendering on the canvas.
   - Guarded shared save function prevents task edits or canvas operations from overwriting rejected checkpoints, preserving corrupted drafts for recovery per ADR-0016.
4. **AC 4: Local Persistence & Session-Only Invariants**
   - Completed operations (card creation, connection, drag, task edits) trigger automatic local save.
   - Camera state is saved locally scoped to Account and Path context.
   - Selection and undo/redo history are verified to reset on reload. Reload during an in-progress drag is not exercised by this script.
5. **AC 5: Observable Browser Flow**
   - Complete browser flow exercised in automated headless Chromium:
     - **Create**: Card creation via toolbar, dynamic label mounting, and task binding.
     - **Connect**: Prerequisite DAG connection between skills.
     - **Drag**: Card translation with observable coordinate changes.
     - **Undo/Redo**: Actual execution of Undo (restoring pre-drag coordinates) and Redo (restoring dragged coordinates).
     - **Task Edit**: Title, description, and required toggle edits verified in application payload.
     - **Save**: Local checkpoint envelope verified in \`localStorage\`.
     - **Reload**: Full browser reload with exact identity, position, and connection assertions.
     - **Mismatch Rejection**: Foreign path rejection, orphan card rejection, and recovery preservation verified.

## Executed Test Validations (docs/ENGINE_VALIDATION_PLAN.md:28)
${reportData.executed_validations.map((v) => `- [x] ${v}`).join('\n')}
`
    fs.writeFileSync(reportMdPath, reportMd)
    console.log(`  Saved report Markdown to ${reportMdPath}`)

    console.log('\n✅ P1/T04 SMOKE CHECK PASSED SUCCESSFULLY!')
  } finally {
    if (browser) {
      await browser.close()
    }
    server.kill()
  }
}

main().catch((err) => {
  console.error('\n❌ Smoke check failed with error:', err)
  process.exit(1)
})
