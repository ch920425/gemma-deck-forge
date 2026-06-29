# Technical Review Report

## Executive Summary

Gemma Deck Forge is a compact Vite/React demo application with a local API plugin, parallel context/deck-generation lanes, persistent feedback memory, and a custom Figma Desktop Bridge WebSocket server. The codebase is small and intentionally demo-focused: most core behavior lives in `src/App.tsx`, `src/server/*`, and `src/shared/figma.ts`.

The strongest parts of the implementation are the deterministic 10-slide fallback path, broad unit coverage for deck normalization and Figma bridge transport, and a clean Vite plugin boundary for local-only API routes. The main risk is not raw complexity; it is optimistic UX around asynchronous work. Several paths can hang, fail silently, or show progress that is not tied to real provider/bridge completion. Those issues directly affect the product goal of a snappy, trustworthy demo.

Highest-priority recommendations:

1. Add provider/request deadlines and better SSE failure handling so the UI never gets stuck waiting on one model call or a malformed stream.
2. Replace optimistic Figma stage animation with status derived from actual bridge/build events, especially on failed or disconnected bridge runs.
3. Normalize and validate deck payloads at Figma API boundaries before calling `buildFigmaBuildPlan`, because those endpoints currently trust client-supplied deck shape.
4. Split the monolithic client and generated Figma script builder into smaller tested modules before adding the dynamic-demo contract from the docs.
5. Add focused performance tests around context lane deadlines, Figma action-rate math, total bridge execution time, and UI responsiveness.

Validation was limited because `node_modules` is absent and the requested artifact-only constraint made installing dependencies inappropriate. `npm audit --json` passed with zero reported vulnerabilities from the lockfile. `npm run lint` and `npm test` were attempted but failed because local binaries are missing.

## Current Architecture

The app is a local-first demo stack:

- Frontend: React 18 entrypoint in `src/main.tsx`, main application state/UI in `src/App.tsx`, styling in `src/styles.css`.
- API surface: Vite plugin in `src/server/apiPlugin.ts` registers `/api/*` endpoints during dev/preview runtime.
- Model provider: `src/server/cerebras.ts` calls Cerebras chat completions and parses JSON outputs.
- Context retrieval: `src/server/contextSwarm.ts` runs four lanes in parallel: Supabase `gbrain`, local Obsidian `rg`, Gemma organizer, and a fallback brief.
- Deck generation: `src/server/deck.ts` runs five agent prompts, two outline-design agents, a timed eval/fix loop, synthesis, normalization, and Figma spec generation.
- Figma handoff/build: `src/shared/figma.ts` builds both a JSON handoff spec and a large executable Figma script; `src/server/figmaBridge.ts` exposes a local WebSocket bridge server.
- Persistence: `src/server/feedbackStore.ts` stores local feedback as bounded JSONL under `GEMMA_DECK_DATA_DIR` or `./data`.
- Tests: Vitest unit/integration coverage in `tests/*.test.ts`, Playwright e2e in `tests/e2e/app.spec.ts`, and opt-in live Cerebras tests gated by configured keys.

The docs describe a more ambitious dynamic-demo architecture than the current route surface implements. `docs/dynamic-agentic-slide-demo-tech-spec.md` calls for `POST /api/dynamic-demo/plan`, `POST /api/dynamic-demo/stream`, and `POST /api/figma/dynamic-build-plan`, while the current API exposes `/api/context/swarm/stream`, `/api/generate/stream`, `/api/polish/stream`, `/api/figma/build-plan`, and `/api/figma/build`.

## Validation Performed

| Command | Result | Notes |
| --- | --- | --- |
| `git status --short --branch` | Passed | Repo was clean on `main...origin/main` before writing this report. |
| `rg --files` | Passed | Inventory confirmed source, docs, config, and tests only; no repo-local `AGENTS.md`. |
| `npm --version` | Passed | `10.9.8`. |
| `node --version` | Passed | `v22.22.3`. |
| `test -d node_modules && echo present || echo missing` | Passed | `node_modules` is missing. |
| `npm run lint` | Failed, dependency-gated | `tsc: command not found` because dependencies are not installed. |
| `npm test` | Failed, dependency-gated | `vitest: command not found` because dependencies are not installed. |
| `npm audit --json` | Passed | Lockfile audit reported zero vulnerabilities. |
| Static source/doc/test inspection | Passed | Reviewed metadata, docs, core source, and tests with line-numbered reads and targeted `rg` scans. |

