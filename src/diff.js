/**
 * diff.js
 * Compares two axe scan JSON files (baseline vs PR head) and outputs a diff.
 * A violation is matched by: rule id + CSS selector target + HTML length.
 *
 * Usage:
 *   node diff.js --baseline baseline.json --head pr.json --output diff.json
 *
 * Exit codes:
 *   0 — no regressions
 *   1 — regressions detected
 */

'use strict';

const fs = require('fs');
const minimist = require('minimist');

// Parse CLI flags like --baseline, --head, and optional --output.
const args = minimist(process.argv.slice(2));
const baselineFile = args.baseline;
const headFile     = args.head;
const outputFile   = args.output || 'diff.json';

// Require both input files so we always compare baseline vs head consistently.
if (!baselineFile || !headFile) {
  console.error('Usage: node diff.js --baseline <file> --head <file> [--output <file>]');
  process.exit(1);
}

/**
 * Build a stable fingerprint for a single violation node.
 * Format: "ruleId::selector1>selector2::htmlLength"
 * Using HTML length (not content) avoids false positives from minor markup
 * tweaks while still distinguishing between different elements.
 */
function fingerprint(violationId, node) {
  const target = node.target.join('>');
  const htmlLen = (node.html || '').length;
  return `${violationId}::${target}::${htmlLen}`;
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
        const fp = fingerprint(violation.id, node);
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
  // Tally violations by axe impact level for quick baseline vs head comparison.
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of map.values()) {
    // Unknown impacts are still tracked so they don’t disappear from reporting.
    if (counts[v.impact] !== undefined) counts[v.impact]++;
    else counts[v.impact] = 1;
  }
  return counts;
}

function main() {
  // Human-readable console output for CI logs while also writing a machine-readable diff.json.
  console.log('\na11y-diff diffing');
  console.log(`   baseline : ${baselineFile}`);
  console.log(`   head     : ${headFile}`);
  console.log(`   output   : ${outputFile}\n`);

  // Read and parse JSON scan results produced by the axe runner.
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const head     = JSON.parse(fs.readFileSync(headFile, 'utf8'));

  const baselineMap = buildFingerprintMap(baseline);
  const headMap     = buildFingerprintMap(head);

  // New violations are those present in head but not in baseline.
  const newViolations = [];
  for (const [fp, v] of headMap) {
    if (!baselineMap.has(fp)) newViolations.push(v);
  }

  // Resolved violations are those present in baseline but not in head.
  const resolvedViolations = [];
  for (const [fp, v] of baselineMap) {
    if (!headMap.has(fp)) resolvedViolations.push(v);
  }

  // Unchanged violations exist in both scans (use head metadata for display).
  const unchangedViolations = [...headMap.entries()].filter(([fp]) => baselineMap.has(fp)).map(([, v]) => v);
  const unchangedCount = unchangedViolations.length;
  // Regression is strictly defined as “any new violations introduced”.
  const regression     = newViolations.length > 0;

  const diff = {
    generatedAt: new Date().toISOString(),
    regression,
    summary: {
      baselineTotal:     baselineMap.size,
      headTotal:         headMap.size,
      newViolations:     newViolations.length,
      resolvedViolations: resolvedViolations.length,
      unchanged:         unchangedCount,
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

  // Print a quick summary suitable for CI log scanning.
  console.log(`  Baseline violations : ${baselineMap.size}`);
  console.log(`  Head violations     : ${headMap.size}`);
  console.log(`  New (regressions)   : ${newViolations.length}`);
  console.log(`  Resolved            : ${resolvedViolations.length}`);
  console.log(`  Unchanged           : ${unchangedCount}`);

  if (regression) {
    // Non-zero exit makes CI fail so regressions block merges.
    console.error(`\nREGRESSION — ${newViolations.length} new accessibility violation(s)\n`);
    for (const v of newViolations) {
      // Print details per violation so developers can jump straight to fixes.
      console.error(`  [${v.impact.toUpperCase()}] ${v.id} on ${v.urlPath}`);
      console.error(`    Selector : ${v.target.join(' > ')}`);
      console.error(`    Summary  : ${v.failureSummary}`);
      console.error(`    Help     : ${v.helpUrl}\n`);
    }
    process.exit(1);
  }
  // Exit 0 signals “no regressions” even if there are existing baseline issues.
  console.log('\nNo regressions detected.');
  process.exit(0);
}

main();
