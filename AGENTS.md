# AGENTS.md

Guidance for any agent or human working in this repo. See the [README](README.md) for what the repo is.

## Repo map

- `README.md` — status, timeline, repo map, rules
- `AGENTS.md` — this file, agent conventions
- `info/` — hackathon reference material copied from the vault (event guide, links, grading, restrictions, workflow, stack)
- `ideas/` — one file per idea plus the running scorecard
- `skills/` — agent-runnable skills (`skills/evaluate-idea/SKILL.md` scores any idea)
- `tests/` — pytest checks over repo markdown
- `scripts/` — standalone checks (link checker)
- `.github/` — CI workflows, issue/PR templates, dependabot, codeowners

## Markdown conventions

- GitHub-flavored markdown only. No `==highlight==`, no `[[wikilinks]]`, no other Obsidian-only syntax
- Use tables for tabular data
- One H1 per file

## Validation

Run both before committing:

```text
npx markdownlint-cli2 "**/*.md"
python3 -m pytest tests/ -q
```

## Rules

- Commit in small, logical units: one concern per commit (agent guidance, lint config, tests, CI, templates). Never one giant batch
- `ideas/evaluated.md` is append-only history. Never rewrite past rows or scores
- `info/restrictions.md` ban list governs any new idea content
- New ideas go through `skills/evaluate-idea/SKILL.md` before any build talk
- Never commit secrets. This is a public repo
