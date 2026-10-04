# Plan: Update Documentation to English, Refresh Changelog, Refactor CI, and Investigate GitHub Pages 404

## Goal
Execute four major tasks: (1) translate all Vietnamese documentation to English, (2) add 0.2.0 entry to CHANGELOG.md, (3) refactor GitHub Actions CI into multiple smaller workflows, and (4) investigate and report the root cause of GitHub Pages deployment returning 404 despite workflow success.

## Task 1: Translate Documentation to English

### Files to translate
- **README.md** — Vietnamese headings and descriptions → English; technical terms (DoH, Deno KV, blocklist, upstream, etc.) remain in English; tables preserved; links preserved; formatting preserved
- **docs/ARCHITECTURE.md** — Vietnamese section descriptions → English; mermaid diagrams preserved as-is; tables translated; C4 diagrams kept intact
- **docs/SOFTWARE_DESIGN.md** — Vietnamese → English; module table, decision table, code examples preserved; API reference table translated
- **docs/CONTRIBUTING.md** — Vietnamese → English; the note about Vietnamese documentation language updated to English; Conventional Commits format preserved; GitHub Pages setup note updated
- **docs/CODE_OF_CONDUCT.md** — Already English; no changes needed

### Translation approach
- Use `deno task fmt`-compatible markdown formatting
- Preserve all markdown links `[text](url)` and reference definitions
- Preserve code blocks (fenced and mermaid)
- Preserve table structures; translate only cell content
- Keep section headings hierarchy
- Technical terms remain in English: DoH, RFC 8484, Deno KV, KV, blocklist, upstream, upstream_dns_list.json, ADR, CI/CD, Deno Deploy, etc.
- Vietnamese proper nouns/names kept as-is or Anglicized per translator preference, but technical descriptions translated

### Expected outcome
All documentation files will have English descriptions while maintaining the existing markdown structure, link references, code formatting, and table layouts. The technical content and organization remains identical; only the natural language descriptions are translated.

## Task 2: Add 0.2.0 Entry to CHANGELOG.md

### Location
`/workspaces/deno-dns/CHANGELOG.md`

### Format
Follow the existing "Keep a Changelog" vi format with Semantic Versioning references. Sections: `### Added`, `### Changed`, `### Fixed`, `### Removed`.

### New 0.2.0 entry structure
```
## [0.2.0] — <date>

### Added
- <feature descriptions in English>

### Changed
- <refactoring descriptions in English>

### Fixed
- <bug fix descriptions in English>

### Removed
- <items removed in this release>
```
### Example entries to include (based on actual work)
- Added: multilingual documentation completion (README, ARCHITECTURE, SOFTWARE_DESIGN, CONTRIBUTING)
- Changed: CI workflow refactored into separate lint/test/security/pages/preview workflows
- Fixed: GitHub Pages 404 root cause identified and documented
- Removed: (none for 0.2.0, or specify if applicable)

The `[Unreleased]` section should be updated to reflect items moved to 0.2.0, or a new `[0.2.0]` section added alongside the existing `[Unreleased]` and `[0.1.0]` sections.

## Task 3: Refactor CI Workflow into Multiple Smaller Workflows

### Current state
Single file `.github/workflows/deno.yml` (346 lines) with 5 jobs: `lint-format-check`, `security-scan`, `docs`, `preview`, and implicit test integration.

### Target structure
Split into 5 focused workflow files:

1. **`.github/workflows/deno-lint.yml`** — Lint, format, type-check
   - Trigger: `push`, `pull_request`, `workflow_dispatch`
   - Jobs: `lint-format-check` (combines check, lint, fmt, test)

2. **`.github/workflows/deno-security.yml`** — Dependency security scan
   - Trigger: `push`, `pull_request`, `workflow_dispatch`
   - `needs: deno-lint.yml` jobs
   - Runs: `deno audit --ignore-registry-errors`

3. **`.github/workflows/deno-pages.yml`** — GitHub Pages deployment
   - Trigger: `push` to `main` only
   - `if: github.ref == 'refs/heads/main'`
   - Permissions: `contents: read`, `pages: write`, `id-token: write`
   - Environment: `github-pages`
   - Steps: checkout, setup Deno, stage `_site/`, upload artifact, deploy-pages

