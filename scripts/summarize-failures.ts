import { readFileSync, writeFileSync } from 'node:fs'

const report = JSON.parse(readFileSync(process.argv[2] ?? '.build/vitest.json', 'utf8'))
const lines: string[] = []
for (const file of report.testResults ?? []) {
  const failed = (file.assertionResults ?? []).filter((a) => a.status === 'failed')
  if (failed.length === 0) continue
  lines.push(`\n=== ${file.name.split(/[\\/]/).pop()} (${String(failed.length)}) ===`)
  for (const test of failed) {
    const first = (test.failureMessages ?? []).join(' ').replace(/\s+/g, ' ').slice(0, 180)
    lines.push(`- ${test.fullName} :: ${first}`)
  }
}
writeFileSync('.build/failures.txt', lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
