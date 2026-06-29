# Product Requirements

## Product Intent

Gemma Deck Forge helps a user turn a rough idea into a ready-to-edit Figma Slides deck. The product is built around visible agent collaboration, but the public contract is reliability: every stage should either produce a useful artifact, report a recoverable warning, or fail with an actionable message.

## Primary Users

- Hackathon reviewers evaluating Cerebras + Gemma 4 31B speed and multi-agent coordination.
- Product, strategy, and operations teams that need decks from messy private context.
- Developers studying a local-first pattern for agentic document generation and Figma automation.

## Core Workflow

1. The user enters a rough idea.
2. Optional context adapters retrieve relevant evidence from user-configured sources.
3. Context writer agents convert retrieved material into a concise brief.
4. Brainstorming agents create and review multiple deck angles.
5. Outline agents produce ten varied slide jobs with explicit design requirements.
6. The Figma bridge generates a deck in the active Figma Desktop file.
7. QA agents export, diagnose, fix, and re-export slides until each slide passes or reaches the configured loop limit.
8. The user can submit manual feedback and rerun the QA loop against the same generated section.

## Hard Requirements

- The app must run from a clean public clone with `npm install`, `.env` setup, and `npm run dev`.
- The app must not require private knowledge-base infrastructure to start.
- Required credentials must live only in `.env` or the caller's environment.
- Optional context adapters must be generic and configured only through environment variables.
- The Figma generation stage must not report completion until the bridge confirms generation for the target section.
- QA must work against the previously generated Figma section, not create a replacement deck.
- QA must remove temporary review/status artifacts before final completion.
- Provider and bridge failures must be visible in the UI and must not be mistaken for success.

## Context Requirements

The context stage should support three modes:

- Built-in fallback context when no adapters are configured.
- Supabase SQL context when `KNOWLEDGE_SUPABASE_WORKDIR` or `KNOWLEDGE_SUPABASE_DB_URL` is configured.
- Local Markdown context when `LOCAL_NOTES_PATH` is configured.

Context output must distinguish:

- source facts
- synthesis
- caveats
- missing information
- downstream slide implications

## Deck Requirements

The generated deck should contain exactly ten slides. Each slide needs:

- one slide job
- one headline claim
- one body or proof block
- at least one design directive
- a slide type distinct enough to avoid repeated template output
- speaker notes or an operator handoff note

The outline stage should prefer varied information architecture over repeated card grids.

## Figma Requirements

Figma writes must be deterministic and serialized through the bridge. Parallel model work is allowed; concurrent writes to the same Figma document are not.

Generation is complete only when:

- the bridge acknowledges every generation batch
- the returned section id is stored
- ten slide frames exist in that section
- each slide has title/body/proof/design content
- generation completeness is at or above the configured threshold
- layout warnings are either empty or surfaced to the user

## QA Requirements

QA is a separate loop from generation. For each slide:

1. Export or otherwise capture the current slide image.
2. Review the latest image with a visual QA prompt.
3. Return structured pass/fail, diagnosis, and surgical fix instructions.
4. Convert the fix plan into Figma bridge execution.
5. Re-export the same slide.
6. Continue until pass or the configured loop limit.

The QA loop must include prior diagnosis and executed fixes in later iterations so it does not repeat the same repair.

Final QA must remove temporary QA badges, overlays, and status tags from the actual deck.

## Security Requirements

- No committed credentials, private paths, private source names, or account identifiers.
- No credential-shaped fake keys in tests or docs.
- No `.env` or runtime data in git.
- Provider errors are redacted before display.
- Public docs must explain optional integrations without assuming a specific private source.

## Success Metrics

- `npm run setup:check` completes with no failures on a correctly configured machine.
- `npm run security:scan` passes on the committed tree.
- `npm run lint`, `npm test`, `npm run test:coverage`, and `npm run build` pass.
- Coverage remains high enough to protect the core generation, context, bridge, QA, and CLI behavior.
- A reviewer can clone the repository, configure a Cerebras key, and run the app without private context.
- A Figma user with the bridge plugin can generate and QA a deck in the active Figma file.

## Non-Goals

- Do not ship fake progress as a substitute for real model, bridge, or QA state.
- Do not hardcode a private design system or private knowledge-base vocabulary.
- Do not require a particular user's local files.
- Do not optimize only for a recorded visual flourish at the expense of correctness.
