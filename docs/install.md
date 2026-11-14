# Installation Guide

This document explains how to load `dsh-fallback-router` into a dsh profile, verify the installation, and uninstall it.

## Prerequisites

- A working dsh runtime (`$DSH_HOME`, defaults to `~/.dsh`) and the profile you want to install into (e.g. `desktop`, `web`).
- A session restart after installation: the plugin's host half and client half load on the next start.
- Building from source needs **node** (`>= 22`) and **pnpm** (`>= 10`). A GitHub install builds on the target machine (the package's `prepare` script runs `pnpm run build`); nothing needs to be installed by hand.

## 1. GitHub install (the published channel)

```sh
dsh plugin --profile desktop add github:hongxin-y/dsh-fallback-router
# pin a commit so the code that runs cannot change under you:
dsh plugin --profile desktop add github:hongxin-y/dsh-fallback-router#<sha>
```

`dsh plugin` forwards its arguments to the pnpm inside the profile directory (`add`, `remove`, `why` all work) and appends `dsh-fallback-router` to that profile's bundle layer list (`dsh.profile.bundles`). The plugin is **mount-only**: installation = bundle row insert + client inject (`dsh.client.inject`), with **zero modification of the dsh source tree and no patch steps**, so dsh upgrades never require re-patching.

### pnpm ≥ 10 build approval

pnpm ≥ 10 does not run a git dependency's build script (`prepare`) by default, so the first `add` stops with:

```
ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED  Ignored build scripts: dsh-fallback-router.
```

Approve it and re-run. The allow list lives in the profile's `pnpm-workspace.yaml`, so run pnpm's own approval command inside the profile directory:

```sh
cd "$DSH_HOME/profiles/desktop"      # or %USERPROFILE%\.dsh\profiles\desktop
pnpm approve-builds                  # interactive
dsh plugin --profile desktop add github:hongxin-y/dsh-fallback-router
```

Or write the entry by hand (the key name depends on the pnpm version — `allowBuilds` on pnpm 11, `onlyBuiltDependencies` on pnpm 10):

```yaml
allowBuilds:
  dsh-fallback-router@<resolved spec>: true
```

Approval means that package's code may execute on your machine at install time — which is why pinning a commit is recommended.

### Bundle layer order

A dsh profile is an ordered list of bundle layers: `@deepseek-ai/dsh-base` (which contains the llm-retry plugin) → the app layers → `dsh-fallback-router` (appended by `add`).

**`dsh-fallback-router` must sit after llm-retry.** Its `agent/request-error` listener has to compose after llm-retry, so it only steps in once the retry budget is spent; a reversed order would let retryable failures reach this plugin first and preempt llm-retry's backoff. `add` appends to the end of the list, which already satisfies this — no manual edit needed. If you do edit `$DSH_HOME/profiles/<profile>/package.json` by hand, keep `@deepseek-ai/dsh-base` before this plugin.

## 2. Local directory install (development)

```sh
pnpm install                 # or explicit: pnpm build  (prepare self-builds dist/)
dsh plugin --profile desktop add .
```

Same mount-only semantics as above. Use this while iterating on the plugin itself: re-run `add .` (or rebuild and restart) after changing the source.

## 3. Desktop / Web plugin page

The dsh Desktop app and a `dsh web` session expose the same plugin manager:

1. Open the **Plugins** page in the sidebar.
2. Click **Add plugin**.
3. Paste the GitHub repo `hongxin-y/dsh-fallback-router` (or a local directory) and install.

The GUI installs into its own profile — the same profile `dsh plugin --profile … add …` targets — so the GUI path and the CLI path are the same installation. The terminal profile `dsh-tui` has no plugin page; use the CLI.

## 4. Verify the installation

```sh
dsh --profile desktop --dump-config
```

The plugin's layer should appear in the merged configuration tree:

```yaml
# == dsh-fallback-router
- id: llm-router
  name: dsh-fallback-router
  config: {}
```

The layer **before** it includes llm-retry (from `@deepseek-ai/dsh-base`) — layer order is waterfall registration order (see above).

Then restart the session and check the two halves:

- The web settings GUI's Settings → **插件配置** page shows the model-routing card, always available — the skeleton renders even before any `fallbacks` config exists. It is readable, editable and saveable; with nothing configured the behavior is a no-op (see [docs/configuration.md](configuration.md)).
- In a session, type `/fallbacks` to inspect that session's diagnostics (role → chain → recent switches → cooldown).

## 5. Uninstall

```sh
dsh plugin --profile desktop remove dsh-fallback-router
dsh --profile desktop --dump-config     # confirm the llm-router layer is gone
```

Restart the session afterwards. Once uninstalled the plugin no longer participates in any request or error path.

## About the npm package name

The package name is `dsh-fallback-router`, but nothing is published to the npm registry yet: the release workflow's publish step is gated behind the `NPM_PUBLISH` repository variable and is off by default (see [release.md](release.md)). Install from the GitHub source above (or from a local clone), not with `npm install dsh-fallback-router`.
