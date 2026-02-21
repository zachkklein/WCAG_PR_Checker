/**
 * comment.js
 * Reads diff.json and posts a formatted markdown comment to the GitHub PR.
 * Fails the check if regressions exist and FAIL_ON_REGRESSION is "true".
 *
 * Usage:
 *   node comment.js --diff diff.json
 *
 * Required env vars (automatically set by action.yml):
 *   GITHUB_TOKEN
 *   PR_NUMBER
 *   GITHUB_REPOSITORY
 *   FAIL_ON_REGRESSION  ("true" | "false")
 */

'use strict';

const fs    = require('fs');
const https = require('https');
const minimist = require('minimist');

const args   = minimist(process.argv.slice(2));
const diffFile = args.diff || 'diff.json';

const GITHUB_TOKEN       = process.env.GITHUB_TOKEN;
const PR_NUMBER          = process.env.PR_NUMBER;
const GITHUB_REPOSITORY  = process.env.GITHUB_REPOSITORY;
const FAIL_ON_REGRESSION = process.env.FAIL_ON_REGRESSION !== 'false';

if (!GITHUB_TOKEN || !PR_NUMBER || !GITHUB_REPOSITORY) {
  console.error('Missing required env vars: GITHUB_TOKEN, PR_NUMBER, GITHUB_REPOSITORY');
  process.exit(1);
}

const [owner, repo] = GITHUB_REPOSITORY.split('/');

// ─── Constants ────────────────────────────────────────────────────────────────

const IMPACT_EMOJI = {
  critical: '🔴',
  serious:  '🟠',
  moderate: '🟡',
  minor:    '🔵',
};

// Human-readable labels and direct WCAG reference URLs
const WCAG_TAGS = {
  'wcag2a':        { label: 'WCAG 2.0 A',    url: 'https://www.w3.org/TR/WCAG20/' },
  'wcag2aa':       { label: 'WCAG 2.0 AA',   url: 'https://www.w3.org/TR/WCAG20/' },
  'wcag21a':       { label: 'WCAG 2.1 A',    url: 'https://www.w3.org/TR/WCAG21/' },
  'wcag21aa':      { label: 'WCAG 2.1 AA',   url: 'https://www.w3.org/TR/WCAG21/' },
  'wcag22aa':      { label: 'WCAG 2.2 AA',   url: 'https://www.w3.org/TR/WCAG22/' },
  'best-practice': { label: 'Best Practice', url: 'https://dequeuniversity.com/rules/axe/' },
};

