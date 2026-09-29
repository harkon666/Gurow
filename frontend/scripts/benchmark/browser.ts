/**
 * Browser and production-server helpers shared by the T06 benchmark drivers.
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Resolves the Chromium binary from the environment or PATH. */
export function resolveChromiumExecutable(): string {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  const candidates = ['chromium', 'google-chrome-stable', 'google-chrome']
  for (const bin of candidates) {
    try {
      const resolved = execSync(`which ${bin} 2>/dev/null`, { encoding: 'utf8' }).trim()
      if (resolved && fs.existsSync(resolved)) return resolved
    } catch {
      // continue
    }
  }
  throw new Error('Chromium executable not found in PATH.')
}

/** Polls the production server until it answers, or throws. */
export async function waitForServerReady(url: string, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 200) return
    } catch {
      // continue
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Server at ${url} failed to respond after ${maxAttempts} attempts.`)
}

/**
 * Hashes the production server entry and the Wasm package it serves, or
 * returns null when no build exists.
 */
export function computeBuildHash(frontendDir: string): string | null {
  const serverEntry = path.resolve(frontendDir, '.output/server/index.mjs')
  if (!fs.existsSync(serverEntry)) return null
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(serverEntry))
  const wasmDir = path.resolve(frontendDir, 'src/pkg')
  if (fs.existsSync(wasmDir)) {
    for (const entry of fs.readdirSync(wasmDir).sort()) {
      if (entry.endsWith('.wasm') || entry.endsWith('.js')) {
        hash.update(entry)
        hash.update(fs.readFileSync(path.resolve(wasmDir, entry)))
      }
    }
  }
  return hash.digest('hex')
}
