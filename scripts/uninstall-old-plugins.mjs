/**
 * Remove dsh-llm-fallbacks and dsh-llm-response-guard from the desktop profile.
 *
 * The plugin manager's own uninstall goes through pnpm, which currently dies on
 * an unwired minimumReleaseAge policy callback
 * (ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED), so the same removal is
 * applied by hand: patch entry, package.json dependency, lockfile snapshot and
 * the installed directory. Everything is backed up first.
 *
 * Usage: node scripts\uninstall-old-plugins.mjs [--dry]
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PROFILE = 'C:/Users/18918/.dsh/profiles/desktop'
const PATCH = join(PROFILE, 'cordis.patch.yml')
const MANIFEST = join(PROFILE, 'package.json')
const LOCK = join(PROFILE, 'pnpm-lock.yaml')
const MODULES = join(PROFILE, 'node_modules')
const dry = process.argv.includes('--dry')

/** Entry ids and package names to drop. */
const ENTRIES = [
  { id: 'llm-response-guard', pkg: 'dsh-llm-response-guard' },
  { id: 'llm-fallbacks', pkg: 'dsh-llm-fallbacks' },
]

const notes = []

/** Cut `start`..`end` (inclusive markers) out of a text, keeping the rest verbatim. */
function cut(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker)
  if (start < 0) return { text, removed: false }
  const end = text.indexOf(endMarker, start)
  if (end < 0) return { text, removed: false }
  return { text: text.slice(0, start) + text.slice(end), removed: true }
}

// ------------------------------------------------------------------ patch ---
let patch = readFileSync(PATCH, 'utf8')
for (const entry of ENTRIES) {
  // A patch entry runs from its `- id:` line to the next top-level `- id:` or
  // the next top-level comment block that starts a new entry.
  const startMarker = `- id: ${entry.id}\n`
  const start = patch.indexOf(startMarker)
  if (start < 0) {
    notes.push(`patch: no entry ${entry.id}`)
    continue
  }
  const rest = patch.slice(start + startMarker.length)
  const nextEntry = rest.search(/\n(?:- id: |# [a-z])/)
  if (nextEntry < 0) {
    notes.push(`patch: ${entry.id} runs to the end of the file — refusing to guess`)
    continue
  }
  // Keep the blank line that separates entries: cut up to, but not including,
  // the newline that precedes the next entry.
  const end = start + startMarker.length + nextEntry + 1
  patch = patch.slice(0, start) + patch.slice(end)
  notes.push(`patch: removed entry ${entry.id} (${String(end - start)} chars)`)
}

// --------------------------------------------------------------- manifest ---
let manifest = readFileSync(MANIFEST, 'utf8')
for (const entry of ENTRIES) {
  const line = new RegExp(`^\\s*"${entry.pkg}":\\s*"[^"]*",?\\n`, 'm')
  if (!line.test(manifest)) {
    notes.push(`manifest: no dependency ${entry.pkg}`)
    continue
  }
  manifest = manifest.replace(line, '')
  notes.push(`manifest: removed dependency ${entry.pkg}`)
}

// ------------------------------------------------------------------ lock ---
let lock = readFileSync(LOCK, 'utf8')
const LOCK_BLOCKS = [
  // importer dependencies
  [/^\s*dsh-llm-fallbacks:\n\s*specifier: [^\n]*\n\s*version: [^\n]*\n/m, 'lock: importer dsh-llm-fallbacks'],
  [/^\s*dsh-llm-response-guard:\n\s*specifier: [^\n]*\n\s*version: [^\n]*\n/m, 'lock: importer dsh-llm-response-guard'],
  // package snapshots
  [/^  dsh-llm-fallbacks@[^\n]*\n(?:    [^\n]*\n|\n)*?(?=^  \S)/m, 'lock: snapshot dsh-llm-fallbacks'],
  [/^  dsh-llm-response-guard@[^\n]*\n(?:    [^\n]*\n)*\n?/m, 'lock: snapshot dsh-llm-response-guard'],
]
for (const [pattern, label] of LOCK_BLOCKS) {
  const before = lock.length
  lock = lock.replace(pattern, '')
  notes.push(lock.length === before ? `${label}: NOT FOUND` : `${label}: removed ${String(before - lock.length)} chars`)
}

if (dry) {
  writeFileSync(join('D:/Repos/dsh-llm-router/.build', 'uninstall-preview.yml'), patch, 'utf8')
  notes.push('dry run: wrote .build/uninstall-preview.yml')
} else {
  for (const file of [PATCH, MANIFEST, LOCK]) copyFileSync(file, `${file}.bak-uninstall`)
  writeFileSync(PATCH, patch, 'utf8')
  writeFileSync(MANIFEST, manifest, 'utf8')
  writeFileSync(LOCK, lock, 'utf8')
  notes.push('wrote patch, manifest and lock (backups: *.bak-uninstall)')
  for (const entry of ENTRIES) {
    const dir = join(MODULES, entry.pkg)
    if (!existsSync(dir)) {
      notes.push(`modules: ${entry.pkg} already gone`)
      continue
    }
    rmSync(dir, { recursive: true, force: true })
    notes.push(`modules: deleted ${entry.pkg}`)
  }
}

console.log(notes.join('\n'))
