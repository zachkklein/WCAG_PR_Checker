/**
 * scan.js
 * Launches a headless Playwright browser, scans each URL with axe-core,
 * and writes structured JSON output.
 *
 * All config comes from CLI args — no config.json dependency.
 *
 * Usage:
 *   node scan.js \
 *     --baseUrl http://localhost:3000 \
 *     --output baseline.json \
 *     --urls "/,/about,/dashboard" \
 *     --ignore "duplicate-id,color-contrast" \
 *     --impactLevel "moderate" \
 *     --waitForNetworkIdle "true" \
 *     --extraWaitMs "500"
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const minimist = require('minimist');

const IMPACT_ORDER = ['minor', 'moderate', 'serious', 'critical'];

const args = minimist(process.argv.slice(2));

const baseUrl       = (args.baseUrl || 'http://localhost:3000').replace(/\/$/, '');
const outputFile    = args.output || 'scan-output.json';
const urls          = (args.urls || '/').split(',').map((u) => u.trim()).filter(Boolean);
const ignoreRules   = (args.ignore || '').split(',').map((r) => r.trim()).filter(Boolean);
const impactLevel   = args.impactLevel || 'moderate';
const waitIdle      = args.waitForNetworkIdle !== 'false';
const extraWaitMs   = parseInt(args.extraWaitMs || '500', 10);

const minImpactIdx  = IMPACT_ORDER.indexOf(impactLevel);

function meetsImpactThreshold(impact) {
  return IMPACT_ORDER.indexOf(impact) >= minImpactIdx;
}

async function scanPage(page, urlPath) {
  const fullUrl = `${baseUrl}${urlPath}`;
  console.log(`  → Scanning ${fullUrl}`);

  await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });

  if (waitIdle) {
    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch {
      console.warn(`  ⚠ networkidle timeout on ${urlPath}, continuing`);
    }
  }

  if (extraWaitMs > 0) {
    await page.waitForTimeout(extraWaitMs);
  }

  let builder = new AxeBuilder({ page });

  if (ignoreRules.length > 0) {
    builder = builder.disableRules(ignoreRules);
  }

  const results = await builder.analyze();

  // Filter violations to only those meeting the impact threshold
  const violations = results.violations.filter((v) =>
    meetsImpactThreshold(v.impact)
  );

  return {
    urlPath,
    fullUrl,
    violations,
    passCount: results.passes.length,
    incompleteCount: results.incomplete.length,
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  console.log('\n🔍 a11y-diff scanner');
  console.log(`   baseUrl      : ${baseUrl}`);
  console.log(`   output       : ${outputFile}`);
  console.log(`   urls         : ${urls.join(', ')}`);
  console.log(`   ignoreRules  : ${ignoreRules.join(', ') || '(none)'}`);
  console.log(`   minImpact    : ${impactLevel}\n`);

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  const pages = [];
  const errors = [];

  for (const urlPath of urls) {
    try {
      const result = await scanPage(page, urlPath);
      pages.push(result);
      console.log(`  ✓ ${urlPath} — ${result.violations.length} violation(s) found`);
    } catch (err) {
      console.error(`  ✗ Error scanning ${urlPath}: ${err.message}`);
      errors.push({ urlPath, error: err.message });
    }
  }

  await browser.close();

  const output = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    impactLevel,
    pages,
    errors,
  };

  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`\n✅ Scan complete → ${outputFile}`);

  if (errors.length > 0) {
    console.error(`\n❌ ${errors.length} page(s) failed to scan.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n💥 Fatal scan error:', err.message);
  process.exit(1);
});