Skipped:

- `npm install` / `npm ci`: skipped to honor the instruction to create exactly one artifact and avoid introducing `node_modules`.
- `npm run build`, `npm run test:coverage`, `npm run test:e2e`: skipped because dependencies are absent.
- Live Cerebras, Supabase, Obsidian, or Figma bridge runs: skipped because the audit should not require credentials or external services.

## Findings By Severity

### High: Cerebras requests have no deadline, so one slow provider call can freeze generation

Evidence:

- `callCerebrasText` awaits `fetch(endpoint, ...)` without `AbortController` or a timeout in `src/server/cerebras.ts:40-56`.
- `generateDeck` waits for all five first-pass agent calls with `Promise.all` in `src/server/deck.ts:16-50`.
- `runOutlineDesignSwarm` waits for two more outline agents with `Promise.all` in `src/server/deck.ts:142-161`.
- `synthesizeDeck` awaits another provider call before fallback can happen in `src/server/deck.ts:221-247`.

Impact:

- A single hung network request can block the entire `/api/generate/stream` response.
- The UI remains in `busy` mode and the demo no longer feels snappy.
- Fallbacks only help after thrown errors; they do not help when a request never resolves.

Recommended fix:

- Add a small provider wrapper with per-call deadlines, e.g. `callCerebrasText(..., { timeoutMs })`.
- Use `AbortController` and classify timeout errors as fallback-eligible.
- Consider `Promise.allSettled` plus per-agent budgets so one lane can fail independently while other lanes keep streaming.

Verification:

- Unit-test `callCerebrasText` with a fake `fetch` that never resolves and assert it rejects within the configured timeout.
- Integration-test `generateDeck` with one stuck agent and assert `agent_error` plus `deck_complete` still emit within a bounded wall-clock budget.

### High: SSE and generation UI can fail silently or leave controls stuck

Evidence:

- `generate()` sets `busy` true, awaits `postSse`, then sets `busy` false without `try/finally` in `src/App.tsx:121-136`.
- `polish()` has the same pattern in `src/App.tsx:138-147`.
- `postSse` does not check `response.ok` and only throws when `response.body` is missing in `src/App.tsx:651-659`.
- `postSse` directly parses `JSON.parse(data)` without guarding malformed SSE payloads in `src/App.tsx:670-674`.

Impact:

- A 500 JSON response from the API can be consumed as a stream with no events and no visible error.
- A malformed SSE event can throw and leave `busy` true.
- The user may see no deck, no error, and disabled primary actions.

Recommended fix:

- Wrap `generate()` and `polish()` in `try/catch/finally`.
- Add a visible `errorMessage` state for stream failures.
- In `postSse`, reject on non-2xx responses and include a short response preview.
- Track whether a terminal `done` or `deck_complete` event was received; otherwise surface an incomplete-stream error.

Verification:

- Component/e2e test: mock `/api/generate/stream` to return HTTP 500 JSON and assert the Generate button re-enables with an error.
- Unit-test `postSse` against malformed `data:` JSON and missing terminal events.

### High: Figma progress UI is optimistic and can show completion despite bridge failure

Evidence:

- `prepareFigmaBuild()` calls `runFigmaStageAnimation()` before the real build request completes in `src/App.tsx:170-205`.
- `runFigmaStageAnimation()` marks phase cards as done/running on fixed timers, independent of bridge responses, in `src/App.tsx:216-230`.
- On build failure, `prepareFigmaBuild()` only sets `figmaResult`; it does not cancel or reset the optimistic stage animation in `src/App.tsx:199-204`.

Impact:

- The UI can show many stage cards as done even when `/api/figma/build` returns a disconnected-bridge error.
- This undermines the core demo promise: visible Figma progress should correspond to real actions.

