import puppeteer from 'puppeteer-core'
import { checkCanvas } from './check-canvas'
import { spawn, execSync, execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'

const REPO_ROOT = path.resolve(__dirname, '../..')

function sourceIdentity() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  if (git('status', '--porcelain', '--untracked-files=all')) {
    throw new Error('Smoke evidence requires a clean committed tree. Commit source changes before running; commit generated reports separately.')
  }
  return { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') }
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3456
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
      if (res.ok) return
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Server at ${url} failed to respond after ${maxAttempts * 200}ms`)
}

async function main() {
  console.log('=====================================================')
  console.log(' GUROW P1/T01: WEBGPU BROWSER SMOKE CHECK')
  console.log(' Procedure: cargo test -> bun test -> bun run build -> puppeteer WebGPU verification')
  console.log('=====================================================')

  const source = sourceIdentity()
  verifyPrerequisites()
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
  fs.mkdirSync(path.resolve(__dirname, '../../docs/validation'), { recursive: true })

  // 1. Environment & Git Commit reporting
  const gitSha = source.commit
  const osInfo = execSync('uname -srm').toString().trim()
  const chromiumPath = resolveChromiumExecutable()
  const chromiumVersion = execSync(`"${chromiumPath}" --version`).toString().trim()
  let gpuHardware = 'Unknown'
  try {
    gpuHardware = execSync('lspci 2>/dev/null | grep -i vga || true').toString().trim()
  } catch {
    // ignore
  }

  console.log('Git Commit SHA:   ', gitSha)
  console.log('OS & Kernel:      ', osInfo)
  console.log('Chromium Binary:  ', chromiumPath)
  console.log('Chromium Version: ', chromiumVersion)
  console.log('Host GPU Hardware:', gpuHardware.replace(/\n/g, ' | '))

  // 2. Layer 1: Execute Native Rust unit tests
  console.log('\n--- Layer 1: Native Rust Tests (cargo test) ---')
  execSync('cargo test', {
    cwd: path.resolve(__dirname, '../../editor'),
    stdio: 'inherit',
  })
  console.log('✓ Layer 1 (cargo test) PASSED')

  // 3. Layer 2: Execute TypeScript Protocol Schemas (SDD) & Invariant tests
  console.log('\n--- Layer 2: TypeScript Typecheck & Schemas (bun run typecheck, bun test) ---')
  execSync('bun run typecheck', {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
  })
  execSync('bun test', {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
  })
  console.log('✓ Layer 2 (bun test & typecheck) PASSED')

  // 4. Build Wasm and frontend bundle
  console.log('\nBuilding Wasm and frontend bundle...')
  execSync('bun run build', {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
  })

  // 5. Start server & wait for readiness
  console.log(`\nStarting server on port ${PORT}...`)
  const server = spawn('node', ['.output/server/index.mjs'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'inherit',
  })

  const baseUrl = `http://localhost:${PORT}`
  let browser: any = null
  try {
    await waitForServerReady(baseUrl)
    console.log(`✓ Server ready and accepting requests at ${baseUrl}`)
    console.log('\nLaunching Chromium with WebGPU & ANGLE compositing flags...')
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

    // -------------------------------------------------------------
    // Layer 3: Primary WebGPU Canvas & Interactive Editing Verification
    // -------------------------------------------------------------
    console.log('\n--- Layer 3: WebGPU Canvas & Interactive Editing Verification ---')
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })

    page.on('console', (msg: any) => {
      const text = msg.text()
      if (text.includes('WebGPU') || text.includes('error') || text.includes('Error')) {
        console.log(`[Browser Console ${msg.type()}]:`, text)
      }
    })

    console.log(`Navigating to ${baseUrl}/...`)
    // Observe the renderer's actual request; do not probe a separate adapter.
    await page.evaluateOnNewDocument(() => {
      const gpu = (navigator as any).gpu
      if (!gpu) return
      const requestAdapter = gpu.requestAdapter.bind(gpu)
      gpu.requestAdapter = async (options: unknown) => {
        const adapter = await requestAdapter(options)
        if (adapter) {
          const info = adapter.info || await adapter.requestAdapterInfo?.() || {}
          ;(window as any).__rendererAdapter = {
            available: true,
            vendor: info.vendor || 'unknown',
            architecture: info.architecture || 'unknown',
            device: info.device || 'unknown',
            description: info.description || 'unknown',
            isFallbackAdapter: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
            requestOptions: options,
          }
        }
        return adapter
      }
    })
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle0' })

    const canvasChecks = []
    for (const dpr of [1, 1.5, 2]) {
      const checkPage = await browser.newPage()
      await checkPage.setViewport({ width: 1280, height: 800, deviceScaleFactor: dpr })
      await checkPage.goto(baseUrl, { waitUntil: 'networkidle0' })
      canvasChecks.push({ phase: 'initial', ...await checkCanvas(checkPage, dpr) })
      await checkPage.setViewport({ width: 1180, height: 800, deviceScaleFactor: dpr })
      await checkPage.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      canvasChecks.push({ phase: 'resized', ...await checkCanvas(checkPage, dpr) })
      await checkPage.close()
    }

    const gpuInfo = await page.evaluate(() => (window as any).__rendererAdapter)

    console.log('\nWebGPU Adapter Report:', JSON.stringify(gpuInfo, null, 2))
    if (!gpuInfo?.available) {
      throw new Error(`WebGPU acceptance check failed: ${gpuInfo?.reason || 'Renderer did not request an adapter'}`)
    }
    console.log('✓ WebGPU adapter confirmed available in browser')

    // Wait for canvas element
    await page.waitForSelector('#editor-canvas', { timeout: 8000 })
    console.log('✓ #editor-canvas is mounted')

    // Wait for labels overlay and initial cards
    await page.waitForSelector('#card-label-skill-rust-basics', { timeout: 8000 })
    console.log('✓ Initial Skill cards loaded in engine and labels rendered in DOM')

    // Verify initial cards in DOM (US68: one flat card per Skill)
    const initialLabelIds = await page.$$eval('#labels-overlay > div', (elements: any[]) =>
      elements.map((el) => el.id)
    )
    console.log(`✓ Rendered label elements: [${initialLabelIds.join(', ')}]`)
    if (!initialLabelIds.includes('card-label-skill-rust-basics')) {
      throw new Error('Initial card card-label-skill-rust-basics missing from labels')
    }
    if (!initialLabelIds.includes('card-label-skill-wgpu-pipeline')) {
      throw new Error('Initial card card-label-skill-wgpu-pipeline missing from labels')
    }

    // Hit Testing & Selection on Canvas: Click Card 1
    console.log('\nTesting Hit Testing: Clicking over card 1 on #editor-canvas...')
    const cardRect1 = await page.$eval('#card-label-skill-rust-basics', (el: any) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    await page.mouse.click(cardRect1.x, cardRect1.y)

    await page.waitForFunction(
      () => document.querySelector('#selected-skill-id')?.textContent === 'skill-rust-basics',
      { timeout: 3000 }
    )
    const selId1 = await page.$eval('#selected-skill-id', (el: any) => el.innerText)
    const selTitle1 = await page.$eval('#selected-skill-title', (el: any) => el.innerText)
    console.log(`React Panel updated via Canvas Hit Test -> ID: "${selId1}", Title: "${selTitle1}"`)
    if (selId1 !== 'skill-rust-basics' || selTitle1 !== 'Rust Fundamentals') {
      throw new Error(`Selection mismatch: expected skill-rust-basics, got ${selId1}`)
    }
    console.log('✓ React panel successfully updated via Canvas hit test (Card 1)')

    // Hit Testing & Selection on Canvas: Click Card 2
    console.log('\nTesting Hit Testing: Clicking over card 2 on #editor-canvas...')
    const cardRect2 = await page.$eval('#card-label-skill-wgpu-pipeline', (el: any) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    await page.mouse.click(cardRect2.x, cardRect2.y)

    await page.waitForFunction(
      () => document.querySelector('#selected-skill-id')?.textContent === 'skill-wgpu-pipeline',
      { timeout: 3000 }
    )
    const selId2 = await page.$eval('#selected-skill-id', (el: any) => el.innerText)
    const selTitle2 = await page.$eval('#selected-skill-title', (el: any) => el.innerText)
    console.log(`React Panel updated via Canvas Hit Test -> ID: "${selId2}", Title: "${selTitle2}"`)
    if (selId2 !== 'skill-wgpu-pipeline' || selTitle2 !== 'WebGPU Pipeline') {
      throw new Error(`Selection mismatch: expected skill-wgpu-pipeline, got ${selId2}`)
    }
    console.log('✓ React panel successfully updated via second Canvas hit test (Card 2)')

    // Hit Testing & Selection on Canvas: Click Card 4 (Checking Enrichment Task badge)
    console.log('\nTesting Glossary Term: Clicking over card 4 to verify Enrichment Task label...')
    const cardRect4 = await page.$eval('#card-label-skill-concurrency', (el: any) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    await page.mouse.click(cardRect4.x, cardRect4.y)

    await page.waitForFunction(
      () => document.querySelector('#selected-skill-id')?.textContent === 'skill-concurrency',
      { timeout: 3000 }
    )
    const taskBadges = await page.$$eval('#skill-detail-panel span', (elements: any[]) =>
      elements.map((el) => (el.textContent || el.innerText).trim())
    )
    if (!taskBadges.includes('Enrichment Task')) {
      throw new Error(
        `Glossary verification failed: expected "Enrichment Task" badge, got [${taskBadges.join(', ')}]`
      )
    }

    console.log('✓ Glossary term verified: non-required Task correctly labeled "Enrichment Task"')

    // Capture canvas bounding box dynamically
    const canvasBox = await page.$eval('#editor-canvas', (el: any) => {
      const r = el.getBoundingClientRect()
      return {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }
    })
    console.log(
      `✓ Canvas bounding rect dynamically read: [x=${canvasBox.x}, y=${canvasBox.y}, w=${canvasBox.width}, h=${canvasBox.height}]`
    )

    // Capture screenshot
    const screenshotPath = path.join(ARTIFACT_DIR, 'webgpu_smoke_check.png')
    const screenshot = await page.screenshot({ type: 'png', fullPage: true })

    // Strict pixel assertion on WebGPU canvas output supporting both linear and sRGB surface formats
    console.log('\nVerifying canvas rendering output via pixel inspection...')
    const pixelAnalysisScript = `
from PIL import Image
import sys, io
im = Image.open(io.BytesIO(sys.stdin.buffer.read()))
# Dynamic crop from actual canvas bounding rect with 4px inset
x1 = ${canvasBox.x} + 4
y1 = ${canvasBox.y} + 4
x2 = ${canvasBox.x} + ${canvasBox.width} - 4
y2 = ${canvasBox.y} + ${canvasBox.height} - 4
crop = im.crop((x1, y1, x2, y2))
total_pixels = crop.size[0] * crop.size[1]
colors = crop.getcolors(maxcolors=200000)

# Colors in linear space (e.g. SwiftShader / BGRA8Unorm):
clear_linear = (18, 20, 28)
card_fill_linear = (28, 35, 47)
border_selected_linear = (59, 130, 245)

# Colors in sRGB-encoded space (e.g. hardware GPU / BGRA8UnormSrgb):
clear_srgb = (76, 80, 94)
card_fill_srgb = (94, 105, 120)
border_selected_srgb = (128, 185, 248)

container_bg = (2, 6, 24)

def dist(c1, c2):
    return max(abs(c1[0] - c2[0]), abs(c1[1] - c2[1]), abs(c1[2] - c2[2]))

clear_count = sum(c[0] for c in colors if dist(c[1][:3], clear_linear) <= 4 or dist(c[1][:3], clear_srgb) <= 4)
card_count = sum(c[0] for c in colors if dist(c[1][:3], card_fill_linear) <= 4 or dist(c[1][:3], card_fill_srgb) <= 4 or dist(c[1][:3], border_selected_linear) <= 4 or dist(c[1][:3], border_selected_srgb) <= 4)
bg_count = sum(c[0] for c in colors if dist(c[1][:3], container_bg) <= 2)

clear_pct = (clear_count / total_pixels) * 100
card_pct = (card_count / total_pixels) * 100
bg_pct = (bg_count / total_pixels) * 100

print(f"PIXELS: clear={clear_pct:.2f}%, card={card_pct:.2f}%, container_bg={bg_pct:.2f}%")
if clear_pct < 40.0:
    print(f"FAIL: Shader clear color not detected on canvas! clear_pct={clear_pct:.2f}%")
    exit(1)
if card_pct < 3.0:
    print(f"FAIL: Card quad fill not detected on canvas! card_pct={card_pct:.2f}%")
    exit(1)
if bg_pct > 20.0:
    print(f"FAIL: Canvas appears unrendered or transparent (container bg dominant)! bg_pct={bg_pct:.2f}%")
    exit(1)
print("PASS")
`
    const pixelCheckResult = execFileSync('python3', ['-c', pixelAnalysisScript], { input: screenshot, encoding: 'utf8' }).trim()
    console.log(pixelCheckResult)
    if (!pixelCheckResult.includes('PASS')) {
      throw new Error(`Canvas pixel verification failed: ${pixelCheckResult}`)
    }

    const clearMatch = pixelCheckResult.match(/clear=([\d.]+)%/)
    const cardMatch = pixelCheckResult.match(/card=([\d.]+)%/)
    const bgMatch = pixelCheckResult.match(/container_bg=([\d.]+)%/)
    const measuredClearPct = clearMatch ? parseFloat(clearMatch[1]) : 0
    const measuredCardPct = cardMatch ? parseFloat(cardMatch[1]) : 0
    const measuredBgPct = bgMatch ? parseFloat(bgMatch[1]) : 0

    console.log(
      `✓ Canvas pixel assertion PASSED: clear=${measuredClearPct.toFixed(1)}% (>=40.0%), card=${measuredCardPct.toFixed(1)}% (>=3.0%), container_bg=${measuredBgPct.toFixed(1)}% (<=20.0%)`
    )

    // Persist recorded implementation and test evidence
    const adapterType =
      gpuInfo.architecture === 'swiftshader'
        ? 'SwiftShader (Software Fallback via ANGLE)'
        : gpuInfo.isFallbackAdapter === true ? 'Software fallback'
        : gpuInfo.isFallbackAdapter === false ? 'Hardware GPU' : 'Unknown (browser did not expose fallback status)'

    const reportData = {
      timestamp: new Date().toISOString(),
      gitCommit: gitSha,
      gitTree: source.tree,
      sourceClean: true,
      ticket: 'P1/T01',
      status: {
        ticketStatus: 'PASSED',
        p1StageStatus: 'IN_PROGRESS',
      },
      layersExecuted: [
        'Layer 1: Native Rust tests (coordinate transforms, hit-testing, protocol serialization, cards with selection query)',
        'Layer 2: TypeScript protocol schemas & invariants (Matt Pocock SDD, Zod runtime validation, single selection authority)',
        'Layer 3: Browser WebGPU integration & hit-testing (Chromium WebGPU, canvas hit-test selection, pixel assertion, Enrichment Task glossary verification)',
      ],
      buildAndRunProcedure: {
        prerequisites: [
          'Bun v1.3+ (package manager and test runner)',
          'Rust & Cargo with wasm32-unknown-unknown target',
          'wasm-pack (via bunx or cargo)',
          'Chromium or Google Chrome binary',
          'Python 3 with Pillow library (pip install Pillow)',
        ],
        commands: [
          'cargo test --manifest-path editor/Cargo.toml',
          'cd frontend && bun run typecheck',
          'cd frontend && bun test',
          'cd frontend && bun run build',
          'cd frontend && bun run smoke-check',
        ],
      },
      environment: {
        os: osInfo,
        browser: chromiumVersion,
        browserPath: chromiumPath,
        viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
        checkedDevicePixelRatios: [1, 1.5, 2],
        hostGpuHardware: gpuHardware,
        webgpuAdapter: {
          ...gpuInfo,
          adapterType,
          note: `Renderer adapter observed at requestAdapter: ${adapterType}. Hardware performance is not measured by this smoke check.`,
        },
      },
      results: {
        layer1RustTests: 'PASSED',
        layer2SchemaTests: 'PASSED',
        layer2Typecheck: 'PASSED',
        canvasChecks,
        canvasMounted: true,
        canvasDrawnPixelVerified: true,
        measuredClearPct,
        measuredCardPct,
        measuredBgPct,
        initialCardsLoaded: initialLabelIds,
        canvasHitTestCard1: selId1,
        canvasHitTestCard2: selId2,
        enrichmentTaskGlossaryVerified: true,
      },
      verifiedCriteria: [
        `A real WebGPU browser initializes the Rust/Wasm editor and displays created Skill cards and HTML labels (pixel assertion: clear=${measuredClearPct.toFixed(1)}% [asserted >=40.0%], card=${measuredCardPct.toFixed(1)}% [asserted >=3.0%]).`,
        'Selecting different cards shows the corresponding stable fixture Skill ID and title in React, with one flat card per Skill and visible selection state.',
        'Pure editor core owns cards, positions, and selection; React maintains zero canvas card positions.',
        'Defined commands and events connect engine and application via Zod-validated JSON boundary per Matt Pocock SDD.',
        'Smoke check records the actual browser and GPU environment, exact build/run commands, and git SHA.',
        'Glossary terms respected: non-required tasks verified labeled as "Enrichment Task" per CONTEXT.md.',
      ],
      plannedChecksRemaining: [
        'P1/T02: Pan and zoom around pointer respecting zoom range and coordinate bounds; card dragging with 1 undo step per drag.',
        'P1/T03: Prerequisite connections and DAG cycle rejection.',
        'P1/T04: Task editing in sidebar and local save/restore.',
        'P1/T05: GPU device loss recovery while preserving CPU document; full keyboard list navigation through tasks.',
        'P1/T06: Latency acceptance gate (p95 frame time <= 20ms, input-to-visible <= 50ms on 1,000 cards workload).',
      ],
    }

    const finalSource = sourceIdentity()
    if (finalSource.commit !== source.commit || finalSource.tree !== source.tree) {
      throw new Error('Source changed during smoke check; refusing to publish evidence.')
    }
    fs.writeFileSync(screenshotPath, screenshot)

    const reportPathJson = path.resolve(__dirname, '../../docs/validation/t01-smoke-report.json')
    fs.writeFileSync(reportPathJson, JSON.stringify(reportData, null, 2))

    const reportPathMd = path.resolve(__dirname, '../../docs/validation/t01-smoke-report.md')
    const mdContent = `# P1/T01 Smoke Test Validation Report

- **Date**: ${reportData.timestamp}
- **Git Commit**: \`${gitSha}\`
- **Source tree**: \`${source.tree}\` (clean before build and before publishing evidence)
- **Stage**: P1 (Prototype vertical slice)
- **Ticket**: [P1/T01 / #2](https://github.com/harkon666/Gurow/issues/2)
- **Ticket Status**: **PASSED**
- **Overall P1 Stage Status**: **IN PROGRESS** (T02–T06 remaining)

## Build & Run Procedure

### Prerequisites
- **Bun**: v1.3+ (\`curl -fsSL https://bun.sh/install | bash\`)
- **Rust & Cargo**: with \`wasm32-unknown-unknown\` target (\`rustup target add wasm32-unknown-unknown\`)
- **wasm-pack**: installed via cargo or invoked through bunx
- **Chromium**: Chromium or Google Chrome binary in \`PATH\` or pointed to by \`PUPPETEER_EXECUTABLE_PATH\`
- **Python 3 with Pillow**: required for pixel inspection (\`pip install Pillow\`)

### Commands
\`\`\`bash
# 1. Run native Rust engine tests
cargo test --manifest-path editor/Cargo.toml

# 2. Run TypeScript typecheck & SDD schema tests
cd frontend
bun run typecheck
bun test

# 3. Build WebAssembly module and frontend bundle
bun run build

# 4. Execute automated WebGPU browser smoke check
bun run smoke-check
\`\`\`

## Test Layers Executed

1. **Layer 1: Native Rust unit tests** (\`cargo test\`)
   - Document and card creation invariants
   - World ↔ screen coordinate roundtrips
   - Hit testing and selection logic with \`SelectionChange\` struct
   - JSON protocol command/event serialization for all variants including \`GpuError\`
   - Card query with selection status (\`cards_with_selection\`)
2. **Layer 2: TypeScript Protocol Schemas & Invariant Tests** (\`bun run typecheck\`, \`bun test\`)
   - Matt Pocock Schema-Driven Development (SDD) Zod validation for commands and events
   - Wire-format roundtrip verification for commands and events
   - Coordinate transformations between logical CSS pixels and canvas buffer
   - Single selection authority invariants without React position store
3. **Layer 3: Browser WebGPU integration test** (\`bun run smoke-check\`)
   - Headless Chromium WebGPU initialization and dynamic canvas pixel verification
   - Initial Learning Path fixture loaded into Rust engine and HTML label overlays rendered
   - Canvas hit-testing on multiple cards updating React detail panel with authoritative ID and Title
   - Glossary alignment verified: non-required tasks verified labeled as "Enrichment Task" per \`CONTEXT.md\`

## Recorded Environment

| Parameter | Recorded Value |
|---|---|
| Git Commit SHA | \`${gitSha}\` |
| Viewport | 1280 × 800 CSS px; primary DPR 1; additional DPR 1.5 and 2 |
| OS & Kernel | \`${osInfo}\` |
| Browser | \`${chromiumVersion}\` |
| Chromium Path | \`${chromiumPath}\` |
| Host GPU Hardware | \`${gpuHardware}\` |
| WebGPU Adapter Vendor | \`${gpuInfo.vendor}\` |
| WebGPU Architecture | \`${gpuInfo.architecture}\` |
| Adapter Classification | **${adapterType}** |

> [!NOTE]
> Renderer adapter observed at its actual request: **${adapterType}**. Host hardware does not identify the adapter used; this run makes no hardware performance claim.

## Acceptance Evidence (Verified in T01)

1. **WebGPU Initialization & Active Draw**: Canvas initialized with WebGPU and actively drew scene geometry. Pixel inspection verified shader clear color (${measuredClearPct.toFixed(1)}% of canvas, asserted >= 40.0%) and card quad fills (${measuredCardPct.toFixed(1)}% of canvas, asserted >= 3.0%), dynamically cropped from canvas bounding rect and supporting both linear and sRGB adapters.
2. **Hit Testing & Selection**: Click events delivered directly to \`#editor-canvas\` triggered pointer event dispatch to the Rust engine, executing engine-side hit-testing to select \`${selId1}\` and \`${selId2}\`.
3. **DPR and Selection Pixels**: At DPR 1, 1.5, and 2, before and after resizing, backing dimensions match CSS × DPR, label IDs exactly match the fixture, and GPU highlight moves between Skills with HTML overlays hidden.
4. **React Panel Sync**: Panel displayed Skill ID and Title from engine selection events, and Learning Outcome from the React learning fixture; React maintains zero canvas card positions (ADR-0015).
5. **Glossary Term Alignment**: Non-required tasks verified labeled as "Enrichment Task" in the React detail panel per CONTEXT.md.
6. **Typed Protocol Boundary**: Commands and events validated at runtime using Zod schemas per Matt Pocock SDD pattern, with typed \`GpuError\` handling.

## Planned Checks Remaining for Later P1 Tickets (Not Run in T01)

- **T02**: Pan, zoom around pointer (0.1–4.0x limits), dragging cards with pointer offset preservation, and 1 undo step per drag.
- **T03**: Create prerequisite connections and reject cycle-creating edges.
- **T04**: Edit Task in sidebar as application-owned data and restore complete local scene upon reload.
- **T05**: GPU device loss recovery preserving CPU-side document; fallback list task access.
- **T06**: Performance benchmark on primary workload (1,000 cards, 2,000 connections; p95 frame time <= 20ms, latency <= 50ms).
`
    fs.writeFileSync(reportPathMd, mdContent)
    console.log(`✓ Evidence recorded in docs/validation/t01-smoke-report.md and .json`)

    console.log('\n=====================================================')
    console.log(' T01 SMOKE CHECK PASSED: ALL T01 CRITERIA VERIFIED!')
    console.log('=====================================================')
  } finally {
    if (browser) await browser.close()
    server.kill()
  }
}

main().catch((err) => {
  console.error('\n❌ SMOKE CHECK FAILED:', err)
  process.exit(1)
})
