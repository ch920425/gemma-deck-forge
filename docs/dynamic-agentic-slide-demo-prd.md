# Dynamic Agentic Slide Demo PRD

## Product Intent

Gemma Deck Forge should demo as a live, self-improving slide team rather than a one-shot deck generator. The viewer should see Gemma agents rapidly draft an outline, evaluate it, restructure it, and then build a visually varied Figma deck through a visible sequence of improvements.

The demo must feel like a succession of quick improvements over time:

1. Raw idea and gbrain context enter.
2. Multiple Gemma agents draft, critique, split, merge, delete, and reorder the outline.
3. The system shows per-slide and holistic evals.
4. Figma starts bare, then scaffolds, writes text, applies visual structure, repairs weak slides, and polishes the deck.
5. The final state is a cohesive 10-slide deck with high visual variety and measured action throughput.

## Current Reference Findings

Reference URL provided by the user:

`https://www.figma.com/slides/elDnj0yDZuONPF7Kr8tYBm`

Observed through Figma Desktop and Desktop Bridge:

- Active Figma window title: `Agentic Figma Slides Outlining + Design Finalization`.
- Desktop Bridge can execute read-only Figma API calls against the file.
- The added reference material is present as regular Figma frames and shapes, not published/local `COMPONENT` nodes.
- `figma_search_components`, design-system summary, and text-style APIs still report zero formal components, component sets, tokens, or text styles.
- The file now contains `41` top-level `1920x1080` reference frames plus the earlier scaffold primitives.
- The original map primitives remain useful for product/system language:
  - Blue category blocks, fill `#0D99FF`: `Learning Journey`, `Content Gen Platform`, `Outcomes`.
  - Orange tool/lesson blocks, fill `#FFA629`: `MFY (Onboarding Interests)`, `Speak Tutor Lessons`, `Takeaway Lessons`, `PLL (and its variations)`, `DOUG`, `KEITH`, `KEITH Lite`.
- The added reference frame set provides direct slide-design variety:
  - agenda slide with numbered sections
  - sparse title / thesis slide
  - customer quote slide with oversized quote block
  - two-column metric slide
  - multi-bet foundation slide with numbered boxes
  - org update / dense operating-notes slide
  - table/timeline slide
  - dark blue section divider slides
  - platform health stat cards
  - current-state metric card with coverage bars
  - agent-docs loop diagram
  - release / CI content cards with image slots
  - UI confidence phone mockup
  - Sentry cleanup signal-quality chart
  - binary-size before/after slide
  - Q3 focus three-card slide
  - people / shoutout cards
  - pill cluster for shared UI adoption
  - migration metrics slide
  - testing / CI quality-guardrail slide
- The generated section name explicitly records the current failure:
  - slide outline text and design are too similar
  - design does not follow Speak-like components enough
  - not enough dynamic generation, eval, review, edit, and improvement-over-time feel for video
- Current generated slides are structurally too uniform:
  - all final frames are `960x540`
  - most frames contain roughly the same `RECTANGLE` and `TEXT` counts
  - all slides use the same agent cards, phase chips, and evidence well composition
  - the iteration appears as status-chip coloring, not true design improvement

## Problem

The current demo proves speed, but not thoughtful agency. Ten slides are created quickly, yet they look like variants of the same template. The viewer cannot tell that different Gemma agents are making distinct judgments, that evals are diagnosing real issues, or that the deck is structurally improving over time.

This weakens the hackathon story because Cerebras speed should be visible as a better interaction model:

- not just faster response text
- not just faster slide creation
- but live parallel reasoning that changes the artifact while the viewer watches

## Target User

Primary audience:

- Cerebras x Gemma hackathon judges watching a live or recorded demo.

Secondary audience:

- product leaders, founders, and internal operators who create persuasive decks from messy context.

## Demo Promise

In under 30 seconds, a messy idea plus context becomes a visibly evolving outline and a polished, varied Figma deck. The viewer sees agents working in parallel, running evals, fixing their own output, and improving both story and design before final polish.