Recommended fix:

- Replace timer-only status with build events or a local state machine keyed by actual bridge milestones.
- If the bridge is disconnected, show the generated script/build plan but leave stages queued or mark the build as blocked.
- If fake/progressive animation is intentionally retained for demo pacing, label it as planned timeline until the bridge confirms execution.

Verification:

- Playwright test: disconnect/no bridge, click Build in Figma, assert stage cards do not all become `done`.
- Unit-test reducer/state machine transitions for planned, running, succeeded, failed, and cancelled statuses.

### High: Figma build endpoints trust client deck shape and can 500 on malformed payloads

Evidence:

- `/api/figma/build-plan` directly passes `body.deck` to `buildFigmaBuildPlan` in `src/server/apiPlugin.ts:158-165`.
- `/api/figma/build` does the same before bridge execution in `src/server/apiPlugin.ts:168-178`.
- `buildFigmaBuildPlan` calls `ensureTenSlides`, which assumes arrays and calls `slide.bullets.map` and `slide.evidence.map` in `src/shared/figma.ts:527-535`.
- The shallow `isDeckSpec` helper only checks `title`, `thesis`, `slides`, and slide `bullets` in `src/shared/schema.ts:174-182`, and it is not used at the Figma build endpoints.

Impact:

- The app UI usually sends normalized decks, but these local endpoints can crash with external or stale client payloads.
- A bad build payload can become a generic 500 instead of a recoverable validation error.

Recommended fix:

- Add `normalizeDeck` or a dedicated `normalizeFigmaDeckInput` at both Figma build endpoints.
- Return 400 with a clear `invalid_deck` error when required shape cannot be normalized.
- Avoid direct `.map` on untrusted nested fields in `ensureTenSlides`.

Verification:

- API unit/integration test: POST `{ deck: { title: "x", thesis: "y", slides: [{ bullets: "bad" }] } }` to build-plan and assert a structured 400 or normalized fallback, not a 500.

### Medium: Context swarm waits for all lanes and has the same hung-provider risk

Evidence:

- `runContextSwarm` starts four lanes but awaits `Promise.all(tasks)` before emitting `context_complete` in `src/server/contextSwarm.ts:36-52`.
- Gbrain has a configurable timeout via `GEMMA_CONTEXT_GBRAIN_TIMEOUT_MS` in `src/server/contextSwarm.ts:156-160`.
- Gemma organizer uses `callCerebrasJson` with no deadline in `src/server/contextSwarm.ts:178-228`.

Impact:

- One hung Gemma organizer call can delay the entire context completion event even if the local brief and Obsidian lanes are already useful.
- The UI can remain in `"swarm running"` longer than necessary.

Recommended fix:

- Add per-lane deadlines and emit partial `context_complete` when enough context is ready.
- Prefer `Promise.allSettled` or a race against a global swarm deadline.
- Keep slow-lane late results optional; do not block deck generation on them.

Verification:

- Unit-test `runContextSwarm` with a never-resolving Gemma lane and assert the brief/Obsidian lanes complete and a terminal context event emits.

### Medium: Default local context path is stale for this machine

Evidence:

- `getObsidianVaultPath()` defaults to `/Users/chaseungjae/Vaults/obsidian` in `src/server/contextSwarm.ts:277-279`.
- `.env.example` also sets `SUPABASE_WORKDIR=/Users/chaseungjae` in `.env.example:3`.

Impact:

- On this host, the known canonical Obsidian vault is under `/Users/jonathancha/ch920425/obsidian`; the default path will miss local context unless the environment is explicitly corrected.
- Missing retrieval context pushes the demo toward generic fallback content.

Recommended fix:

- Remove machine-specific defaults from source and `.env.example`.
- Use empty examples plus README instructions, or derive defaults from configured env only.
- Surface missing path as a setup state in the UI instead of silently falling back.

Verification:

- Unit-test missing `OBSIDIAN_VAULT_PATH` returns a setup-needed lane result.
- Manual smoke: unset the env var and confirm the UI explains how to configure it.

