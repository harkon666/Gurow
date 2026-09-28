import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { computeSourceFingerprint } from './sourceFingerprint'

const fixtures = fileURLToPath(new URL('../../../.harness/source-fingerprint-tests/', import.meta.url))
mkdirSync(fixtures, { recursive: true })
function fixture() {
  const root = mkdtempSync(join(fixtures, 'repo-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '--quiet')
  writeFileSync(join(root, '.gitignore'), 'build/\n')
  writeFileSync(join(root, 'source.ts'), 'export const value = 1\n')
  chmodSync(join(root, 'source.ts'), 0o644)
  git('add', '.')
  return { root, git, hash: () => computeSourceFingerprint(root) }
}

describe('current Git source fingerprint (real filesystem/Git)', () => {
  it('matches the existing Python harness source_hash encoding', () => {
    const { root, hash } = fixture()
    unlinkSync(join(root, 'source.ts'))
    writeFileSync(join(root, 'é\nnew.ts'), 'dirty bytes\0')
    chmodSync(join(root, 'é\nnew.ts'), 0o751)
    symlinkSync('missing-target', join(root, 'link'))
    mkdirSync(join(root, '.harness'))
    writeFileSync(join(root, '.harness', 'report'), 'ignored')
    writeFileSync(Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff])]), 'raw name')
    const harness = fileURLToPath(new URL('../../../scripts/harness.py', import.meta.url))
    const python = execFileSync('python3', ['-c',
      'import runpy,sys; from pathlib import Path; f=runpy.run_path(sys.argv[1])["source_hash"]; f.__globals__["ROOT"]=Path(sys.argv[2]); print(f())',
      harness, root], { encoding: 'utf8' }).trim()
    expect(hash()).toBe(python)
  })

  it('is stable, SHA256-shaped, and independent of staging', () => {
    const { root, hash, git } = fixture()
    const first = hash()
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(hash()).toBe(first)
    writeFileSync(join(root, 'new.ts'), 'new input')
    const untracked = hash()
    git('add', 'new.ts')
    expect(hash()).toBe(untracked)
  })

  it('changes for dirty tracked content, untracked source, modes, paths and deletion', () => {
    const { root, hash } = fixture()
    let previous = hash()
    const changed = () => { const current = hash(); expect(current).not.toBe(previous); previous = current }
    writeFileSync(join(root, 'source.ts'), 'export const value = 2\n'); changed()
    writeFileSync(join(root, 'new source\nwith unicode é.ts'), 'new source'); changed()
    chmodSync(join(root, 'source.ts'), 0o755); changed()
    renameSync(join(root, 'new source\nwith unicode é.ts'), join(root, 'renamed.ts')); changed()
    unlinkSync(join(root, 'source.ts')); changed()
    expect(hash()).toBe(previous)
  })

  it('excludes ignored build artifacts and all harness output, even when not ignored by Git', () => {
    const { root, hash, git } = fixture()
    const first = hash()
    mkdirSync(join(root, 'build'))
    writeFileSync(join(root, 'build', 'app.js'), 'build one')
    mkdirSync(join(root, '.harness'))
    writeFileSync(join(root, '.harness', 'report.json'), 'report one')
    expect(hash()).toBe(first)
    git('add', '.harness/report.json')
    writeFileSync(join(root, 'build', 'app.js'), 'build two')
    writeFileSync(join(root, '.harness', 'report.json'), 'report two')
    expect(hash()).toBe(first)
  })

  it('hashes symlink targets without following external contents, including dangling links', () => {
    const { root, hash } = fixture()
    const outside = mkdtempSync(join(fixtures, 'external-'))
    writeFileSync(join(outside, 'one'), 'external one')
    symlinkSync(join(outside, 'one'), join(root, 'linked'))
    const first = hash()
    writeFileSync(join(outside, 'one'), 'external changed')
    expect(hash()).toBe(first)
    unlinkSync(join(root, 'linked'))
    symlinkSync(join(outside, 'missing'), join(root, 'linked'))
    expect(hash()).not.toBe(first)
  })

  it('does not follow replaced parent directories of tracked paths', () => {
    const { root, git, hash } = fixture()
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'nested', 'source.ts'), 'tracked')
    git('add', 'nested/source.ts')
    renameSync(join(root, 'nested'), join(root, '.harness-nested'))
    const outside = mkdtempSync(join(fixtures, 'external-'))
    writeFileSync(join(outside, 'source.ts'), 'external')
    symlinkSync(outside, join(root, 'nested'))
    const first = hash()
    writeFileSync(join(outside, 'source.ts'), 'external changed')
    expect(hash()).toBe(first)
  })

  it('sorts raw Git filename bytes and supports non-UTF8 names without collisions', () => {
    const { root, hash } = fixture()
    const prefix = Buffer.from(`${root}/`)
    const a = Buffer.concat([prefix, Buffer.from([0xff])])
    const b = Buffer.concat([prefix, Buffer.from([0xfe])])
    writeFileSync(a, 'same'); writeFileSync(b, 'same')
    const first = hash()
    unlinkSync(a)
    const withoutA = hash()
    expect(withoutA).not.toBe(first)
    writeFileSync(a, 'same'); unlinkSync(b)
    expect(hash()).not.toBe(withoutA)
    writeFileSync(b, 'same')
    expect(hash()).toBe(first)
  })
})
