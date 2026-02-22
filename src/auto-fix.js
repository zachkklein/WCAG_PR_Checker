'use strict';

const fs       = require('fs');
const https    = require('https');
const path     = require('path');
const minimist = require('minimist');

const args = minimist(process.argv.slice(2));
const DIFF_FILE       = args.diff || '/tmp/a11y_diff.json';
const PR_PROJECT_PATH = process.env.PR_PROJECT_PATH || '.';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GITHUB_TOKEN       = process.env.GITHUB_TOKEN;
const PR_NUMBER          = process.env.PR_NUMBER;
const GITHUB_REPOSITORY  = process.env.GITHUB_REPOSITORY;

// Mapping URL paths (from scan) to local file paths relative to PR_PROJECT_PATH.
// Adjust to match your project (e.g. add /pricing -> pricing.html).
const URL_TO_FILE_MAP = {
    '/': 'index.html',
    '/about': 'about.html',
    '/contact': 'contact.html'
};

const IMPACT_EMOJI   = { critical: '🔴', serious: '🟠', moderate: '🟡', minor: '🔵' };
const AI_FIX_MARKER  = '<!-- a11y-ai-fix -->';

// ── AI call ───────────────────────────────────────────────────────────────────

async function fixFileWithAI(filePath, violations) {
    const originalCode = fs.readFileSync(filePath, 'utf8');

    const prompt = `You are a Senior Accessibility Engineer.
    I have a file with accessibility violations.

    FILE CONTENT:
    ${originalCode}

    VIOLATIONS FOUND BY AXE-CORE:
    ${JSON.stringify(violations, null, 2)}

    TASK:
    Fix these specific violations. ONLY output the new code. Do not include explanations, markdown formatting, or backticks.

    CRITICAL RULES:
    - Do NOT change any text content, links, or visual styling
    - Only add or modify HTML attributes (alt, aria-label, role, etc.) to fix the violations
    - Return the complete file with minimal changes`;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "google/gemini-2.0-flash-lite-preview-02-05:free",
            messages: [{ role: "user", content: prompt }]
        })
    });

    const data = await response.json();

    if (!response.ok || !data.choices || data.choices.length === 0) {
        const apiError = data.error?.message || JSON.stringify(data);
        throw new Error(`OpenRouter API error (HTTP ${response.status}): ${apiError}`);
    }

    return data.choices[0].message.content.trim();
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

function githubRequest(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const options = {
            hostname: 'api.github.com',
            path: urlPath,
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
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(buf || '{}'));
                else reject(new Error(`GitHub API ${res.statusCode}: ${buf}`));
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function deleteExistingAIFixComments(owner, repo) {
    const comments = await githubRequest('GET', `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`);
    for (const comment of comments) {
        if (comment.body && comment.body.includes(AI_FIX_MARKER)) {
            await githubRequest('DELETE', `/repos/${owner}/${repo}/issues/comments/${comment.id}`);
            console.log(`  Deleted previous AI fix comment ${comment.id}`);
        }
    }
}

function buildFixSummaryComment(fixedFiles, skippedUrls) {
    const rows = fixedFiles.flatMap(({ filePath, violations }) =>
        violations.map(v =>
            `| ${IMPACT_EMOJI[v.impact] || '⚪'} ${v.impact} | \`${v.id}\` | \`${(v.target || []).join(' > ')}\` | \`${v.urlPath}\` |`
        )
    ).join('\n');

    const skippedSection = skippedUrls.length > 0
        ? `\n> ⚠️ **Skipped** (no local file mapping): ${skippedUrls.map(u => `\`${u}\``).join(', ')}\n`
        : '';

    return `${AI_FIX_MARKER}
## 🤖 AI Accessibility Auto-Fix Summary

The AI has automatically patched the following violations and committed the changes to this branch.

| Impact | Rule | Selector | Page |
|--------|------|----------|------|
${rows}
${skippedSection}
**Files modified:** ${fixedFiles.map(f => `\`${f.filePath}\``).join(', ')}

> Re-run the accessibility check to confirm all violations are resolved.

---
<sub>Generated by <a href="https://github.com/zachkklein/WCAG_PR_Checker">a11y-diff</a> AI auto-fixer</sub>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    if (!OPENROUTER_API_KEY) {
        console.error('❌ OPENROUTER_API_KEY is not set. Skipping AI auto-fix.');
        console.error('   Add it as a repository secret: Settings → Secrets → Actions → New repository secret.');
        return;
    }

    if (!fs.existsSync(DIFF_FILE)) return;
    const diff = JSON.parse(fs.readFileSync(DIFF_FILE, 'utf8'));

    if (!diff.regression) {
        console.log('✅ No new violations to fix.');
        return;
    }

    const newViolations = diff.newViolations;
    const pagesToFix    = [...new Set(newViolations.map(v => v.urlPath))];

    const fixedFiles  = [];
    const skippedUrls = [];

    for (const urlPath of pagesToFix) {
        const relativePath = URL_TO_FILE_MAP[urlPath];
        if (!relativePath) {
            console.warn(`⚠️ No file mapping for URL ${urlPath}`);
            skippedUrls.push(urlPath);
            continue;
        }
        const filePath = path.join(PR_PROJECT_PATH, relativePath);
        if (!fs.existsSync(filePath)) {
            console.warn(`⚠️ Could not find local file for ${urlPath} at ${filePath}`);
            skippedUrls.push(urlPath);
            continue;
        }

        console.log(`🤖 AI is fixing ${filePath}...`);
        const pageViolations = newViolations.filter(v => v.urlPath === urlPath);

        try {
            const fixedCode = await fixFileWithAI(filePath, pageViolations);
            fs.writeFileSync(filePath, fixedCode);
            console.log(`✨ Successfully updated ${filePath}`);
            fixedFiles.push({ filePath, violations: pageViolations });
        } catch (err) {
            console.error(`❌ Failed to fix ${filePath}:`, err);
        }
    }

    if (fixedFiles.length === 0) {
        console.log('No files were successfully fixed — skipping summary comment.');
        return;
    }

    if (!GITHUB_TOKEN || !PR_NUMBER || !GITHUB_REPOSITORY) {
        console.warn('⚠️ Missing GITHUB_TOKEN / PR_NUMBER / GITHUB_REPOSITORY — skipping summary comment.');
        return;
    }

    const [owner, repo] = GITHUB_REPOSITORY.split('/');
    await deleteExistingAIFixComments(owner, repo);

    const body   = buildFixSummaryComment(fixedFiles, skippedUrls);
    const posted = await githubRequest('POST', `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, { body });
    console.log(`📝 AI fix summary posted: ${posted.html_url}`);
}

main();