### Medium: Feedback persistence rewrites the whole JSONL file and can lose concurrent saves

Evidence:

- `saveFeedback` reads all entries, appends one, slices to 50, then rewrites `feedback.jsonl` in `src/server/feedbackStore.ts:13-27`.

Impact:

- Two rapid feedback saves can interleave and drop one entry.
- A process interruption during `writeFile` can leave the feedback file partially written.

Recommended fix:

- Serialize writes through a module-local queue and write to a temp file followed by atomic rename.
- Alternatively append-only writes plus compaction on read/startup.

Verification:

- Unit-test parallel `Promise.all([...saveFeedback])` calls and assert all expected entries are retained.
- Test corrupted JSONL handling if the product should recover rather than hard-fail.

### Medium: Current Figma action-rate metric can overstate total user-perceived speed

Evidence:

- Figma script starts `actionStartedAt` immediately before the phase-chip loop in `src/shared/figma.ts:481-483`.
- It reports `actionsPerSecond` using only the chip-update loop in `src/shared/figma.ts:495-499`.
- Rendering frames and exporting reference thumbnails happen before `actionStartedAt`, including `referenceThumb` export calls in `src/shared/figma.ts:242-275` and slide render loop in `src/shared/figma.ts:458-479`.

Impact:

- The reported action rate may exclude expensive setup/rendering work that the user experiences as part of the build.
- The docs require a Figma stage that targets `10-14s` and `>=5 actions/sec`; using action-loop-only timing can make a slow setup look compliant.

Recommended fix:

- Report both `visibleActionsPerSecond` and `totalActionsPerSecond`.
- Treat total elapsed and action-loop elapsed as separate demo metrics in the UI.
- Cache reference thumbnail exports or use fewer thumbnail exports during live runs.

Verification:

- Add tests around generated script constants and expected theoretical action duration.
- In live bridge QA, record total elapsed from clicking Build to result, not only bridge-returned action loop metrics.

### Low: Generated Figma script and fallback deck data are too large and tightly coupled

Evidence:

- `src/shared/figma.ts` contains a large template string with renderer definitions, palette extraction, Figma node creation, timing, and result reporting in one function starting at `src/shared/figma.ts:77`.
- Fallback/design beat content is also encoded in `src/shared/figma.ts:554-635` and `src/server/deck.ts:398-500`.

Impact:

- Small copy or layout changes require editing a dense string-literal script that TypeScript cannot typecheck deeply.
- It is hard to review whether generated script behavior still matches schema/docs.

Recommended fix:

- Split script generation into typed sections: payload, palette/reference sampling, primitive helpers, slide renderers, progress loop, metrics.
- Move static slide format/design beat content into one shared catalog.
- Keep snapshot tests for generated script plus unit tests for payload normalization.

Verification:

- Snapshot the generated Figma script for a stable fixture deck.
- Add tests that every `formatId` maps to exactly one renderer and every renderer emits a distinct scaffold marker.

### Low: Configuration/docs are slightly inconsistent

Evidence:

- README says `CEREBRAS_BACKUP_API_KEY` is required or expected in `README.md:28-33`.
- `.env.example` omits `CEREBRAS_BACKUP_API_KEY` and includes machine-specific defaults in `.env.example:1-5`.
- Docs describe dynamic-demo endpoints not implemented in `src/server/apiPlugin.ts:41-197`.

Impact:

- New contributors can follow the docs and still miss a backup-key variable or expect endpoints that do not exist.

Recommended fix:

- Update `.env.example` to include all supported variables with neutral placeholders.
- Mark dynamic-demo docs as planned/future, or add endpoint stubs once implementation starts.

Verification:

- Documentation check: every env var referenced in README exists in `.env.example`.
- API route test: docs-listed endpoints either exist or are explicitly documented as planned.

## Performance/Latency Opportunities

1. Provider deadlines and fallbacks:
   - Apply per-call deadlines to all Cerebras calls.
   - Recommended budgets: short brainstorm 5-8s, agent lane 8-12s, synthesis 12-18s, total generation budget visible in UI.
   - Verification: fake hung provider tests plus Playwright stopwatch assertions around fallback generation.