// Actionable fix hints per axe rule ID — shown inline in the detail block
const FIX_HINTS = {
  'color-contrast':              'Increase the contrast ratio between the text and its background to at least 4.5:1 (3:1 for large text). Use a contrast checker at https://webaim.org/resources/contrastchecker/',
  'image-alt':                   'Add a descriptive `alt` attribute to the `<img>` element. Use `alt=""` for decorative images.',
  'button-name':                 'Give the button an accessible name via visible text content, `aria-label`, or `aria-labelledby`.',
  'link-name':                   'Give the link an accessible name via visible text, `aria-label`, or `aria-labelledby`. Avoid "click here" or "read more".',
  'label':                       'Associate a `<label>` element with this form input using a matching `for`/`id` pair, or use `aria-label`.',
  'input-button-name':           'Add a `value` attribute or `aria-label` to give this input button an accessible name.',
  'aria-required-attr':          'Add the required ARIA attribute(s) listed in the violation. Check the ARIA spec for this role.',
  'aria-roles':                  'Correct the invalid ARIA role. Refer to https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles',
  'aria-hidden-focus':           'Remove `aria-hidden="true"` from an element that contains focusable children, or remove the focusable elements from inside it.',
  'aria-hidden-body':            'Remove `aria-hidden="true"` from the `<body>` element.',
  'duplicate-id-active':         'Ensure all `id` values used in ARIA or label references are unique on the page.',
  'duplicate-id-aria':           'Ensure all `id` values referenced by `aria-labelledby` or `aria-describedby` are unique.',
  'frame-title':                 'Add a `title` attribute to the `<iframe>` describing its content.',
  'heading-order':               'Ensure heading levels increase by only one at a time (e.g. h1 → h2, not h1 → h3).',
  'html-has-lang':               'Add a `lang` attribute to the `<html>` element (e.g. `<html lang="en">`).',
  'html-lang-valid':             'Ensure the `lang` attribute on `<html>` is a valid BCP 47 language tag.',
  'landmark-one-main':           'Ensure the page has exactly one `<main>` landmark element.',
  'meta-viewport':               'Remove `user-scalable=no` or `maximum-scale` restrictions from the viewport meta tag.',
  'nested-interactive':          'Do not nest interactive elements (e.g. a button inside a link). Each must be independently focusable.',
  'select-name':                 'Add a `<label>` or `aria-label` to associate an accessible name with this `<select>` element.',
  'skip-link':                   'Add a visible skip link as the first focusable element on the page to let keyboard users skip navigation.',
  'svg-img-alt':                 'Add `role="img"` and a `<title>` element (or `aria-label`) to SVGs that convey meaning.',
  'td-headers-attr':             'Ensure all `headers` attributes on `<td>` elements reference valid `<th>` `id` values.',
  'th-has-data-cells':           'Ensure each `<th>` has associated data cells, or use `scope` to define the relationship.',
  'video-caption':               'Add captions to the `<video>` element using a `<track kind="captions">` element.',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wcagInfo(tags) {
  for (const tag of (tags || [])) {
    if (WCAG_TAGS[tag]) return WCAG_TAGS[tag];
  }
  return { label: '—', url: null };
}

function impactBadge(impact) {
  return `${IMPACT_EMOJI[impact] || '⚪'} **${impact}**`;
}

function delta(a, b) {
  const n = (b || 0) - (a || 0);
  if (n === 0) return '—';
  return n > 0 ? `+${n} ⬆️` : `${n} ⬇️`;
}

function escapeHtml(str) {
  return (str || '').replace(/`/g, "'");
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// ─── Detailed violation block ─────────────────────────────────────────────────

function buildViolationDetail(v, index) {
  const wcag   = wcagInfo(v.tags);
  const hint   = FIX_HINTS[v.id] || null;
  const wcagLink = wcag.url ? `[${wcag.label}](${wcag.url})` : wcag.label;

  // Each violation can have multiple failing nodes (multiple elements on the page)
  const nodeBlocks = (v.nodes || [v]).map((node, i) => {
    const selector = (node.target || []).join(' > ');
    const html     = escapeHtml(truncate(node.html, 300));
    const summary  = (node.failureSummary || '')
      .replace(/^Fix (any|all) of the following:\s*/i, '')
      .trim();

    // Format each individual fix suggestion as its own bullet
    const fixLines = summary
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => `  - ${l}`)
      .join('\n');

    return `**Failing element ${v.nodes && v.nodes.length > 1 ? `${i + 1} of ${v.nodes.length}` : ''}**

| Field | Value |
|-------|-------|
| Selector | \`${selector}\` |
| HTML | \`${html}\` |

**What to fix:**
${fixLines || '  - See documentation link below.'}
`;
  }).join('\n---\n');

  return `<details>
<summary>${IMPACT_EMOJI[v.impact] || '⚪'} <strong>${v.id}</strong> — ${v.description} &nbsp;|&nbsp; ${wcag.label} &nbsp;|&nbsp; <code>${v.urlPath}</code></summary>

### Rule: \`${v.id}\`

| | |
|---|---|
| **Impact** | ${impactBadge(v.impact)} |
| **Standard** | ${wcagLink} |
| **Page** | \`${v.urlPath}\` |
| **Rule docs** | [View on Deque University](${v.helpUrl}) |
${hint ? `| **Fix guidance** | ${hint} |` : ''}

### Failing elements

${nodeBlocks}

</details>`;
}

// ─── Full comment builder ─────────────────────────────────────────────────────

