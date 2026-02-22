# a11y-diff

> Detect accessibility regressions between pull requests — without punishing existing debt.

Unlike standard axe CI integrations that pass/fail absolutely, **a11y-diff compares accessibility health over time**. It blocks a PR only if it makes things *worse* — so teams with legacy debt can hold the line without first fixing everything.

---

## How it works

1. **Base vs PR**: The action compares the **base branch** (e.g. `main`) to the **PR branch** — either by building both and serving static files, or by scanning live deployment URLs.
2. Runs [axe-core](https://github.com/dequelabs/axe-core) on both via Playwright.
3. Diffs the results — new violations are flagged, resolved violations are celebrated.
4. Posts a structured comment to the PR and optionally fails the check.

---

## Usage

Add this to `.github/workflows/a11y.yml` in any repository:

```yaml
name: Accessibility Regression Check

on:
  pull_request:

jobs:
  a11y:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: zachkklein/WCAG_PR_Checker@v1
        with:
          APP_DIR: '.'
          BUILD_DIR: 'dist'
          URLS: '/,/about,/dashboard'
```

That's it. No scripts to copy, no config files to manage.

---

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `APP_DIR` | Path to your app directory relative to repo root. Use `"."` if your app is at the root. | `.` |
| `BUILD_DIR` | Static build output directory (`dist`, `out`, `build`). | `dist` |
| `BUILD_COMMAND` | npm script to build your app. | `build` |
| `URLS` | Comma-separated URL paths to scan. | `/` |
| `IGNORE_RULES` | Comma-separated axe rule IDs to skip (e.g. `"duplicate-id,color-contrast"`). | `` |
| `FAIL_ON_REGRESSION` | Fail the check when new violations are found. Set `"false"` to report only. | `true` |
| `IMPACT_LEVEL` | Minimum severity to track: `minor`, `moderate`, `serious`, `critical`. | `moderate` |
| `WAIT_FOR_NETWORK_IDLE` | Wait for network idle before scanning. Recommended for SPAs. | `true` |
| `EXTRA_WAIT_MS` | Additional milliseconds to wait after page load before scanning. | `500` |
| `TOKEN` | GitHub token with `pull-requests: write`. | `github.token` |
| `BASE_URL` | Base branch deployment URL. If set *with* `PR_URL`, skips local build/serve and scans these URLs (see [Preview URL mode](#preview-url-mode)). | `` |
| `PR_URL` | PR preview deployment URL. If set *with* `BASE_URL`, skips local build/serve. | `` |

## Outputs

| Output | Description |
|--------|-------------|
| `new_violations` | Number of new violations introduced by this PR |
| `resolved_violations` | Number of violations resolved by this PR |
| `regression` | `"true"` or `"false"` |

---

## Example PR comment

When regressions are found, the action posts a comment like this:

```
♿ Accessibility Check — ❌ Regressions Found

|                  | Baseline | This PR | Delta  |
|------------------|----------|---------|--------|
| Total violations | 12       | 14      | +2     |
| 🔴 Critical      | 0        | 1       | +1 ⬆️  |
| 🟠 Serious       | 3        | 4       | +1 ⬆️  |

🚨 New Violations (2)
| Impact       | Rule            | WCAG        | Page  | Selector    | Docs |
|--------------|-----------------|-------------|-------|-------------|------|
| 🔴 critical  | color-contrast  | WCAG 2.1 AA | /     | #submit-btn | docs |
```

---

## Deployment modes

### Static build mode (default)

When **neither** `BASE_URL` nor `PR_URL` is set, the action checks out both branches, builds each, serves the static output with `npx serve`, and scans localhost. This only works when your app produces a **static export** (e.g. a folder of HTML/JS/CSS).

| Framework | Build command | Output dir | Notes |
|-----------|--------------|------------|-------|
| Vite | `vite build` | `dist` | Works out of the box |
| Next.js (static) | `next build` | `out` | Requires `output: 'export'` in `next.config.ts` and no dynamic routes (or use `generateStaticParams`) |
| Create React App | `react-scripts build` | `build` | Works out of the box |
| Nuxt | `nuxt generate` | `.output/public` | Use static generation mode |

Standard **Next.js apps** that use `next build` (without `output: 'export'`) produce a `.next` server bundle, not static files — so there is no `out/` to serve. Use [Preview URL mode](#preview-url-mode) instead.

### Preview URL mode

When **both** `BASE_URL` and `PR_URL` are set, the action **skips** checkout, install, build, and serve. It only installs its own dependencies and Playwright, then scans the two URLs you provide. Use this for:

- **Next.js** (or any stack) with PR preview deployments (e.g. Vercel, Netlify).
- Any app where the base and PR are already deployed and you have two URLs to compare.

Vercel exposes the PR preview URL in the workflow; you can pass your production or main-preview URL as `BASE_URL` and the PR deployment as `PR_URL`.

---

## Examples

### Vite app at repo root

```yaml
- uses: your-org/a11y-diff-action@v1
  with:
    APP_DIR: '.'
    BUILD_DIR: 'dist'
    URLS: '/,/about'
```

### Next.js app in a subdirectory

```yaml
- uses: your-org/a11y-diff-action@v1
  with:
    APP_DIR: 'frontend'
    BUILD_DIR: 'out'
    URLS: '/,/dashboard'
```

### Next.js / Vercel (preview URL mode)

Use deployment URLs instead of building locally. No `BUILD_DIR` or build step — the action only scans the given URLs.

```yaml
- uses: your-org/a11y-diff-action@v1
  with:
    BASE_URL: 'https://your-app.vercel.app'      # production or main preview
    PR_URL: ${{ steps.deploy.outputs.url }}      # or env from Vercel GitHub Action
    URLS: '/,/about,/projects'
```

If you use the [Vercel GitHub Action](https://github.com/amondnet/vercel-action) or similar, the PR preview URL is often available as an output or env var — pass that into `PR_URL`.

### Report-only mode (never fails the build)

```yaml
- uses: your-org/a11y-diff-action@v1
  with:
    FAIL_ON_REGRESSION: 'false'
    URLS: '/,/about,/contact'
```

### Only track serious and critical violations

```yaml
- uses: your-org/a11y-diff-action@v1
  with:
    IMPACT_LEVEL: 'serious'
    URLS: '/'
```

---

## Repository structure

```
a11y-diff-action/
├── action.yml          # Action definition and inputs
├── package.json        # Self-contained dependencies
└── src/
    ├── scan.js         # Playwright + axe-core scanner
    ├── diff.js         # Violation diffing logic
    └── comment.js      # PR comment formatting and posting
```

---

## License

MIT