## Hard Goals

These are pass/fail goals for implementation.

### Timing

- Documentation and outline stage must last at least `6000ms`.
- Figma design generation stage must last at least `10000ms`.
- The demo must still feel snappy: at least `5` visible Figma actions per second during the Figma stage.
- The Figma stage should target `10-14s`, not an unbounded slow animation.

### Visible Agentic Behavior

- Show at least `5` named Gemma agent lanes working in parallel.
- Show at least `30` documentation-stage events.
- Include at least `10` per-slide eval events.
- Include at least `2` holistic deck eval events.
- Include at least `1` slide split operation.
- Include at least `1` slide combine or merge operation.
- Include at least `1` delete operation for a weak/redundant slide.
- Include at least `1` reorder operation justified by story flow.
- Include at least `1` type change operation, such as `proof card -> workflow diagram` or `generic claim -> metric slide`.

### Final Deck Shape

- Final deck must contain exactly `10` slides.
- At least `8` distinct slide scaffolds must appear across the 10 slides.
- No more than `2` adjacent slides may share the same layout family.
- No more than `3` slides may use the same dominant composition.
- Each slide must have one explicit job, one headline claim, one proof or visual structure, and one speaker beat.
- At least `4` slides must use visible evidence or artifact-oriented structure, not just abstract cards.

### Speak-Like Visual Direction

Use the reference scaffold primitives as local grammar:

- Deep Speak navy `#12235D` / `#123C7A` for primary headlines and section authority.
- Bright blue `#2E5CF2` / `#1C49FF` for rules, rails, section labels, and primary accent.
- Green `#05946B`, red/coral `#FF6B57`, and yellow `#FFC247` for semantic metric/accent rails.
- Pale blue card fill `#F0F6FF` and soft-circle fill `#E0E5FF` for repeated content surfaces.
- Blue `#0D99FF` for major learning/platform/outcome lanes when using the map primitives.
- Orange `#FFA629` for product, lesson, tool, or workflow tiles when using the map primitives.
- Dark Figma canvas environment for the live build area, but final slide frames should use the reference deck's clean white/navy visual system.
- Compact, operational labels rather than decorative AI motifs.
- A map-like relationship between learning journey, content platform, tools, and outcomes.
- A vertical left rail, short title rule, large top-left headline, and optional pale soft circle are the default reference-deck frame grammar.

The generated deck must not use one repeated card grid across all slides.

### Figma Demo Behavior

The Figma stage must begin bare and visibly improve:

1. Create an empty named section.
2. Create rough blank slide frames.
3. Add scaffold primitives and slide type labels.
4. Add draft text.
5. Run per-slide eval markers.
6. Apply targeted fixes per slide.
7. Run holistic cohesion pass.
8. Add/delete/split/merge/reorder as needed.
9. Apply visual variation and polish.
10. Screenshot-verify final section.

### Safety and Technical Constraints

- Gemma agents may plan in parallel.
- Figma writes must be serialized through a single ordered writer queue.
- The UI can display parallelism, but the bridge must receive deterministic ordered mutations.
- The system must never rely on concurrent writes to the same Figma document.
- The build must degrade gracefully when the reference file has no reusable components.

## Non-Goals

- Do not build a static marketing landing page.
- Do not fake parallelism with only status chips.
- Do not require a human to manually edit slides during the demo.
- Do not force all decks into the exact Speak scaffold when the prompt demands a different story.
- Do not claim true Figma Slides API behavior when the connected file is a Figma design file.

## Required Experience

### Documentation Stage

The app should show a live "outline draft room" for at least 6 seconds.

Expected visible events:

- source ingest
- gbrain evidence extraction
- audience clarification
- first outline draft
- slide job assignment
- critique pass
- split weak overloaded slide
- merge redundant adjacent slides
- delete filler slide
- reorder for story flow
- change slide type based on message intent
- final outline acceptance

