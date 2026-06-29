# Gemma Deck Forge

Agentic hackathon demo for turning idea/context plus `gbrain` Supabase output into a slide outline and Figma Slides handoff spec using Gemma 4 31B on Cerebras.

## What It Does

- Runs parallel Gemma agent lanes for story, evidence, visual direction, Figma planning, and judging critique.
- Pulls `gbrain` context through the Supabase CLI.
- Streams agent progress and latency into a local React app.
- Generates a Figma Slides-ready JSON spec plus a Desktop Bridge handoff prompt.
- Persists feedback locally so later generations can incorporate what to keep or change.

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

Current verified coverage: 99.02% statements, 99.00% lines, 100% functions.

## Figma Slides Handoff

Live Figma mutation requires Figma Desktop with the Desktop Bridge plugin running. If disconnected:

`Open Figma Desktop -> target file -> Plugins -> Development -> Figma Desktop Bridge -> Run, wait a few seconds, then verify the bridge connection.`
