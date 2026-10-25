# gazette.bg

Кратки обобщения на всеки брой на Държавен вестник, на разбираем език — [gazette.bg](https://gazette.bg).

Short, plain-language summaries of every issue of Bulgaria's State Gazette
(Държавен вестник), the official journal where laws and regulations are
published before they take effect.

The site is unofficial and not affiliated with any state body. The summaries
are written by AI, may contain mistakes and have no legal force. The official
text is at [dv.parliament.bg](https://dv.parliament.bg).

Spotted a mistake in a summary? [Open an issue](https://github.com/otsirh/gazette.bg/issues).

## How it works

A GitHub Actions workflow (`.github/workflows/update-gazette.yml`) runs
`npm run update-gazette` every day at 12:00 UTC:

1. **Download.** `scripts/download-latest-gazette.js` opens dv.parliament.bg
   with Playwright and downloads the PDF of each of the ten newest issues that
   isn't in `issues/` yet, up to three per run, oldest first.
2. **Summarize.** `scripts/summarize-gazette.js` sends the PDF to Claude through
   the Anthropic API, using the prompts in `scripts/ai-prompts.js`, and writes
   `issues/<year>/<number>/<number>.md` with the issue's date beside it in
   `<number>.json`. An issue that fails is rolled back and retried on the next
   run.
3. **Check.** `scripts/check-issue-gaps.js` fails the run if the issue
   numbering has a hole.
4. **Commit.** The workflow commits the new `issues/` files to `main`.

Cloudflare Pages then runs `npm run build` and publishes `dist/`: the home
page, a page per issue, the archive, the RSS feed, the sitemap and the search
index, all rebuilt from `issues/` every time.

## Running it locally

Needs Node.js 24.

```sh
npm ci
npm run dev              # build dist/ and serve it at http://localhost:3000
```

Building the site needs no API key. To fetch and summarize new issues too:

```sh
npx playwright install chromium
cp .env.example .env     # then put your ANTHROPIC_API_KEY in it
npm run update-gazette
```

## Layout

| Path | What it holds |
| --- | --- |
| `issues/` | The summaries, one folder per issue |
| `scripts/` | The download, summarize and build steps |
| `src/` | The page template, styles and client script |
| `dist/` | Build output, not committed |

## License

© 2026 Hristo Ivanov. All rights reserved: the code and the summaries are
public to read, but please ask before reusing them. The fonts in `fonts/` are
under the SIL Open Font License; see `fonts/OFL.txt`.
