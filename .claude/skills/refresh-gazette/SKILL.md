---
name: refresh-gazette
description: Bring the whole gazette.bg site up to date in one go — pull, download & summarize any new issues, refresh every derived page (homepage, issue pages, archive, RSS, sitemap, search index), then build, verify, commit and push. Use when the user says "update the site", "refresh gazette", or runs /refresh-gazette.
---

# Refresh gazette.bg

This is the one-command way to keep the site current. Everything already
self-maintains through the daily GitHub Action (`.github/workflows/update-gazette.yml`,
12:00 UTC) which runs `npm run update-gazette`. This skill is for doing that
**now**, on demand.

Run from the project root. The `.env` must hold `ANTHROPIC_API_KEY` (already
the case locally).

## Steps

1. **Sync.** `git fetch origin && git status`. If the daily Action has pushed,
   `git pull --rebase --autostash origin main` first so you build on top of it.
   Note the current `HEAD` so you can describe what changed at the end.

2. **Run the full pipeline.**
   - Normal refresh (fetch + summarize any new issues + rebuild everything):
     `npm run update-gazette`
   - Just re-render from the issues already on disk (no download/AI):
     `npm run build`
   The pipeline order is: download → summarize → build catalog → build pages.
   The build writes the whole site into `dist/` (gitignored): the home page,
   every page under `issue/<year>/<num>/`, `catalog.json`, `sitemap.xml`,
   `feed.xml`, `search-index.json` and `404.html`. Cloudflare Pages runs the
   same `npm run build` on every push and publishes `dist/`, so the only files
   that change in git are the new issue's `issues/<year>/<num>/` files.

3. **Verify.** Serve and smoke-test before committing:
   `npx --yes serve dist -p 4321 &` then check `/` and a couple of `/issue/<year>/<num>/`
   routes return 200 with no console errors, and that the archive search still
   filters. Kill the server after (`lsof -ti tcp:4321 | xargs kill`). If
   Playwright is set up, open the changed routes in light and dark and confirm
   zero console errors.

4. **Commit & push.** Only if there are changes. Use a message that names what
   actually changed (new issue N). Push with the rebase-retry loop the repo uses:
   ```
   git add -A && git commit -m "<message>"
   for i in 1 2 3; do git push origin main && break; git pull --rebase --autostash origin main; done
   ```

5. **Report.** Tell the user, briefly: which new issue(s) landed, and that it's live.

## What this does NOT require you to do

New issues, the archive register, RSS, the sitemap and the full-text search
index all recompute from scratch on every build — they need no manual work,
ever. There is no curated data left to review by hand.