2. Use partial progress instead of all-or-nothing completion:
   - Context swarm should emit a usable digest once brief plus any one retrieval lane completes.
   - Generation can continue with partial agent findings if one specialist lane misses its budget.
   - Verification: tests asserting `deck_complete` still emits when one lane times out.

3. Cache or reduce Figma reference thumbnail exports:
   - `referenceThumb` exports reference frames repeatedly during a single script run.
   - Cache image hashes by reference frame ID inside the generated script, or only export a small stable subset before rendering slides.
   - Verification: instrument live bridge result with `thumbnailExportCount` and total render time.

4. Make Figma progress reflect real work:
   - If the bridge supports incremental messages, stream phase completions from the generated script.
   - If not, treat UI stages as planned until final bridge success.
   - Verification: disconnected bridge e2e and connected bridge smoke.

5. Bound local Obsidian search more tightly:
   - Current `rg` scans the whole vault path with token alternation in `src/server/contextSwarm.ts:74-79`.
   - Add `--glob '*.md'`, exclude `.obsidian`, generated caches, and binary-heavy folders.
   - Verification: fixture test for command args plus manual timing on a large vault.

6. Avoid rendering huge artifact text eagerly:
   - `deckJson` stringifies the Figma spec on every deck change and the artifact panel renders full JSON/script in a wrapping `<pre>` in `src/App.tsx:60` and `src/App.tsx:632-645`.
   - This is acceptable for 10 slides today, but it will become sluggish if dynamic plans and full scripts grow.
   - Verification: React profiler or Playwright trace after replacing the panel with collapsed tabs/lazy rendering.

## Refactor/Cleanup Opportunities

1. Split `src/App.tsx` into focused hooks and panels.
   - Suggested units: `useSseStream`, `useContextSwarm`, `useDeckGeneration`, `useFigmaBuild`, `AgentBoard`, `ContextSwarmPanel`, `DeckGrid`, `FigmaBuildPanel`, `FeedbackPanel`, `ArtifactPanel`.
   - Keep a reducer for async state transitions so busy/error/stage states cannot drift.
   - Verification: component tests for reducer transitions and Playwright coverage for the main flow.

2. Add typed API request/response validation.
   - The server currently casts `await readJson(req)` directly into request types in `src/server/apiPlugin.ts:53-190`.
   - Add narrow parsing/validation helpers per route, returning 400 for bad payloads.
   - Verification: route-level tests for missing body, malformed deck, large body, invalid feedback rating, and invalid context limit.

3. Centralize product constants.
   - Constants are repeated across docs, prompts, tests, schema, Figma script, and UI: 10 slides, 50 actions, 5 actions/sec, 6000ms outline window, 10000ms Figma stage, 180ms action delay.
   - Create a `demoContract.ts` shared module and import from server/shared code.
   - Verification: tests assert docs-facing constants and implementation constants are aligned where practical.

4. Normalize Figma script generation behind a typed plan.
   - Current `FigmaBuildPlan` is mostly script plus stage cards.
   - Introduce a typed mutation/timeline model first, then compile it into executable bridge script.
   - Verification: unit tests for mutation ordering, scaffold diversity, and generated script syntax.

5. Improve JSON parsing from model responses.
   - `parseJsonFromText` handles prefixed/fenced JSON but slices from the first object/array to the end in `src/server/cerebras.ts:103-115`.
   - Trailing prose after valid JSON can still fail parsing.
   - Use a brace-balanced extractor or provider-supported JSON mode if available.
   - Verification: tests for `{"ok":true}\nextra`, arrays with trailing prose, and malformed brace cases.

6. Align docs with current code or add missing dynamic endpoints.
   - Either rename the docs as planned design docs or add stubs for `/api/dynamic-demo/plan`, `/api/dynamic-demo/stream`, and `/api/figma/dynamic-build-plan`.
   - Verification: API route table in README generated from route tests or a lightweight route manifest.

## Regression Risks

