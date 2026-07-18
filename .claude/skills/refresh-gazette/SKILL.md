---
name: refresh-gazette
description: Bring the whole gazette.bg site up to date in one go — pull, download & summarize any new issues, refresh every derived page (archive, RSS, deadlines, places, map, stats, glossary, tracks), sanity-check auto-added glossary terms, optionally propose a new tracker storyline, then build, verify, commit and push. Use when the user says "update the site", "refresh gazette", or runs /refresh-gazette.
---

# Refresh gazette.bg

This is the one-command way to keep the site current. Almost everything already
self-maintains through the daily GitHub Action (`.github/workflows/update-gazette.yml`,
12:00 UTC) which runs `npm run update-gazette`. This skill is for doing that
**now**, on demand, and for the two things that want a human eye: reviewing any
glossary term the maintainer just added, and deciding whether a new recurring
story deserves its own tracker.

Run from the project root (`/home/hristo/Development/gazette.bg`). The `.env`
must hold `ANTHROPIC_API_KEY` (already the case locally).

## Steps

1. **Sync.** `git fetch origin && git status`. If the daily Action has pushed,
   `git pull --rebase --autostash origin main` first so you build on top of it.
   Note the current `HEAD` so you can describe what changed at the end.

2. **Run the full pipeline.**
   - Normal refresh (fetch + summarize any new issues + rebuild everything):
     `npm run update-gazette`
   - Just re-render from the issues already on disk (no download/AI):
     `npm run build`
   The pipeline order is: download → summarize → build catalog → **maintain
   glossary** (non-fatal) → build pages. It regenerates `catalog.json`,
   `sitemap.xml`, `feed.xml`, `search-index.json` and the standalone pages
   (`deadlines/`, `places/`, `map/`, `stats/`, `glossary/`, `tracks/`).

3. **Review glossary changes (quality gate).** `git diff glossary.json glossary-ignore.json`.
   The maintainer (`scripts/maintain-glossary.js`) proposes a definition, a
   skeptic pass verifies it, and a mixed-script guard drops OCR garbage — but you
   are the final check. For each **added** term confirm the expansion is a real,
   nationally-known institution/law/programme **and** its letters actually
   correspond (watch for corrupted source acronyms like `ТОЛЕК`/`ТЦЕЛК`, which are
   garbled `ТЕЛК`/`НЕЛК`). Anything doubtful: delete it from `glossary.json` and
   add it to the `removed` list in `glossary-ignore.json` so it never returns.
   - To reconsider a term the maintainer set aside, remove it from `skipped` in
     `glossary-ignore.json` and re-run `npm run maintain-glossary`.
   - Never re-add a term that is in `removed` (currently SMS, BG-ALERT, POS) —
     those were deliberately vetoed.

4. **Consider a new tracker (optional, editorial).** The two existing storylines
   in the `TRACKERS` array in `scripts/build-issue-pages.js` (the euro transition
   and the elections) fill themselves as matching issues arrive — you do NOT need
   to touch them. But if a *new* big theme has clearly begun recurring across many
   issues (a major reform, a budget saga, an infrastructure programme), it may
   deserve its own timeline. To gauge it, scan section titles across recent
   issues for a theme that shows up in many issues and isn't covered yet, e.g.:
   `grep -rhoP '^##\s+\K.*' issues --include=*.md | sort | uniq -c | sort -rn | head -40`
   If one stands out, propose it to the user first (it's a curated choice, not an
   automatic one). If they agree, add one entry to `TRACKERS`:
   `{ title: '<Bulgarian title>', sub: '<one-line Bulgarian subtitle>', match: /<regex>/iu }`
   Regex rules that matter here: JavaScript `\b` is ASCII-only and will NOT match
   a Cyrillic word boundary — use a Unicode letter lookbehind `(?<![\p{L}])` with
   the `u` flag, and `\p{L}` instead of `\w`. Match on the section **title** (the
   least-noisy signal). Then `npm run build` and verify the new `/tracks` timeline
   reads sensibly and its step links resolve.

5. **Verify.** Serve and smoke-test before committing:
   `npx --yes serve -p 4321 &` then check a handful of routes return 200 and have
   no console errors (`/`, `/tracks/`, `/glossary/`, `/deadlines/`, `/map/`,
   `/stats/`, `/places/`). Kill the server after (`fuser -k 4321/tcp`). If
   Playwright is set up, open the changed routes in light and dark and confirm
   zero console errors, as with every other feature here.

6. **Commit & push.** Only if there are changes. Use a message that names what
   actually changed (new issue N, glossary term X added, tracker Y added). Push
   with the rebase-retry loop the repo uses:
   ```
   git add -A && git commit -m "<message>"
   for i in 1 2 3; do git push origin main && break; git pull --rebase --autostash origin main; done
   ```

7. **Report.** Tell the user, briefly: which new issue(s) landed, any glossary
   terms added/rejected, whether a tracker was touched, and that it's live.

## What this does NOT require you to do

New issues, RSS, deadlines, places, the map, stats, full-text search, "проследи
темите", the "За мен" filter and the euro/elections trackers all recompute from
scratch on every build — they need no manual work, ever. The static geography
(`scripts/data/bg-settlements.json`, `scripts/data/bg-provinces.json`) never
changes. The only human judgment is in steps 3 and 4, and both are additive:
skipping them leaves the site correct and current, just without a possible new
tooltip or a possible new storyline.
