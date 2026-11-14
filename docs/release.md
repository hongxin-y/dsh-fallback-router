# Release Guide

How `dsh-llm-router` is versioned and released.

## Release model

Releases are PR-driven, in two steps:

1. **Release prep** (manual trigger: Actions → Release prep → Run workflow) opens a reviewable `release vX.Y.Z` PR — version bump, English changelog section, fragment archive.
2. **Merging that PR** is what releases: the `Release` workflow validates, builds, tags `vX.Y.Z`, and creates the GitHub Release.

| Workflow | File | Trigger |
|---|---|---|
| CI | `.github/workflows/ci.yml` | PR / push to `main` / manual |
| Release prep | `.github/workflows/release-prep.yml` | manual |
| Release | `.github/workflows/release.yml` | merging a PR titled `release v*` |

## npm publishing is off

The registry name `dsh-llm-router` belongs to an unrelated project, so this package is distributed **from the GitHub source only** (`dsh plugin add github:hongxin-y/dsh-llm-router`). The publish step in `release.yml` is gated behind the repository variable `NPM_PUBLISH` and is skipped by default; tags and GitHub Releases are still created.

To publish under npm later: rename the package (e.g. a scoped name such as `@hongxin-y/dsh-llm-router`), configure a Trusted Publisher for that name in the npm package settings, then set `NPM_PUBLISH=true`. Publishing is tokenless — the workflow exchanges the GitHub OIDC id-token for registry authentication and signs the build with `--provenance`; no `NPM_TOKEN` / `NODE_AUTH_TOKEN` secret is declared anywhere.

## Release SOP

### 1. Write a changelog fragment

Add `.changes/unreleased/<slug>.md`. One or more English bullet lines, rendered verbatim; an optional frontmatter `category:` groups the bullets under a `### <category>` heading (default `Changed`):

```md
---
category: Fixed
---

- A switch that the host froze at step preparation now rides the dispatch head instead of failing the turn.
```

### 2. Trigger Release prep

Actions → **Release prep** → Run workflow, choosing either an explicit version (`0.1.1`) or `--patch`.

### 3. Review the release PR

Check that the changelog section reads correctly and that the version matches the change: a fix is a patch, a new surface is a minor, a breaking configuration change is a major.

### 4. Merge → tag + GitHub Release

Merging the PR runs `Release`: it cross-checks the version against the PR title, runs `pnpm release:validate`, builds, then creates and pushes the `vX.Y.Z` tag and the GitHub Release.

## Changelog fragment format

- File: `.changes/unreleased/*.md` (`README.md` and `.gitkeep` are skipped).
- Optional frontmatter: `category: Added | Changed | Fixed | Removed`.
- Body: one or more `- ` bullet lines, English, imperative or past tense, no marketing.

## Release checklist

- [ ] CI green on `main` (see [testing-status.md](testing-status.md) for the currently known-failing specs).
- [ ] Changelog fragment present and readable.
- [ ] `pnpm release:validate` passes locally.
- [ ] Version matches the change.
- [ ] README / docs updated for anything user-visible.

## Rollback / re-run

- A failed `Release` run can be re-run from the Actions page once the cause is fixed; the tag step is idempotent (it skips an existing tag).
- To withdraw a release, delete the GitHub Release and the tag, then re-run prep with a new version — published versions are never reused.

## Related files

- `.changes/` — fragments and their archive.
- `scripts/prepare-release.ts` — version resolution, changelog assembly, fragment archive.
- `scripts/validate-release-version.ts` — release-time version checks.
- `CHANGELOG.md` — assembled changelog.
