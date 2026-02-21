# WCAG PR Checker

Accessibility regression detection for GitHub PRs. Runs [axe](https://github.com/dequelabs/axe-core) on your built app, diffs results against the base branch, and posts a comment on the PR. Optionally updates a committed baseline on push to `main`.

**Jumbohack 2026**

---

## Use as a GitHub Action

Other repos can use this as a reusable action. You only need a config file in your repo; the action brings its own scripts and dependencies.

### 1. Add config in your repo

Create **`.a11y/config.json`** in the repo you want to check, with the URLs to scan (paths relative to your app’s origin):

```json
{
  "urls": ["/", "/about", "/dashboard"],
  "ignore": [],
  "waitForNetworkIdle": true,
  "extraWaitMs": 500,
  "impactLevels": ["critical", "serious", "moderate", "minor"]
}
```

### 2. Add workflows

**PR check** (runs on every pull request):

Create **`.github/workflows/a11y-check.yml`**:

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
      - name: Checkout PR branch
        uses: actions/checkout@v4
        with:
          path: pr-branch

      - name: Checkout base branch
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          path: main-branch

      - name: Run a11y check
        uses: YOUR_USERNAME/WCAG_PR_Checker@v1
        with:
          mode: pr-check
```

**Baseline update** (runs on push to `main`, commits updated baseline):

Create **`.github/workflows/a11y-baseline.yml`**:

```yaml
name: Update Accessibility Baseline

on:
  push:
    branches:
      - main

jobs:
  baseline:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v4

      - name: Update baseline
        uses: YOUR_USERNAME/WCAG_PR_Checker@v1
        with:
          mode: baseline
```

Replace `YOUR_USERNAME` with your GitHub username or org (e.g. `goldm/WCAG_PR_Checker`). Use `@v1` after you tag a release (see **Publishing** below), or `@main` to follow the default branch.

### 3. Action inputs (optional)

| Input | Default | Description |
|-------|---------|-------------|
| `mode` | `pr-check` | `pr-check` = scan both branches, diff, comment on PR; `baseline` = scan and commit baseline |
| `build-command` | `npm run build` | Command to build the app |
| `output-dir` | `dist` | Directory containing the built app (for `serve`) |
| `node-version` | `20` | Node.js version |
| `config-path` | (auto) | Path to `.a11y/config.json`; defaults to `pr-branch/.a11y/config.json` (pr-check) or `.a11y/config.json` (baseline) |
| `pr-branch-path` | `pr-branch` | Where the PR branch is checked out |
| `main-branch-path` | `main-branch` | Where the base branch is checked out |

Example with a different build:

```yaml
- uses: YOUR_USERNAME/WCAG_PR_Checker@v1
  with:
    mode: pr-check
    build-command: npm run build:prod
    output-dir: build
```

### 4. Requirements in your repo

- **Node/npm** project with a `package.json`
- A **build script** that produces a static output (e.g. `npm run build` → `dist/`). The action runs `npx serve <output-dir>` to serve it.
- For **baseline**: the workflow needs `permissions: contents: write` so it can push the updated `.a11y/baseline.json`.

---

## Publishing the action

1. **Tag a release** so others can pin a version (e.g. `v1`):
   ```bash
   git tag -a v1 -m "WCAG PR Checker v1"
   git push origin v1
   ```
2. Callers use `uses: YOUR_USERNAME/WCAG_PR_Checker@v1` (or `@main` for latest).
3. No need to publish to the Marketplace; any public repo can be used as `owner/repo@ref`.

---

## Local / non-Action usage

Clone this repo, copy `.a11y/` and the workflows into your app repo, add the same npm dependencies, and run the workflows or scripts locally. See the repo’s `.github/workflows/` and `.a11y/` for the full setup.
