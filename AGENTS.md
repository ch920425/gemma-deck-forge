# Gemma Deck Forge Agent Guide

This repository is public-facing. Keep every change safe to clone, inspect, and run without private context.

## Product Contract

Gemma Deck Forge converts a rough idea into a Figma Slides deck through visible agentic stages:

1. Gather optional local or Supabase-backed context.
2. Write a concise context brief.
3. Brainstorm and tighten the deck angle.
4. Produce a ten-slide outline with varied slide jobs.
5. Build the deck through Figma Desktop Bridge.
6. Export/review/fix slides until QA passes or the configured loop limit is reached.

Optimize for real completion and robust failure states. Do not add fake progress, hidden private assumptions, hardcoded local paths, or credential-shaped test values.

## Setup

```bash
npm install
cp .env.example .env
npm run setup:check
npm run dev -- --port 5174
```

Required for live model calls:

```bash
CEREBRAS_API_KEY=your_key_here
CEREBRAS_MODEL=gemma-4-31b
```

Optional context adapters:

```bash
KNOWLEDGE_SUPABASE_WORKDIR=/path/to/supabase/project
KNOWLEDGE_SUPABASE_DB_URL=postgresql://...
LOCAL_NOTES_PATH=/path/to/markdown/notes
```

## Supporting CLI

Use the local CLI for reviewer-friendly setup and release checks:

```bash
npm run install:guide
npm run setup:check
npm run security:scan
```

The CLI must never print secret values. It can report whether a credential is configured, but not the credential itself.

## Code Organization

- `src/App.tsx`: workflow UI and SSE event rendering.
- `src/server/apiPlugin.ts`: local API routes.
- `src/server/cerebras.ts`: Cerebras provider client and redaction.
- `src/server/contextSwarm.ts`: optional context adapters and context workflows.
- `src/server/deck.ts`: deck generation, normalization, and fallback content.
- `src/server/figmaBridge.ts`: local WebSocket bridge server.
- `src/shared/figma.ts`: Figma build and QA script generation.
- `src/shared/prompts.ts`: Gemma prompt contracts.
- `bin/gemma-deck-forge.mjs`: setup and security helper CLI.
- `skills/`: reusable agent/operator procedures.

## Security Rules

- Never commit `.env`, API keys, access tokens, private-key material, private host paths, or account-specific knowledge-base identifiers.
- Keep optional adapters generic. Users provide their own paths and credentials through environment variables.
- Use constructed dummy strings in tests if a provider-shaped value is required.
- Run `npm run security:scan` before public-release commits.
- Redact provider errors before surfacing them to the browser or logs.

## Verification

For normal changes:

```bash
npm run lint
npm test
npm run build
```

For release changes:

```bash
npm run security:scan
npm run test:coverage
npm audit --json
```

Live Figma and live model checks are opt-in because they require local credentials and an active Figma Desktop Bridge session.
