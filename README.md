# a11y-diff

> Detect accessibility regressions between pull requests — without punishing existing debt.

Unlike standard axe CI integrations that pass/fail absolutely, **a11y-diff compares accessibility health over time**. It blocks a PR only if it makes things *worse* — so teams with legacy debt can hold the line without first fixing everything.

---

## How it works

1. On every PR, the action builds both the **base branch** and the **PR branch**
2. Runs [axe-core](https://github.com/dequelabs/axe-core) on both via Playwright
3. Diffs the results — new violations are flagged, resolved violations are celebrated
4. Posts a structured comment to the PR and optionally fails the check

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

## Framework compatibility

The action requires your app to produce a **static export** that can be served with `npx serve`. Most frameworks support this:

| Framework | Build command | Output dir | Notes |
|-----------|--------------|------------|-------|
| Vite | `vite build` | `dist` | Works out of the box |
| Next.js | `next build` | `out` | Requires `output: 'export'` in `next.config.ts` |
| Create React App | `react-scripts build` | `build` | Works out of the box |
| Nuxt | `nuxt generate` | `.output/public` | Use static generation mode |

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
