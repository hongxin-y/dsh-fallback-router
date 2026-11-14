/**
 * Enabled-read sweep (plan fallbacks-web-ux-alignment T5 acceptance, QC S-2
 * follow-up): the config-level `enabled` switch is REMOVED (T2, breaking) —
 * every runtime gate reads content presence through `isFallbackActive`
 * (`src/config.ts`). The T5 "zero config-level `enabled` reads in src/"
 * grep-sweep ran manually; this spec pins it in the house static-scan style
 * (cf. tests/peer-deps.test.ts, tests/export-surface.spec.ts) so a
 * reintroduction fails CI instead of rotting silently.
 *
 * Method: walk every `.ts`/`.tsx` file under `src/`, skip full-line comments
 * (the historical prose documenting the removal — e.g. config.ts' "the
 * former `config.enabled` sites" note — is legitimate, and the pin targets
 * live reads), then match the `enabled` token (`\benabled\b`, case-sensitive
 * — camelCase symbols like `configEnabled`/`badgeEnabled` are different
 * identifiers). Three assertions:
 * 1. the removed read `config.enabled` appears NOWHERE in src/ (zero
 *    tolerance, no allowlist);
 * 2. `src/config.ts` — the `FallbacksConfig` interface +
 *    `defaultFallbacksConfig` home — carries no `enabled` token at all (the
 *    schema, gateway CONFIG_KEYS, TUI and store layers hold no allowlist
 *    entries either, so the exact-set assertion below covers them by
 *    construction);
 * 3. every remaining `enabled` occurrence is EXACTLY the allowlisted legal
 *    set — two-way equality, so a new offender AND the removal of an
 *    allowlisted site both fail and force a conscious allowlist update.
 *
 * The allowlist families (each entry cites why it is legal):
 * - subagent-policy `state: 'enabled'` family — the dsh subagent plugin's
 *   policy-state enum value ('enabled' vs 'disabled') plus the settings
 *   payload's own `enabled` boolean: a different concept, not FallbacksConfig.
 * - gateway `LEGACY_KEYS` strip set — the removed key is tolerated on read
 *   and stripped from every snapshot/write (stored profiles must keep
 *   loading); `tests/gateway.spec.ts` pins the legacy round-trip.
 * - locale/TUI copy — the `general.enabled` badge locale keys and the
 *   `/fallbacks config` dump word: display strings, not config reads.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolve(here, '..', 'src')

/** Every `.ts`/`.tsx` file under `dir` (sorted, deterministic). */
function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...listSourceFiles(path))
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

/** A full-line comment (`// …`, `/* …`, JSDoc continuation) — not code. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')
}

interface EnabledHit {
  /** Path relative to src/ (posix separators). */
  file: string
  /** 1-based line number. */
  line: number
  /** The raw source line. */
  text: string
}

const sourceFiles = listSourceFiles(srcRoot)
const hits: EnabledHit[] = []
for (const path of sourceFiles) {
  const file = path.slice(srcRoot.length + 1).split('\\').join('/')
  readFileSync(path, 'utf8').split('\n').forEach((text, index) => {
    if (isCommentLine(text)) return
    if (/\benabled\b/.test(text)) hits.push({ file, line: index + 1, text })
  })
}

function fmt(hit: EnabledHit): string {
  return `  src/${hit.file}:${hit.line}: ${hit.text.trim()}`
}

/**
 * The legal `enabled` occurrences — the ALLOWLIST. Each entry pins one file
 * with a line-matching pattern and the EXACT expected count; `reason` cites
 * why the occurrence is legal (legacy strip / different concept / copy).
 * Exactness is two-way: a new offender (an unmatched line, a count going up,
 * a file with no entries) and the removal of a legal site (a count going
 * down) both fail this spec instead of silently rotting the allowlist.
 * Patterns within one file are pairwise disjoint so counts stay unambiguous.
 */
interface AllowlistEntry {
  file: string
  /** Matched against the raw (untrimmed) source line. */
  pattern: RegExp
  count: number
  reason: string
}