function buildComment(diff) {
  const { summary, newViolations, resolvedViolations, unchangedViolations, impactDelta, regression } = diff;

  const statusHeader = regression
    ? `## Accessibility Check — Regressions Found`
    : `## Accessibility Check — No Regressions`;

  const existingCount = (unchangedViolations || []).length;
  const statusLine = regression
    ? `> **This PR introduced ${summary.newViolations} new accessibility violation(s).** Review the details below and resolve them before merging.`
    : existingCount > 0
      ? `> No new violations were introduced. However, **${existingCount} pre-existing violation(s)** remain on this branch — they are not blocking this PR but are worth addressing over time.`
      : `> No accessibility violations were introduced by this PR.`;

  const summaryTable = `
| | Baseline | This PR | Delta |
|---|:---:|:---:|:---:|
| Total violations | ${summary.baselineTotal} | ${summary.headTotal} | ${summary.headTotal - summary.baselineTotal >= 0 ? '+' : ''}${summary.headTotal - summary.baselineTotal} |
| 🔴 Critical | ${impactDelta.baseline.critical || 0} | ${impactDelta.head.critical || 0} | ${delta(impactDelta.baseline.critical, impactDelta.head.critical)} |
| 🟠 Serious  | ${impactDelta.baseline.serious  || 0} | ${impactDelta.head.serious  || 0} | ${delta(impactDelta.baseline.serious,  impactDelta.head.serious)}  |
| 🟡 Moderate | ${impactDelta.baseline.moderate || 0} | ${impactDelta.head.moderate || 0} | ${delta(impactDelta.baseline.moderate, impactDelta.head.moderate)} |
| 🔵 Minor    | ${impactDelta.baseline.minor    || 0} | ${impactDelta.head.minor    || 0} | ${delta(impactDelta.baseline.minor,    impactDelta.head.minor)}    |
| ✅ Resolved  | — | — | -${summary.resolvedViolations} |
`;

  // ── New violations ──────────────────────────────────────────────────────────
  let newSection = '';
  if (newViolations.length > 0) {
    // Quick-reference table at the top
    const quickRows = newViolations.map((v) => {
      const selector = (v.target || []).join(' > ');
      const wcag     = wcagInfo(v.tags);
      const wcagCell = wcag.url ? `[${wcag.label}](${wcag.url})` : wcag.label;
      return `| ${IMPACT_EMOJI[v.impact] || '⚪'} ${v.impact} | \`${v.id}\` | ${wcagCell} | \`${v.urlPath}\` | \`${truncate(selector, 60)}\` | [Docs](${v.helpUrl}) |`;
    }).join('\n');

    // Detailed expandable block per violation
    const detailBlocks = newViolations.map((v, i) => buildViolationDetail(v, i)).join('\n\n');

    newSection = `
### New Violations (${newViolations.length})

These violations were **not present on the base branch** and were introduced by this PR.

| Impact | Rule | Standard | Page | Selector | Docs |
|--------|------|----------|------|----------|------|
${quickRows}

---

### Detailed Breakdown

${detailBlocks}
`;
  }

  // ── Resolved violations ─────────────────────────────────────────────────────
  let resolvedSection = '';
  if (resolvedViolations.length > 0) {
    const rows = resolvedViolations.map((v) => {
      const wcag = wcagInfo(v.tags);
      const wcagCell = wcag.url ? `[${wcag.label}](${wcag.url})` : wcag.label;
      return `| ${IMPACT_EMOJI[v.impact] || '⚪'} ${v.impact} | \`${v.id}\` | ${wcagCell} | \`${v.urlPath}\` | [Docs](${v.helpUrl}) |`;
    }).join('\n');

    resolvedSection = `
### Resolved Violations (${resolvedViolations.length})

This PR fixed the following accessibility issues:

| Impact | Rule | Standard | Page | Docs |
|--------|------|----------|------|------|
${rows}
`;
  }

  // ── Existing (unchanged) violations ────────────────────────────────────────
  let existingSection = '';
  const existing = unchangedViolations || [];
  if (existing.length > 0 && !regression) {
    const detailBlocks = existing.map((v, i) => buildViolationDetail(v, i)).join('\n\n');

    existingSection = `
---

### Pre-existing Violations (${existing.length})

These violations existed before this PR and are **not caused by this change**. They are shown here for visibility and are not blocking the merge.

${detailBlocks}
`;
  }

  // ── Report-only note ────────────────────────────────────────────────────────
  const modeNote = (!FAIL_ON_REGRESSION && regression)
    ? `\n> **Report-only mode** — regressions were found but the check was not failed.\n`
    : '';

  const footer = `
---
<sub>Generated by [a11y-diff](https://github.com/your-org/a11y-diff-action) · ${diff.generatedAt} · <a href="https://dequeuniversity.com/rules/axe/">axe rules reference</a></sub>
`;

  return [statusHeader, statusLine, modeNote, summaryTable, newSection, resolvedSection, existingSection, footer]
    .filter(Boolean)
    .join('\n');
}

// ─── GitHub API ───────────────────────────────────────────────────────────────

function githubRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path:     urlPath,
      method,
      headers: {
        Authorization:  `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent':   'a11y-diff-action',
        Accept:         'application/vnd.github.v3+json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let buf = '';
      res.on('data', (chunk) => (buf += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(buf || '{}'));
        } else {
          reject(new Error(`GitHub API ${res.statusCode}: ${buf}`));
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function deleteExistingComments() {
  const comments = await githubRequest('GET', `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`);
  for (const comment of comments) {
    if (comment.body && comment.body.includes('Accessibility Check')) {
      await githubRequest('DELETE', `/repos/${owner}/${repo}/issues/comments/${comment.id}`);
      console.log(`  Deleted previous a11y comment ${comment.id}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\na11y-diff posting comment');
  console.log(`   diff file         : ${diffFile}`);
  console.log(`   repository        : ${GITHUB_REPOSITORY}`);
  console.log(`   PR number         : ${PR_NUMBER}`);
  console.log(`   fail on regression: ${FAIL_ON_REGRESSION}\n`);

  const diff = JSON.parse(fs.readFileSync(diffFile, 'utf8'));
  const body = buildComment(diff);

  await deleteExistingComments();
  const posted = await githubRequest('POST', `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, { body });
  console.log(`Comment posted: ${posted.html_url}`);

  if (diff.regression && FAIL_ON_REGRESSION) {
    console.error(`\nFailing check — ${diff.summary.newViolations} accessibility regression(s).`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('\nFatal comment error:', err.message);
  process.exit(1);
});
