// Why does the panel show no model profiles? Feed the real profile patch
// through the shipped schema + the settings bridge and print what survives.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const YAML = require('yaml')
const api = await import('file:///D:/Repos/dsh-llm-router/dist/index.js')

const PROFILE = 'C:/Users/18918/.dsh/profiles/desktop/cordis.patch.yml'
const lines = []
const say = (line) => { lines.push(line) }

const doc = YAML.parse(readFileSync(PROFILE, 'utf8'))
const entry = (doc ?? []).find((item) => item?.id === 'llm-router')
say(`entry found: ${entry !== undefined}`)
const raw = entry?.config ?? {}
say(`raw models: ${Array.isArray(raw.models) ? raw.models.length : 'not-an-array'}`)
say(`raw extraRoutes[0]: ${JSON.stringify(raw.models?.[0]?.extraRoutes)}`)

let parsed
try {
  parsed = api.Config(raw).get()
  say('Config(raw).get() OK')
} catch (error) {
  say(`Config(raw).get() THREW: ${String(error?.message ?? error)}`)
}
if (parsed !== undefined) {
  say(`parsed models: ${Array.isArray(parsed.models) ? parsed.models.length : 'not-an-array'}`)
  say(`parsed ids: ${JSON.stringify((parsed.models ?? []).map((m) => m.id))}`)
  say(`parsed extraRoutes[0]: ${JSON.stringify(parsed.models?.[0]?.extraRoutes)}`)
}

const compiled = api.withCompiledRouter(parsed ?? raw)
say(`compiled rootChain: ${JSON.stringify(compiled.rootChain)}`)
say(`compiled slots: ${(compiled.timeSlots ?? []).length}`)
say(`compiled namedChains: ${JSON.stringify((compiled.namedChains ?? []).map((c) => c.id))}`)

writeFileSync('D:/Repos/dsh-llm-router/.build/probe-config.txt', lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
