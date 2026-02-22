# a11y-Gaurd

> Detect accessibility regressions between pull requests without punishing existing debt.

Unlike standard axe CI integrations that pass/fail absolutely, WCAG_PR_Checker compares accessibility health over time. It blocks a PR only if it makes things *worse* so teams with legacy debt can mitigate new issues without first fixing everything.

View more information on [the website](https://a11yguardsite.vercel.app/#setup).

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
      contents: write
      pull-requests: write
    steps:
      - name: Run accessibility check
        uses: zachkklein/WCAG_PR_Checker@main
        with:
          APP_DIR: '.'
          BUILD_DIR: 'public'
          URLS: '/'
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

### Fill out Fields:
1. Set `APP_DIR` to the location of your projects root directory.
2. Set `URLS` to contain the routes on your website you wish to check for accessibility issues. Separate routes with a comma (e.g., running the workflow on / and '/contact' would look like `URLS: '/,/contact').

### Using the AI auto-fixer
1. Ensure that you have granted write access by setting the `permissions` section above to:

```yaml
    permissions:
      contents: write   # required for git-auto-commit push
      pull-requests: write
```
2. In the GitHub repository that you integrate this workflow into, set the `OPENROUTER_API_KEY` by navigating to `Settings` then `Environemnt Variables` then `Actions` and add the key as a `Repository Secret`.

---

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `OPENROUTER_API_KEY` | API key for OpenRouter. Required to enable the AI auto-fixer. Add as a repository secret. | `` |
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
| Next.js (static) | `next build` | `.next/server/app` | Requires `output: 'export'` in `next.config.ts` and no dynamic routes (or use `generateStaticParams`) |
| Create React App | `react-scripts build` | `build` | Works out of the box |
| Nuxt | `nuxt generate` | `.output/public` | Use static generation mode |

One way to verify your build folder is to run a build in your repository (i.e. with `npm run build` when using Next.js, and copy the file path to `index.html`).

### Preview URL mode

When **both** `BASE_URL` and `PR_URL` are set, the action **skips** checkout, install, build, and serve. It only installs its own dependencies and Playwright, then scans the two URLs you provide. Use this for:

- **Next.js** (or any stack) with PR preview deployments (e.g. Vercel, Netlify).
- Any app where the base and PR are already deployed and you have two URLs to compare.

Vercel exposes the PR preview URL in the workflow; you can pass your production or main-preview URL as `BASE_URL` and the PR deployment as `PR_URL`.

---

## Examples

### Vite app at repo root

```yaml
- uses: zachkklein/WCAG_PR_Checker@main
  with:
    APP_DIR: '.'
    BUILD_DIR: 'dist'
    URLS: '/,/about'
```

### Next.js app in a subdirectory

```yaml
- uses: zachkklein/WCAG_PR_Checker@main
  with:
    APP_DIR: 'frontend'
    BUILD_DIR: '.next/server/app'
    URLS: '/,/dashboard'
```

### Next.js / Vercel (preview URL mode)

Use deployment URLs instead of building locally. No `BUILD_DIR` or build step — the action only scans the given URLs.

```yaml
- uses: zachkklein/WCAG_PR_Checker@main
  with:
    BASE_URL: 'https://your-app.vercel.app'      # production or main preview
    PR_URL: ${{ steps.deploy.outputs.url }}      # or env from Vercel GitHub Action
    URLS: '/,/about,/projects'
```

If you use the [Vercel GitHub Action](https://github.com/amondnet/vercel-action) or similar, the PR preview URL is often available as an output or env var — pass that into `PR_URL`.

### Report-only mode (never fails the build)

```yaml
- uses: zachkklein/WCAG_PR_Checker@main
  with:
    FAIL_ON_REGRESSION: 'false'
    URLS: '/,/about,/contact'
```

### Only track serious and critical violations

```yaml
- uses: zachkklein/WCAG_PR_Checker@main
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
    ├── comment.js      # PR comment formatting and posting
    └── auto-fix.js     # Optional: AI fixes and commits back to PR (needs OPENROUTER_API_KEY, contents: write)
```

---

## Creators
- [Zach Klein](https://github.com/zachkklein)
- [Andrew Bacigalupi](https://github.com/AndrewBacigalupi)
- [Thee Thakong](https://github.com/thee28)
- [Alex Vu](https://github.com/AlexBVu)
- [William Goldman](https://github.com/iliketocode2)
- [Ethan Li](https://github.com/Ethanli628)

## License

MIT
