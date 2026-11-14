/**
 * Migrate the live profile patch from the legacy fallbacks authoring surface to
 * model configurations.
 *
 * The card no longer edits 默认降级链 / 分时槽 / 子代理角色 / 高级选项, so anything the
 * user still relies on has to be expressed as a model row:
 *
 *   - deepseek自动降级链 -> model `deepseek-auto` (expose: true)
 *   - gpt自动降级链      -> model `gpt-auto` (expose: true, the intermediate
 *                          hops become extraRoutes, the three luna repeats
 *                          become a ruinique retry row)
 *   - the plain official  -> model `official-flash` (fallback: none)
 *
 * The edit is textual: the YAML keeps its comments, personas and formatting.
 * Only the `namedChains` block is dropped (models own the picker now) and the
 * `models` / `providers` blocks are rewritten.
 *
 * Usage: node scripts/migrate-profile-models.mjs [--dry]
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const PROFILE = 'C:/Users/18918/.dsh/profiles/desktop/cordis.patch.yml'
const DRY = process.argv.includes('--dry')

const OFFICIAL = 'deepseek-official/deepseek-flash'
const FLEX = 'deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017'

const CODES = ['AUTH', 'QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR']
const MARKERS = ['DSML', 'antml:', 'function_calls', 'tool_calls', 'tool_use', 'invoke', 'parameter', 'antml_function_calls']

const MODELS = [
  {
    id: 'deepseek-auto',
    name: 'DeepSeek 自动降级链',
    provider: 'deepinfra-flex',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    windows: [],
    fallback: 'official',
    officialModel: OFFICIAL,
    extraRoutes: [],
    expose: true,
    rules: { codes: CODES, regex: ['Upstream rejected the request'], structural: true, markers: MARKERS },
  },
  {
    id: 'gpt-auto',
    name: 'GPT 自动降级链',
    provider: 'ruinique',
    model: 'gpt-6-luna',
    windows: [],
    fallback: 'none',
    officialModel: OFFICIAL,
    extraRoutes: ['ruinique/gpt-6.1-sol', FLEX],
    expose: true,
    rules: { codes: CODES, regex: [], structural: true, markers: MARKERS },
  },
  {
    id: 'official-flash',
    name: 'DeepSeek 官方 Flash',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    windows: [],
    fallback: 'none',
    officialModel: OFFICIAL,
    extraRoutes: [],
    expose: false,
    rules: { codes: CODES, regex: [], structural: true, markers: MARKERS },
  },
]

const api = await import(`file:///${REPO.replaceAll('\\', '/')}/dist/index.js`)
const yaml = await import('yaml')

const before = readFileSync(PROFILE, 'utf8')
const parsed = yaml.parse(before)
const entry = parsed.find(item => item?.id === 'llm-router')
if (entry === undefined) throw new Error('no llm-router entry in the profile patch')
const legacyChains = entry.config?.namedChains ?? []

/** Render the model rows as YAML lines indented under `models:`. */
function renderModels() {
  return yaml
    .stringify(MODELS, { indent: 2, lineWidth: 0, aliasDuplicateObjects: false })
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => `      ${line}`)
}

/**
 * Locate the block that starts at `key:` (indented `indent` spaces) and return
 * its line range: the key line plus every following line indented deeper.
 */
function blockRange(lines, key, indent, from) {
  const head = `${' '.repeat(indent)}${key}:`
  const start = lines.findIndex((line, index) => index >= from && line === head)
  if (start < 0) return undefined
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() === '') {
      end += 1
      continue
    }
    if (line.length - line.trimStart().length <= indent) break
    end += 1
  }
  return { start, end }
}

const lines = before.split('\n')

// Everything below is anchored on the router entry: the profile also carries a
// `providers:` list inside the pi-ai block, which must stay untouched.
const routerAt = lines.findIndex(line => line.trim() === '- id: llm-router')
if (routerAt < 0) throw new Error('no `- id: llm-router` entry in the profile patch')

// 1. Drop the legacy picker chains: `models[].expose` compiles them now.
const named = blockRange(lines, 'namedChains', 4, routerAt)
if (named !== undefined) lines.splice(named.start, named.end - named.start)

// 2. Rewrite the models block.
const models = blockRange(lines, 'models', 4, routerAt)
if (models === undefined) throw new Error('the models block was not found — refusing to write a half-migrated file')
lines.splice(models.start, models.end - models.start, '    models:', ...renderModels())

// 3. Give ruinique the retry budget the legacy chain expressed by repeating
//    `ruinique/gpt-6-luna` three times: the same intent, as a per-provider row.
const providers = blockRange(lines, 'providers', 4, routerAt)
if (providers === undefined) throw new Error('the providers block was not found')
lines.splice(
  providers.end,
  0,
  '      - provider: ruinique',
  '        enabled: true',
  '        maxRetries: 3',
  '        windowMs: 300000',
  '        initialDelayMs: 800',
  '        maxDelayMs: 15000',
  '        jitterRatio: 0.1',
)

const text = lines.join('\n')

// 4. Prove the result still parses, validates and compiles before writing.
const after = yaml.parse(text)
const next = after.find(item => item?.id === 'llm-router')
if (next === undefined) throw new Error('llm-router entry vanished during the rewrite')
const warnings = []
const logger = { warn: message => warnings.push(String(message)), info: () => {}, debug: () => {} }
api.validateFallbacksConfig(api.Config(next.config).get(), logger)
const normalized = api.Config(next.config).get()
const compiled = api.withCompiledRouter(normalized)

if (!DRY) {
  copyFileSync(PROFILE, `${PROFILE}.bak-models`)
  writeFileSync(PROFILE, text, 'utf8')
} else {
  mkdirSync(resolve(REPO, '.build'), { recursive: true })
  writeFileSync(resolve(REPO, '.build/patch-preview.yml'), text, 'utf8')
}

console.log(
  JSON.stringify(
    {
      models: normalized.models.length,
      providers: normalized.providers.map(row => `${row.provider} (maxRetries=${row.maxRetries})`),
      namedChains: compiled.namedChains.map(chain => `${chain.id} <- ${chain.chain.join(' -> ')}`),
      rootChain: compiled.rootChain,
      timeSlots: compiled.timeSlots.length,
      legacyNamedChainsRemoved: legacyChains.length,
      warnings,
    },
    null,
    2,
  ),
)
console.log(DRY ? 'DRY RUN — nothing written (preview: .build/patch-preview.yml)' : `written: ${PROFILE}`)
