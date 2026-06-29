---
name: "gemma-deck-forge-install"
description: "Install and validate Gemma Deck Forge from a fresh public clone."
---

# Gemma Deck Forge Install Skill

Use this when setting up the project on a new machine or helping a reviewer reproduce the app.

## Steps

1. Clone the public repository.

```bash
git clone https://github.com/ch920425/gemma-deck-forge.git
cd gemma-deck-forge
```

2. Install dependencies.

```bash
npm install
```

3. Create local configuration.

```bash
cp .env.example .env
```

4. Add a Cerebras key to `.env`.

```bash
CEREBRAS_API_KEY=your_key_here
CEREBRAS_MODEL=gemma-4-31b
```

5. Optionally configure context adapters.

```bash
KNOWLEDGE_SUPABASE_WORKDIR=/path/to/supabase/project
KNOWLEDGE_SUPABASE_DB_URL=postgresql://...
LOCAL_NOTES_PATH=/path/to/markdown/notes
```

6. Validate setup.

```bash
npm run setup:check
```

7. Run the app.

```bash
npm run dev -- --port 5174
```

8. For live Figma output, open Figma Desktop, open a Slides file, run the Figma Desktop Bridge plugin, then use the workflow in the browser.

## Acceptance Check

The install is ready when:

- `npm run setup:check` has no failures.
- `npm run lint` passes.
- `npm test` passes.
- `npm run build` passes.
- The browser opens the app locally.
