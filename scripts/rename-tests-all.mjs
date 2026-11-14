import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'tests'
let files = 0
let hits = 0

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { walk(full); continue }
    if (!/\.(ts|tsx|mts|json)$/.test(entry)) continue
    const text = readFileSync(full, 'utf8')
    if (!text.includes('llm-fallbacks')) continue
    const n = text.split('llm-fallbacks').length - 1
    writeFileSync(full, text.split('llm-fallbacks').join('llm-router'))
    files += 1
    hits += n
    console.log(`${full}: ${n}`)
  }
}

walk(root)
console.log(`renamed ${hits} occurrence(s) in ${files} file(s)`)
