// playwright_axe.js
const { chromium } = require('playwright');

const URL = 'http://localhost:3000';

async function runAxe(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
  });

  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });

  // Inject axe-core
  await page.addScriptTag({
    url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.9.1/axe.min.js',
  });

  // Run axe (all rules; remove runOnly to run everything)
  const results = await page.evaluate(async () => {
    return await axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa'], // Level A + AA only; delete runOnly to run all rules
      },
    });
  });

  await browser.close();

  const violations = results.violations;

  if (violations.length > 0) {
    const totalNodes = violations.reduce((n, v) => n + v.nodes.length, 0);
    console.log('\nAccessibility violations (' + totalNodes + ' problem' + (totalNodes === 1 ? '' : 's') + ')\n');

    violations.forEach((v) => {
      console.log( v.id + ' — ' + v.help);
      v.nodes.forEach((node) => {
        const hrefMatch = node.html.match(/href=["']([^"']+)["']/);
        const where = hrefMatch ? hrefMatch[1] : node.html.replace(/\s+/g, ' ').slice(0, 60) + (node.html.length > 60 ? '...' : '');
        console.log('  • ' + where);
      });
      console.log('');
    });
    process.exit(1);
  } else {
    console.log('No accessibility violations found.');
    process.exit(0);
  }
}

runAxe(URL).catch((err) => {
  console.error(err);
  process.exit(1);
});
