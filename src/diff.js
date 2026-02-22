/**
 * diff.js
 * Compares two axe scan JSON files (baseline vs PR head) and outputs a diff.
 * A violation is matched by: rule id + page urlPath + CSS selector + SHA-1 of HTML content.
 *
 * Usage:
 *   node diff.js --baseline baseline.json --head pr.json --output diff.json
 *
 * Exit codes:
 *   0 — no regressions
 *   1 — regressions detected
 */

'use strict';

const fs     = require('fs');
const crypto = require('crypto');
const minimist = require('minimist');

const args = minimist(process.argv.slice(2));
const baselineFile = args.baseline;
const headFile     = args.head;
const outputFile   = args.output || 'diff.json';

if (!baselineFile || !headFile) {
  console.error('Usage: node diff.js --baseline <file> --head <file> [--output <file>]');
  process.exit(1);
}

/**
 * Build a stable fingerprint for a single violation node.
 * Format: "ruleId::urlPath::selector1>selector2::sha1(html)"
 *
 * - urlPath is included so the same broken element on two different pages
 *   is never treated as the same violation.
 * - SHA-1 of the actual HTML content (not just its length) prevents false
 *   matches between different elements that happen to have markup of equal
 *   length, which was the root cause of phantom recurring violations.
 */
function fingerprint(violationId, urlPath, node) {
  const target  = node.target.join('>');
  const htmlHash = crypto
    .createHash('sha1')
    .update(node.html || '')
    .digest('hex')
    .slice(0, 12);
  return `${violationId}::${urlPath}::${target}::${htmlHash}`;
}

/**
 * Flatten all pages in a scan result into a single Map of:
 *   fingerprint → violation metadata
 */
function buildFingerprintMap(scanResult) {
  const map = new Map();

  for (const page of scanResult.pages) {
    for (const violation of page.violations) {
      for (const node of violation.nodes) {
        const fp = fingerprint(violation.id, page.urlPath, node);
        // If two nodes produce the same fingerprint (genuine duplicates), keep
        // the first one — the Map.set below would overwrite, so we guard here.
        if (map.has(fp)) continue;
        map.set(fp, {
          id:             violation.id,
          impact:         violation.impact,
          description:    violation.description,
          helpUrl:        violation.helpUrl,
          tags:           violation.tags || [],
          urlPath:        page.urlPath,
          target:         node.target,
          html:           node.html,
          failureSummary: node.failureSummary,
          fingerprint:    fp,
        });
      }
    }
  }

  return map;
}

function countByImpact(map) {
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of map.values()) {
    if (counts[v.impact] !== undefined) counts[v.impact]++;
    else counts[v.impact] = 1;
  }
  return counts;
}

function main() {
  console.log('\n📊 a11y-diff diffing');
  console.log(`   baseline : ${baselineFile}`);
  console.log(`   head     : ${headFile}`);
  console.log(`   output   : ${outputFile}\n`);

  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const head     = JSON.parse(fs.readFileSync(headFile, 'utf8'));

  const baselineMap = buildFingerprintMap(baseline);
  const headMap     = buildFingerprintMap(head);

  const newViolations = [];
  for (const [fp, v] of headMap) {
    if (!baselineMap.has(fp)) newViolations.push(v);
  }

  const resolvedViolations = [];
  for (const [fp, v] of baselineMap) {
    if (!headMap.has(fp)) resolvedViolations.push(v);
  }

  const unchangedViolations = [...headMap.entries()]
    .filter(([fp]) => baselineMap.has(fp))
    .map(([, v]) => v);
  const unchangedCount = unchangedViolations.length;
  const regression     = newViolations.length > 0;

  const diff = {
    generatedAt: new Date().toISOString(),
    regression,
    summary: {
      baselineTotal:      baselineMap.size,
      headTotal:          headMap.size,
      newViolations:      newViolations.length,
      resolvedViolations: resolvedViolations.length,
      unchanged:          unchangedCount,
    },
    impactDelta: {
      baseline: countByImpact(baselineMap),
      head:     countByImpact(headMap),
    },
    newViolations,
    resolvedViolations,
    unchangedViolations,
  };

  fs.writeFileSync(outputFile, JSON.stringify(diff, null, 2));

  console.log(`  Baseline violations : ${baselineMap.size}`);
  console.log(`  Head violations     : ${headMap.size}`);
  console.log(`  New (regressions)   : ${newViolations.length}`);
  console.log(`  Resolved            : ${resolvedViolations.length}`);
  console.log(`  Unchanged           : ${unchangedCount}`);

  if (regression) {
    console.error(`\n❌ REGRESSION — ${newViolations.length} new accessibility violation(s)\n`);
    for (const v of newViolations) {
      console.error(`  [${v.impact.toUpperCase()}] ${v.id} on ${v.urlPath}`);
      console.error(`    Selector : ${v.target.join(' > ')}`);
      console.error(`    Summary  : ${v.failureSummary}`);
      console.error(`    Help     : ${v.helpUrl}\n`);
    }
    process.exit(1);
  }

  console.log('\n✅ No regressions detected.');
  process.exit(0);
}

main();
