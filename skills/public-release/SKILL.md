---
name: "gemma-deck-forge-public-release"
description: "Harden Gemma Deck Forge for public release and verify repo hygiene."
---

# Gemma Deck Forge Public Release Skill

Use this before pushing public changes or changing repository visibility.

## Review Loop

Run the loop at least twice for release-critical changes:

1. Scan for private material.

```bash
npm run security:scan
```

2. Inspect public docs for clone/install clarity.

```bash
sed -n '1,240p' README.md
sed -n '1,220p' AGENTS.md
```

3. Verify implementation.

```bash
npm run lint
npm test
npm run test:coverage
npm run build
npm audit --json
```

4. Review the diff.

```bash
git diff --stat
git diff --check
```

## Public Safety Rules

- No real credentials or credential-shaped fake values.
- No hardcoded personal paths or private source names.
- No instructions that require a specific private knowledge base.
- No fake progress contracts. The UI should report real bridge/model states, warnings, and failures.
- Optional integrations must degrade gracefully when absent.

## Release Criteria

- Setup instructions work from a fresh clone.
- CLI install guide and setup doctor are available.
- Tests and build pass.
- Coverage remains high enough to protect core behavior.
- Security scan passes.
- GitHub repository visibility is public only after the checks pass.
