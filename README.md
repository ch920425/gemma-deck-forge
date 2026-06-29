# Gemma Deck Forge

Agentic hackathon demo for turning idea/context plus `gbrain` Supabase output into a slide outline and Figma Slides handoff spec using Gemma 4 31B on Cerebras.

## What It Does

- Runs parallel Gemma agent lanes for story, evidence, visual direction, Figma planning, and judging critique.
- Streams a context swarm so Supabase `gbrain`, Obsidian vault search, Gemma organization, and local brief lanes work in parallel instead of freezing on one `Querying` state.
- Streams agent progress and latency into a local React app.
- Generates a Figma Slides-ready JSON spec plus a Desktop Bridge handoff prompt.
- Generates an executable Figma Desktop Bridge build script for a 10-slide live finalizer.
- Shows a 50-stage build/review/revise/polish/finalize board so the Figma burst can be demoed from the product UI.
- Persists feedback locally so later generations can incorporate what to keep or change.

## Planning Docs

- [Dynamic Agentic Slide Demo PRD](docs/dynamic-agentic-slide-demo-prd.md)
- [Dynamic Agentic Slide Demo Technical Spec](docs/dynamic-agentic-slide-demo-tech-spec.md)

## Local Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Required local secrets live only in `.env`, which is ignored by git:

- `CEREBRAS_API_KEY`
- `CEREBRAS_BACKUP_API_KEY`
- `CEREBRAS_MODEL=gemma-4-31b`
- `SUPABASE_WORKDIR`

## Verification

```bash
npm run lint
npm test
npm run test:coverage
npm run build
npm run test:e2e
npm audit --json
```

Current verified coverage: 98.37% statements, 98.66% lines, 99.06% functions, 81.85% branches.

## Figma Slides Handoff

Live Figma mutation requires Figma Desktop with the Desktop Bridge plugin running. If disconnected:

`Open Figma Desktop -> target file -> Plugins -> Development -> Figma Desktop Bridge -> Run, wait a few seconds, then verify the bridge connection.`

The high-speed demo path is `Generate deck` -> `Build in Figma` -> copy/run the emitted `figma_execute` script through the Desktop Bridge. The verified live burst created 10 slide frames and ran 50 slide-phase actions at 7.82 actions/sec.