The text structure should vary per run based on the input message. The system should not always produce the same 10 titles or the same sequence of slide types.

### Figma Stage

The app should then send an executable Figma plan that spends at least 10 seconds building and improving the deck.

Expected visible states:

- blank frames
- rough scaffolds
- draft copy
- eval overlays
- fix diagnostics
- revised copy
- visual alternation
- cohesion repairs
- final polish

The demo should make the work look useful, not random. Every visual action should correspond to a visible decision:

- "Slide 3 is overloaded, splitting into workflow + proof artifact."
- "Slides 6 and 7 repeat the same claim, combining and replacing one with outcome metrics."
- "Deck rhythm is too dense, converting Slide 5 to a sparse thesis slide."
- "Visual system is drifting, applying Speak scaffold colors and tile grammar."

## Slide Scaffold Library

Implementation should include these scaffold families.

1. `speak-map-opener`
   - Full-deck premise using blue journey block and orange product tiles.
2. `learning-journey-map`
   - Vertical blue lane with sequenced orange capability nodes.
3. `platform-system-map`
   - Content generation platform as a central blue block with adjacent product/tool modules.
4. `before-after-workflow`
   - Two states with a visible process transition.
5. `agent-swarm-board`
   - Parallel agent lanes, each with diagnostic output and accepted/rejected changes.
6. `eval-diagnostic-report`
   - Per-slide issue list with severity, fix decision, and applied patch.
7. `proof-artifact`
   - Large evidence area for gbrain excerpt, screenshot placeholder, SQL output, or prompt trace.
8. `metric-scoreboard`
   - Action rate, elapsed time, slide changes, and eval pass metrics.
9. `split-merge-timeline`
   - Shows slide additions, deletions, combines, and reorders over time.
10. `cohesion-polish`
    - Final rhythm and consistency pass with before/after mini-thumbnails.
11. `closing-question`
    - Sparse audience-facing question or implication.
12. `speak-agenda`
    - Numbered agenda with 3-5 sections and a large blue title.
13. `oversized-quote`
    - One large evidence quote with a short setup line and attribution.
14. `platform-health-scoreboard`
    - Three large metric cards with accent rails and before/after values.
15. `agent-docs-loop`
    - Four-node loop diagram showing gaps, docs, speed, and reusable patterns.
16. `shared-ui-pill-cluster`
    - Two content cards plus a lower cluster of capability pills.
17. `phone-confidence-demo`
    - Device/mock screen as the dominant proof object.
18. `signal-quality-chart`
    - Big metric plus bar/noise chart and 2-3 bullet dots.
19. `shoutout-grid`
    - Six recognition/person cards, usable for agent-lane owners or slide-change owners.
20. `dark-section-divider`
    - Navy full-slide divider for stage transitions such as `Documentation`, `Figma Build`, and `Final Polish`.

## Success Metrics

A run is successful only if all of the following are true:

- Documentation stage elapsed time is `>= 6000ms`.
- Figma stage elapsed time is `>= 10000ms`.
- Figma action rate is `>= 5 actions/sec`.
- Final deck has exactly `10` slides.
- Final deck has at least `8` scaffold families.
- Stage log contains split, merge/combine, delete, reorder, type-change, per-slide eval, and holistic eval events.
- Screenshot validation confirms no major text overflow, incoherent overlap, or unreadable slide.
- The generated deck looks visibly more varied than the prior `v1 outcome` section.

## Open Risk

The reference file did not expose formal reusable components through the local component API, even after the user added reference material. The added material is accessible as normal `FRAME`, `RECTANGLE`, `TEXT`, `ELLIPSE`, `TABLE`, `GROUP`, and `VECTOR` nodes.

The implementation must therefore support two paths:

1. Component-backed path when the bridge can access components or a published library.
2. Scaffold-extraction path that treats shapes, colors, text styles, and layout primitives as the design source of truth.

The current reference evidence supports path 2, and that is enough for implementation because the frames expose concrete reusable layout grammar.