1. Tightening timeouts may make high-quality but slow model outputs fall back more often.
   - Mitigation: set per-phase budgets based on actual demo latency measurements and show when fallback was used.

2. Replacing optimistic Figma animation may make disconnected demos feel less lively.
   - Mitigation: distinguish "planned timeline" from "executed timeline" visually instead of removing all progress affordances.

3. Normalizing deck inputs at Figma endpoints can change behavior for existing manually edited deck JSON.
   - Mitigation: preserve accepted fields where valid and add compatibility tests for current generated decks.

4. Splitting `src/shared/figma.ts` can break the executable bridge script even if TypeScript passes.
   - Mitigation: keep generated-script syntax tests and a connected bridge smoke before shipping.

5. Changing Obsidian/Supabase defaults can affect another developer's local setup.
   - Mitigation: prefer explicit env-driven config over hard-coded host paths; document setup clearly.

6. Feedback-store atomic writes can change file ordering or compaction behavior.
   - Mitigation: maintain the "last 50 entries, last 8 memory signals" contract with regression tests.

## Recommended Roadmap

### Quick Wins

1. Add `try/catch/finally` and visible error state around `generate()` and `polish()`.
2. Make `postSse` reject non-2xx responses and malformed events.
3. Add request deadlines to `callCerebrasText`.
4. Add Figma build endpoint deck normalization/validation before `buildFigmaBuildPlan`.
5. Update `.env.example` with neutral placeholders and all supported env vars.

### Medium Refactors

1. Move async UI state into reducers/hooks and split `src/App.tsx` panels.
2. Introduce a typed Figma mutation/timeline plan and compile it to the bridge script.
3. Centralize the demo contract constants and scaffold catalog.
4. Add context-swarm partial completion and per-lane deadlines.
5. Make feedback persistence atomic or serialized.

### Risky / Needs Product Signoff

1. Change the fixed 6-second outline eval clock. It is intentionally part of the demo experience, so reducing it may make UX snappier but weaken the "visible agentic improvement" story.
2. Replace the current fixed 10-format deck normalization with more model-driven slide counts or dynamic scaffolds. The docs and tests currently enforce exactly 10 slides.
3. Change Figma script visual output substantially. Any renderer refactor should be paired with screenshot/bridge validation because the hackathon demo depends on visual polish.
4. Remove optimistic progress entirely. Product may prefer a planned-progress mode for disconnected demo environments, but it should be clearly separated from real execution state.

## Test/Verification Plan

For quick wins:

- `callCerebrasText` timeout tests with fake `fetch`.
- `generateDeck` integration test where one agent times out and the fallback deck still completes.
- `postSse` tests for HTTP 500, malformed JSON, missing body, and missing terminal event.
- Playwright test for failed `/api/generate/stream` showing an error and re-enabled Generate button.
- API tests for malformed Figma build-plan/build deck payloads returning structured errors.

For medium refactors:

- Reducer tests for idle/running/succeeded/failed/cancelled states in generation and Figma build.
- Figma mutation-plan tests:
  - exactly 10 slides
  - 50 visible phase actions
  - at least 8 scaffold families once dynamic scaffolds are implemented
  - ordered writer queue
  - no adjacent duplicate scaffold families when that contract is added
- Context swarm tests with one hung lane and one slow lane.
- Feedback concurrency test with simultaneous saves.
- Snapshot test for generated Figma script syntax and key markers.

Before shipping any implementation:

1. Install dependencies normally in a clean working tree.
2. Run `npm run lint`.
3. Run `npm test`.
4. Run `npm run test:coverage`.
5. Run `npm run build`.
6. Run `npm run test:e2e`.
7. Run `npm audit --json`.
8. If Figma behavior changed, run a live Desktop Bridge smoke with a connected file and verify slide count, total elapsed time, action rate, and screenshot quality.

## Appendix: Evidence

Repository and metadata:

