import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/** Current Git source inputs, including dirty/untracked files, not only HEAD.
 * Encoding matches scripts/harness.py source_hash: sorted raw path bytes, NUL,
 * decimal permission mode + NUL + contents (or link:target / deleted), NUL.
 * Ignored build outputs and .harness reports cannot change source identity.
 * Symlinks are recorded, never read through to external contents.
 */
export function computeSourceFingerprint(repoRoot: string): string {
  const root = resolve(repoRoot)
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, maxBuffer: 64 * 1024 * 1024,
  })
  const names = new Map<string, Buffer>()
  for (let start = 0; start < output.length;) {
    const end = output.indexOf(0, start)
    if (end === -1) throw new Error('Git returned an unterminated source path')
    const name = output.subarray(start, end)
    if (name.length > 0) names.set(name.toString('hex'), name)
    start = end + 1
  }
  const hash = createHash('sha256')
  const prefix = Buffer.from(root + sep)
  const harness = Buffer.from('.harness/')
  for (const name of [...names.values()].sort(Buffer.compare)) {
    if (name.subarray(0, harness.length).equals(harness)) continue
    hash.update(name).update('\0')
    const path = Buffer.concat([prefix, name])
    try {
      // A tracked directory can be replaced by a symlink. Do not traverse it
      // when inspecting the now-missing tracked descendants from the index.
      let blocked = false
      for (let slash = name.indexOf(47); slash !== -1; slash = name.indexOf(47, slash + 1)) {
        if (!lstatSync(Buffer.concat([prefix, name.subarray(0, slash)])).isDirectory()) {
          blocked = true
          break
        }
      }
      const stat = blocked ? undefined : lstatSync(path)
      if (stat?.isSymbolicLink()) {
        hash.update('link:').update(readlinkSync(path, { encoding: 'buffer' }))
      } else if (stat?.isFile()) {
        hash.update(String(stat.mode & 0o777)).update('\0').update(readFileSync(path))
      } else {
        hash.update('deleted')
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      hash.update('deleted')
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}