const ALLOWED_ENABLED_HITS: readonly AllowlistEntry[] = [
  // Subagent-policy `state: 'enabled'` family — the dsh subagent plugin's
  // policy-state enum value and the settings payload's own `enabled`
  // boolean (the host contract), NOT the removed FallbacksConfig switch.
  { file: 'subagent-policy.ts', pattern: /state: 'enabled'/, count: 3, reason: "subagent-policy state enum ('enabled' arm)" },
  { file: 'subagent-policy.ts', pattern: /readonly enabled: boolean|settings\.enabled/, count: 2, reason: 'the dsh settings payload carries its own `enabled` boolean (host contract, not FallbacksConfig)' },
  { file: 'gateway.ts', pattern: /state: 'enabled'/, count: 3, reason: "subagent-policy state enum ('enabled' arm) in the gateway wire types" },
  { file: 'gateway.ts', pattern: /policy\.state !== 'enabled'/, count: 1, reason: "subagent-policy state enum ('enabled' arm) — the allowlist sync write gate" },
  { file: 'gateway.ts', pattern: /^\s*'enabled',\s*$/, count: 1, reason: 'LEGACY_KEYS strip set — the removed key is tolerated on read and stripped from every snapshot/write' },
  { file: 'index.ts', pattern: /'enabled'/, count: 4, reason: "subagent-policy state enum ('enabled' arm) dispatch gates" },
  { file: 'client/fallbacks-store.ts', pattern: /'enabled'/, count: 4, reason: "subagent-policy state enum ('enabled' arm) in the client store parse/view" },
  // dsh-llm-router: the card is a thin shell around the model panel, so the
  // subagent-policy render gates it used to own no longer exist here.
  // Locale/TUI copy — display strings, not config reads.
  { file: 'client/locales.ts', pattern: /'general\.enabled':/, count: 2, reason: 'badge locale dictionary keys (copy)' },
  { file: 'client/GeneralFallbacksRow.tsx', pattern: /'general\.enabled'/, count: 2, reason: 'badge locale key read + compare (copy)' },
  { file: 'commands.ts', pattern: /configEnabled: 'enabled',/, count: 1, reason: 'the /fallbacks config dump word (copy)' },
  // dsh-llm-router: the per-provider retry row carries its own `enabled`
  // boolean (a row-level opt-in for the retry window), NOT the removed
  // config-level master switch — the Plugins-page toggle stays the only
  // master switch, and `isFallbackActive` still gates on content presence.
  { file: 'client/ModelsPanel.tsx', pattern: /row\.enabled/, count: 1, reason: 'per-provider retry row toggle (row-level, not the removed config switch)' },
  { file: 'client/ModelsPanel.tsx', pattern: /enabled: !item\.enabled/, count: 1, reason: 'per-provider retry row toggle write (row-level, not the removed config switch)' },
  // dsh-llm-router: the retry row's own `enabled` field (the per-provider
  // retry opt-in) lives in the model layer — again a row-level flag, never a
  // config-level master switch.
  { file: 'models.ts', pattern: /^\s*enabled: boolean$/, count: 1, reason: 'ProviderRetry row field declaration (row-level opt-in)' },
  { file: 'models.ts', pattern: /^\s*enabled: true,$/, count: 1, reason: 'DEFAULT_PROVIDER_RETRY row default (row-level opt-in)' },
  { file: 'models.ts', pattern: /enabled: bool\(record\.enabled, DEFAULT_PROVIDER_RETRY\.enabled\)/, count: 1, reason: 'retry row normalization (row-level opt-in)' },
  { file: 'models.ts', pattern: /exact\.enabled \? exact : undefined/, count: 1, reason: 'retryFor honours the row opt-in (row-level, not the removed config switch)' },
  { file: 'schema.ts', pattern: /enabled: z\.boolean\(\),/, count: 1, reason: 'the per-provider retry row schema field (row-level opt-in)' },
]

describe('enabled-read sweep (no config-level `enabled` reads in src/)', () => {
  it('walks a sane src/ tree (the scan cannot vacuously pass)', () => {
    expect(sourceFiles.length).toBeGreaterThan(10)
    const relatives = sourceFiles.map((path) => path.slice(srcRoot.length + 1).split('\\').join('/'))
    expect(relatives).toContain('config.ts')
    expect(relatives).toContain('virtual-adapter.ts')
    expect(relatives).toContain('client/locales.ts')
  })

  it('the removed config-level `config.enabled` read appears nowhere in src/', () => {
    const offenders = hits.filter((hit) => /config\.enabled/.test(hit.text))
    expect(offenders, `config.enabled read(s) found:\n${offenders.map(fmt).join('\n')}`).toEqual([])
  })

  it('the FallbacksConfig contract files carry no `enabled` key (interface + defaultFallbacksConfig in config.ts)', () => {
    const offenders = hits.filter((hit) => hit.file === 'config.ts')
    expect(offenders, `enabled token(s) in config.ts:\n${offenders.map(fmt).join('\n')}`).toEqual([])
  })

  it('every remaining `enabled` occurrence is exactly the allowlisted legal set', () => {
    const files = new Set([...hits.map((hit) => hit.file), ...ALLOWED_ENABLED_HITS.map((entry) => entry.file)])
    for (const file of files) {
      const fileHits = hits.filter((hit) => hit.file === file)
      const entries = ALLOWED_ENABLED_HITS.filter((entry) => entry.file === file)
      // Each allowlisted family must match reality exactly — a reintroduced
      // read pushes the count up, removing a legal site pulls it down.
      for (const entry of entries) {
        const matched = fileHits.filter((hit) => entry.pattern.test(hit.text))
        expect(
          matched.length,
          `${file}: expected ${entry.count} line(s) matching ${entry.pattern} (${entry.reason}), found ${matched.length}:\n${matched.map(fmt).join('\n')}`,
        ).toBe(entry.count)
      }
      // No unaccounted occurrence: every hit must match at least one entry.
      const unaccounted = fileHits.filter((hit) => !entries.some((entry) => entry.pattern.test(hit.text)))
      expect(
        unaccounted,
        `unallowlisted enabled occurrence(s) in src/${file} (no allowlist entry covers them):\n${unaccounted.map(fmt).join('\n')}`,
      ).toEqual([])
    }
  })
})