- `package.json:6-15` defines scripts for dev, build, preview, Vitest, coverage, live tests, e2e, and lint.
- `package.json:16-31` uses a small dependency set: React, React DOM, Lucide, Vite, Vitest, Playwright, TypeScript.
- `vite.config.ts:5-29` loads env, registers the API plugin, configures Vite server/preview ports, and configures Vitest coverage.
- `playwright.config.ts:14-19` starts `npm run dev` for e2e tests.
- `.gitignore:1-11` excludes `node_modules`, build/test outputs, env files, data JSONL/tmp files, Supabase temp files, and `.omx`.

Docs/product contract:

- `README.md:35-44` lists expected verification commands.
- `README.md:46` states current verified coverage numbers, but current checkout could not rerun coverage without dependencies.
- `docs/dynamic-agentic-slide-demo-prd.md:90-117` defines timing, visible agentic behavior, and exact 10-slide shape goals.
- `docs/dynamic-agentic-slide-demo-prd.md:150-156` requires serialized Figma writes.
- `docs/dynamic-agentic-slide-demo-tech-spec.md:632-643` lists dynamic-demo endpoints not present in the current API.
- `docs/dynamic-agentic-slide-demo-tech-spec.md:741-752` defines acceptance gates including lint, tests, build, e2e, audit, and live Figma validation.

Core implementation:

- `src/server/apiPlugin.ts:13-39` registers local Vite API middleware and starts the Figma bridge on server configure.
- `src/server/apiPlugin.ts:41-197` contains the current API route table.
- `src/server/cerebras.ts:33-84` implements provider calls, backup-key loop, 429 fallback, and error redaction.
- `src/server/cerebras.ts:103-115` implements model JSON extraction/parsing.
- `src/server/contextSwarm.ts:36-52` runs all context lanes and emits final digest.
- `src/server/contextSwarm.ts:74-79` shells out to `rg` for Obsidian search.
- `src/server/contextSwarm.ts:277-279` contains the hard-coded default Obsidian path.
- `src/server/deck.ts:11-57` runs five parallel agent lanes, outline design swarm, synthesis, and deck completion.
- `src/server/deck.ts:119-213` implements the outline categorizer/writer and timed eval/fix clock.
- `src/server/deck.ts:250-300` normalizes candidate decks and slides.
- `src/shared/figma.ts:49-60` builds Figma build plans.
- `src/shared/figma.ts:77-500` generates the executable Figma script.
- `src/shared/figma.ts:527-551` coerces generated decks to exactly 10 slides for Figma payloads.
- `src/server/figmaBridge.ts:33-121` implements bridge server lifecycle, status, and execute command flow.
- `src/server/figmaBridge.ts:309-365` implements WebSocket frame read/write helpers.
- `src/server/feedbackStore.ts:13-27` persists feedback by reading, appending, slicing, and rewriting JSONL.
- `src/App.tsx:80-136` handles context swarm, brainstorm, and deck generation actions.
- `src/App.tsx:170-207` prepares and executes Figma builds.
- `src/App.tsx:216-230` animates Figma stage cards on fixed timers.
- `src/App.tsx:651-677` implements the client SSE parser.

Test coverage inspected:

- `tests/deck.test.ts:28-127` covers deck normalization and fallback shaping.
- `tests/deck.test.ts:129-213` covers Figma spec/handoff/build-plan generation.
- `tests/deck.test.ts:215-257` covers feedback persistence basics.
- `tests/context-swarm.test.ts:47-168` covers context search, missing vaults, fallback lanes, and digest construction.
- `tests/fallback-flow.test.ts:55-192` covers no-key fallback generation, provider-error fallback, outline eval/fix, prompt construction, and Supabase failure handling.
- `tests/figma-bridge.test.ts:14-212` covers bridge connection, execution, errors, timeouts, port fallback, malformed messages, large frames, and singleton creation.
- `tests/e2e/app.spec.ts:3-34` covers initial load, context fallback, deck generation, and Figma finalizer script preparation.

Validation command outputs:

- `npm run lint`: failed with `sh: tsc: command not found`.
- `npm test`: failed with `sh: vitest: command not found`.
- `npm audit --json`: passed with zero total vulnerabilities and 112 total lockfile dependencies.
