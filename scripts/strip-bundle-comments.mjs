/**
 * Strips the `//#region` / `//#endregion` markers tsdown leaves in the emitted
 * bundles.
 *
 * `outputOptions.comments: false` removes docblock text, but rolldown still
 * annotates every inlined module with a region marker that carries the SOURCE
 * path of the file it came from. In this repo `.build/` is a junction into the
 * artifact store, so those markers spell out a machine-local path
 * (`../Artifacts/<dir>/.build/host/<module>.js`) that has no meaning for anyone
 * who installs the package. The markers are purely navigational — nothing reads
 * them at runtime — so dropping the lines keeps the bundle lean and free of
 * build-machine paths.
 *
 * Runs after tsdown and the client build, before `scripts/verify-dist.mjs`.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const BUNDLES = ['dist/index.js', 'dist/client/index.js']
const REGION = /^\/\/#(?:end)?region(?: .*)?$\r?\n?/gm

let stripped = 0
for (const file of BUNDLES) {
  const before = readFileSync(file, 'utf8')
  const after = before.replace(REGION, '')
  if (after !== before) {
    writeFileSync(file, after, 'utf8')
    stripped += 1
    console.log(`${file}: region markers stripped (${before.length - after.length} bytes)`)
  }
}
console.log(`strip-bundle-comments: ${stripped}/${BUNDLES.length} bundle(s) rewritten`)
