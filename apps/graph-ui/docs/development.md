# Graph Explorer: notes for contributors

The app's README is what users read on the app's page, so contributor notes
live here.

## Layout

- App id `rocketride.graph`, development port 3102. How apps are built,
  registered and served in this repository is in
  `docs/development/apps/index.md`.
- The code under `src/graph`, `src/cypher` and `src/layout` is plain
  TypeScript with no browser or shell dependency, so it runs under `node:test`.
  The shared Explorer library (`apps/shared/src/explorer`) provides discovery,
  the tool session, history and the statement runner.
- The app imports that library as `shared/*` (tsconfig paths), so its manifest
  declares `"include": ["apps/shared"]` for the App Builder and
  `rocketride app deploy`, which pack only the app folder and its include roots.
- The pipeline templates in `templates/` are not part of the build: users get
  them from the repository (the README links them).

## Mounts and the env seam

- Three mounts: the full app (`app:`, `GraphApp.tsx`) and, as a dev tool, the
  sidebar CONTROLLER (`GraphDevToolSidebar.tsx`) and each document FRAME
  (`GraphDevToolFrame.tsx`). Views never call `useShellConnection`, `usePrefs`
  or the adapter's stores: they read the GraphEnv (`src/env.ts`). The full app
  and the controller use the LOCAL env (`src/localEnv.ts`) over their own
  stores and the realm's bus-backed client; a frame uses the REMOTE env built
  by `src/devtool/frame.ts`, which holds no client.
- `src/devtool/protocol.ts` is the contract: the `graph.*` ops (each answers a
  Reply and carries a deadline), the retained state topics (each under 64 KiB;
  rows and history lists travel as op results) and the `active` event.
  `src/devtool/controller.ts` serves it (it re-checks the write gate and counts
  writes); `src/devtool/wiring.ts` is the only module that imports the shell's
  protocol factories. Both build on `shared/explorer/devtool` (see
  `docs/development/apps/explorer-library.md`).

## Tests

- `./builder graph-ui:test` type-checks `src` and `tests`
  (`tsconfig.test.json`), then runs every `*.test.ts(x)` in `tests/`. It fails
  if `tests/` is missing or holds no test file, or if a suite named in
  `REQUIRED_TESTS` (`scripts/tasks.js`) is missing. Test files not in that list
  run as well; the list only guards suites that must not disappear.
- No React renderer runs under `node:test`. Logic lives in pure modules with
  unit tests, and the React-side rules that decide whether the UI stays in step
  with its state are pinned by reading the source (`tests/graph.wiring.test.ts`).
- The dev-tool suites (`tests/devtool.*.test.ts`) run the controller and frames
  over the shell's real bus peer, op lane and channel, with every payload
  carried as JSON as VS Code does (`tests/support/devtool.ts`).
- `tests/fixtures/v1/live/` holds answers captured from the real node tools on
  Neo4j, FalkorDB and Apache AGE; `tests/fixtures/provisional/` is hand-modelled
  and kept for the cases the live set does not cover.

## Build

- `./builder graph-ui:build` bundles the app, registers it and copies it to the
  served directory. Rebuilding an app at the same version needs the engine's
  store reset before the server serves it again.
