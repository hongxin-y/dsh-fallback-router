# Testing status

`pnpm test` is **green**: 61 files, 1413 assertions passed, 12 skipped (1425
total). CI runs it without `continue-on-error`, so a regression blocks the
workflow again.

```
Test Files  61 passed (61)
     Tests  1413 passed | 12 skipped (1425)
```

## What changed in 0.1.0

Until 0.1.0 the plugin redirected a failure by **rewriting the request config**
inside the `agent/request` waterfall (`{ provider, model }` swapped before the
call). The harness rejects that now:

```
agent "…": agent/request proposed "ikun-gateway/…" after step preparation fixed
"FallbacksChain-model-2/Chain"; use agent.model.select() before step preparation
```

`prepareRequest()` freezes the step's selection and hard-fails any proposal
that changes `provider`, `model`, or `reasoningEffort`. The same freeze makes a
retry re-use the same selection, so a switch can no longer ride the retry.

0.1.0 therefore switches at **dispatch** instead:

1. `agent/request-error` decides as before and commits a pending switch;
2. the next `agent/request` **pins** the hop for that session
   (`pinForcedRoute` in `src/virtual-adapter.ts`) and returns the seed untouched;
3. the virtual adapter reads `options.sessionId` (the loop puts `sessionId` on
   every request) and dispatches the pinned route, falling back to the chain
   head when nothing is pinned.

A session picked straight at a concrete provider (not through `FallbacksChain`)
can no longer be switched at all — the host froze its selection. `decide()`
logs `concrete route … cannot be switched at dispatch` and returns `null`; the
provider-level retry policy still applies.

## The 12 skips

- 10 × `tests/repair-session-logs.spec.ts` — POSIX-only cases (`symlink` needs
  a privilege Windows does not grant, `chmod 000` is a no-op for the owner).
  They still run on Linux CI.
- 2 × `tests/session-log-publish.spec.ts` — the catalog-gated integration case
  needs a released session-format catalog (`--catalog`,
  `DSH_SESSION_FORMAT_CATALOG`, a `dsh` on `PATH`, or an `npx` cache). The unit
  tests above it always run.

## How the stale specs were migrated

Every failure encoded the old "the request config is rewritten" contract. The
fixes were fixture/assertion changes only — no production behaviour was
weakened to make a spec pass:

- **Anchor on the served route.** A router-served session with no pin is served
  by the effective chain head, so a spec that models "`mock/gpt-4o` fails, walk
  to the next entry" must put `mock/gpt-4o` first in the chain, or declare the
  current hop with the harness `serving` option (a sticky pin).
- **One-shot pins expire.** Role injection pins exactly one request; the next
  request boundary returns the session to the chain head
  (`beginRequest` drops the `once` pin). Specs that assert a post-injection
  failure now model the route the loop actually re-dispatches.
- **Assert through the pin.** The switch is observable via
  `forcedRouteOf(agent.session.id)`, not through the request config — the
  request stays on the virtual pair.
- **`reasoningEffort` is inherited.** A pinned hop replaces `provider`/`model`
  only, so assertions use `toMatchObject({ provider, model })` instead of
  `toEqual`.
- **Manual concrete picks end the virtual session.** `selectConcrete()` in the
  harness models a picker change (clear the pin, log the concrete pair); after
  it a failure passes through instead of switching.

## Windows-only noise, now removed

- `tests/repair-session-logs.spec.ts` spawned `node_modules/.bin/tsx` (a `.cmd`
  shim on Windows); it now spawns `node node_modules/tsx/dist/cli.mjs`.
- Path assertions go through a `fx()`/`toPosix()` helper instead of hardcoding
  `/`.