4. **`.github/workflows/deno-preview.yml`** — PR preview (Deno Deploy + docs)
   - Trigger: `pull_request` against `main`
   - `if: github.event_name == 'pull_request'`
   - Concurrency: `preview-pr-${{ github.event.pull_request.number }}`
   - Steps: checkout PR head, detect changed docs, wait for Deno Deploy status, resolve preview URL, stage preview site, upload artifact, post sticky comment

5. **`.github/workflows/deno-test.yml`** — Test suite (if separate from lint)
   - Or integrate test job into `deno-lint.yml`

### Key considerations for splitting
- Shared `checkout` and `setup-deno@v2` steps can be duplicated or use a reusable workflow (`.github/workflows/deno-base.yml`)
- The `docs` job condition `if: github.ref == 'refs/heads/main'` only applies to the production deploy
- The `preview` job `if: github.event_name == 'pull_request'` only applies to PR events
- Security scan depends on lint/check completing first
- All artifact names, paths, and output behaviors must remain identical to the original

### Verification
- Each workflow file should produce identical GitHub Actions behavior to the original
- All job triggers, conditions, permissions, concurrency groups, and artifact definitions preserved
- Manual: run each workflow and compare output to original `deno.yml` runs

## Task 4: Investigate GitHub Pages 404 Root Cause

### Symptom
GitHub Actions workflow shows success for Pages deployment, but the published site always returns HTTP 404.

### Files to check
- `.github/workflows/deno.yml` — current deployment configuration
- `_site/` directory contents after staging
- GitHub Pages settings: `Settings → Pages → Source`

### Investigation checklist (already analyzed)
1. **Deployment branch and output folder**: Workflow triggers on `push` to `main`; outputs `_site/` directory. Correct.
2. **Pages source settings**: Must be set to "GitHub Actions" in `Settings → Pages → Source`. If set to "None" or "Master branch", deployment fails.
3. **Whether index.html is actually published**: The `_site/` directory contains `docs/*.md`, `README.md`, `CHANGELOG.md` — **no `index.html`**. GitHub Pages serves from `www/` directory and defaults to `index.html`. Without an `index.html`, the root returns 404.
4. **Site's baseurl configuration**: Not applicable — raw Markdown deployed as-static, no baseurl needed when Pages source is "GitHub Actions".
5. **Caching or `.nojekyll` issues**: Without `.nojekyll`, Jekyll may process the `_site/` directory. Jekyll could skip Markdown files or process them differently, but the primary issue is the missing `index.html`.

### Most likely root cause
**The `_site/` directory contains only Markdown files (`*.md`, `README.md`, `CHANGELOG.md`) with no `index.html` and no `.nojekyll` file.** GitHub Pages serves the `www/` directory and defaults to `index.html` as the homepage. Without `index.html`, the root URL returns 404. Additionally, without `.nojekyll`, Jekyll may attempt to process the Markdown files, which can cause unexpected behavior when the Pages source is "GitHub Actions" (Jekyll is disabled for Actions source, but the absence of `index.html` remains the primary issue).

### Concrete fix steps
1. Add an `index.html` to the `_site/` staging step, or rename `README.md` to `index.html` in the copy command
2. Add `.nojekyll` to `_site/` to ensure Jekyll doesn't interfere (even though Actions source disables Jekyll, this is a best practice for static sites)
3. Update the `_site/` copy command in the `docs` job from:
   ```
   mkdir -p _site && cp docs/*.md README.md CHANGELOG.md _site/
   ```
   to either:
   - `mkdir -p _site && cp docs/*.md README.md CHANGELOG.md _site/ && cp README.md _site/index.html` (if README should be the homepage)
   - Or: `mkdir -p _site && cp docs/*.md _site/ && echo '<!DOCTYPE html><html>...' > _site/index.html` (explicit index)
   - Or keep README.md as index.html: `mkdir -p _site && cp docs/*.md _site/ && mv README.md _site/index.html`

### Alternative approach
If the intent is to publish documentation as a static site without a specific homepage, add `.nojekyll` and ensure the site structure is correct. But the most direct fix for the 404 is ensuring `index.html` exists in the deployed folder.

## Verification Steps After Changes
1. Run each new workflow file and compare job output to original `deno.yml` runs
2. Push to `main` and verify GitHub Pages site loads at `https://<owner>.github.io/deno-dns/` (or custom domain)
3. Verify `index.html` is visible in the deployed folder via the GitHub Pages browser UI
4. Check that `deno task check && deno task lint && deno task fmt --check && deno test` still passes locally
5. Verify PR preview workflow still posts correct sticky comments with artifact links
6. Confirm security scan job still runs `deno audit` without errors