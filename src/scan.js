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

// Scan a single page at a given URL path.
async function scanPage(page, urlPath) {
  const fullUrl = `${baseUrl}${urlPath}`;
  console.log(`INFO: Scanning ${fullUrl}`);

  // Navigate and wait for DOM to be ready
  await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
  if (waitIdle) {
    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch {
      // keep scanning even if the page never reaches networkidle
      console.warn(`  WARN: networkidle timeout on ${urlPath}, continuing`);
    }
  }
  if (extraWaitMs > 0) {
    await page.waitForTimeout(extraWaitMs);
  }

  // Build an axe scan for the current Playwright page.
  // A new builder each time to ensure no state leaks between scans.
  let builder = new AxeBuilder({ page });

  // If the user provided ignore rules, disable them in the axe scan.
  if (ignoreRules.length > 0) {
    builder = builder.disableRules(ignoreRules);
  }
  const results = await builder.analyze();
  
  // Filter violations by severity threshold
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

/*
 * CLI entry point.
 * Iterates through all URL paths, scans them one-by-one, writes a report JSON file,
 * and exits with code 1 if any page fails to scan.
 */
async function main() {
  console.log('\nRESULTS: a11y-diff scanner');
  console.log(`   baseUrl      : ${baseUrl}`);
  console.log(`   output       : ${outputFile}`);
  console.log(`   urls         : ${urls.join(', ')}`);
  console.log(`   ignoreRules  : ${ignoreRules.join(', ') || '(none)'}`);
  console.log(`   minImpact    : ${impactLevel}\n`);

  // Launch Chromium in headless mode
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext();
  const pages = [];
  const errors = [];

  // Scan sequentially to keep output deterministic and avoid overloading the target.
  // (Parallel scanning could be added later!)
  for (const urlPath of urls) {
    const page = await context.newPage();
    try {
      const result = await scanPage(page, urlPath);
      pages.push(result);
      console.log(` SUCCESS: ${urlPath} — ${result.violations.length} violation(s) found`);
    } catch (err) {
      // Record error and continue scanning other pages.
      console.error(`FAILURE: Error scanning ${urlPath}: ${err.message}`);
      errors.push({ urlPath, error: err.message });
    } finally {
      await page.close();
    }
  }
  await browser.close();
  
  // Final report payload
  const output = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    impactLevel,
    pages,
    errors,
  };

  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`\nSUCCESS:Scan complete: ${outputFile}`);
  
  if (errors.length > 0) {
    console.error(`\nFAILURE: ${errors.length} page(s) failed to scan.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nFAILURE: Fatal scan error:', err.message);
  process.exit(1);
});
