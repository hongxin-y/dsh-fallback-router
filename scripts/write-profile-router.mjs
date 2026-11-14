import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

const YAML = await import('file:///D:/deepseek-harness/resources/app.asar/dsh/node_modules/yaml/dist/index.js')
const yaml = YAML.default ?? YAML

const target = 'C:/Users/18918/.dsh/profiles/desktop/cordis.patch.yml'
copyFileSync(target, 'C:/Users/18918/.dsh/profiles/desktop/cordis.patch.yml.bak-router')

const text = readFileSync(target, 'utf8')
const entries = yaml.parse(text)
const log = []
log.push(`entries before: ${entries.length}`)

const legacy = entries.find((entry) => entry.id === 'llm-fallbacks')
if (legacy === undefined) throw new Error('llm-fallbacks entry missing')
if (entries.some((entry) => entry.id === 'llm-router')) throw new Error('llm-router already present')

const config = { ...legacy.config }
config.models = [
  {
    id: 'flex-flash',
    name: 'DeepInfra Flex Flash',
    provider: 'deepinfra-flex',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    windows: [],
    fallback: 'official',
    officialModel: 'deepseek-official/deepseek-flash',
    rules: {
      codes: ['AUTH', 'QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR'],
      regex: ['Upstream rejected the request'],
      structural: true,
      markers: ['DSML', 'antml:', 'function_calls', 'tool_calls', 'tool_use', 'invoke', 'parameter', 'antml_function_calls'],
    },
  },
  {
    id: 'official-flash',
    name: 'DeepSeek 官方 Flash',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    windows: [],
    fallback: 'none',
    officialModel: 'deepseek-official/deepseek-flash',
    rules: { codes: ['AUTH', 'QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR'], regex: [], structural: true, markers: ['DSML'] },
  },
]
config.providers = [
  { provider: 'deepinfra-flex', enabled: true, maxRetries: 3, windowMs: 300000, initialDelayMs: 800, maxDelayMs: 15000, jitterRatio: 0.1 },
]
delete config.timeSlots

const block = ['- id: llm-router', '  name: dsh-llm-router', '  config:', ...yaml.stringify(config, { indent: 2 }).trimEnd().split('\n').map((line) => '    ' + line)]
let next = text.trimEnd() + '\n' + block.join('\n') + '\n'

const disable = (source, id) => {
  const lines = source.split('\n')
  const index = lines.findIndex((line) => line.trim() === `- id: ${id}`)
  if (index < 0) throw new Error(`entry ${id} missing`)
  const nameIndex = lines.findIndex((line, at) => at > index && line.trim().startsWith('name:'))
  lines.splice(nameIndex + 1, 0, '  disabled: true')
  return lines.join('\n')
}
next = disable(next, 'llm-fallbacks')
next = disable(next, 'llm-response-guard')

writeFileSync(target, next, 'utf8')

const check = yaml.parse(readFileSync(target, 'utf8'))
log.push(`entries after: ${check.length}`)
for (const entry of check) log.push(`  ${entry.id} disabled=${entry.disabled === true} models=${entry.config?.models?.length ?? 0}`)
writeFileSync('D:/Repos/dsh-llm-router/.build/patch-edit.txt', log.join('\n'), 'utf8')
