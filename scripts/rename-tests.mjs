import { readFileSync, writeFileSync } from 'node:fs'

const edits = [
  ['tests/config.spec.ts', [['llm-fallbacks:', 'llm-router:']]],
  ['tests/client-slot-registration.spec.ts', [['dsh-llm-fallbacks', 'dsh-llm-router']]],
  ['tests/conversation-switch.spec.tsx', [['dsh-llm-fallbacks', 'dsh-llm-router']]],
  ['tests/command.spec.ts', [["ctx.get('llm-fallbacks')", "ctx.get('llm-router')"]]],
]

for (const [file, pairs] of edits) {
  let text = readFileSync(file, 'utf8')
  const counts = []
  for (const [from, to] of pairs) {
    const n = text.split(from).length - 1
    text = text.split(from).join(to)
    counts.push(`${from} -> ${to} x${n}`)
  }
  writeFileSync(file, text)
  console.log(`${file}: ${counts.join(', ')}`)
}
