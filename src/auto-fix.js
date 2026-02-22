'use strict';

const fs       = require('fs');
const https    = require('https');
const path     = require('path');
const minimist = require('minimist');

const args = minimist(process.argv.slice(2));
const DIFF_FILE       = args.diff || '/tmp/a11y_diff.json';
const PR_PROJECT_PATH = process.env.PR_PROJECT_PATH || '.';

// Get AI Key and Github info
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GITHUB_TOKEN       = process.env.GITHUB_TOKEN;
const PR_NUMBER          = process.env.PR_NUMBER;
const GITHUB_REPOSITORY  = process.env.GITHUB_REPOSITORY;

/**
 * Dynamically resolves a URL path to a physical file on disk using common
 * web server conventions. Tries three strategies in order:
 *   1. Exact file match         /about.html → about.html
 *   2. Clean URL                /about      → about.html
 *   3. Directory index          /about      → about/index.html
 */
function resolveUrlToFile(urlPath, projectRoot) {
    if (urlPath === '/' || urlPath === '') {
        return path.join(projectRoot, 'index.html');
    }

    const cleanPath = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;

    const candidates = [
        path.join(projectRoot, cleanPath),
        path.join(projectRoot, `${cleanPath}.html`),
        path.join(projectRoot, cleanPath, 'index.html'),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) {
            return candidate;
        }
    }

    return null;
}

const IMPACT_EMOJI   = { critical: '🔴', serious: '🟠', moderate: '🟡', minor: '🔵' };
const AI_FIX_MARKER  = '<!-- a11y-ai-fix -->';

// LLM API Prompt
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

    // Call the API and wait for response 
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "google/gemini-3.1-pro-preview",
            messages: [{ role: "user", content: prompt }]
        })
    });

    const data = await response.json();

    // Verify output is right format
    if (!response.ok || !data.choices || data.choices.length === 0) {
        const apiError = data.error?.message || JSON.stringify(data);
        throw new Error(`OpenRouter API error (HTTP ${response.status}): ${apiError}`);
    }

    return data.choices[0].message.content.trim();
}

// Get the GitHub info and make the request
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

// Clean up any previous AI Comments
async function deleteExistingAIFixComments(owner, repo) {
    const comments = await githubRequest('GET', `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`);
    for (const comment of comments) {
        if (comment.body && comment.body.includes(AI_FIX_MARKER)) {
            await githubRequest('DELETE', `/repos/${owner}/${repo}/issues/comments/${comment.id}`);
            console.log(`  Deleted previous AI fix comment ${comment.id}`);
        }
    }
}

// Report the fixes from the LLM comments
function buildFixSummaryComment(fixedFiles, skippedUrls) {
    const rows = fixedFiles.flatMap(({ filePath, violations }) =>
        violations.map(v =>
            `| ${IMPACT_EMOJI[v.impact] || '⚪'} ${v.impact} | \`${v.id}\` | \`${(v.target || []).join(' > ')}\` | \`${v.urlPath}\` |`
        )
    ).join('\n');

    const skippedSection = skippedUrls.length > 0
        ? `\n> **Skipped** (no local file mapping): ${skippedUrls.map(u => `\`${u}\``).join(', ')}\n`
        : '';

    return `${AI_FIX_MARKER}
## AI Accessibility Auto-Fix Summary

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

// Confirm the LLM API key is existant
async function main() {
    if (!OPENROUTER_API_KEY) {
        console.error('OPENROUTER_API_KEY is not set. Skipping AI auto-fix.');
        console.error('   Add it as a repository secret: Settings → Secrets → Actions → New repository secret.');
        return;
    }

    // Get the error file diff
    if (!fs.existsSync(DIFF_FILE)) return;
    const diff = JSON.parse(fs.readFileSync(DIFF_FILE, 'utf8'));

    if (!diff.regression) {
        console.log('✅ No new violations to fix.');
        return;
    }

    // Get all the new violatoins
    const newViolations = diff.newViolations;
    const pagesToFix    = [...new Set(newViolations.map(v => v.urlPath))];

    const fixedFiles  = [];
    const skippedUrls = [];

    // For each of the pages we need to fix:
    for (const urlPath of pagesToFix) {
        const filePath = resolveUrlToFile(urlPath, PR_PROJECT_PATH);

        if (!filePath) {
            console.warn(`WARNING: No file found for URL ${urlPath} under ${PR_PROJECT_PATH}`);
            skippedUrls.push(urlPath);
            continue;
        }

        // Call the LLM API to fix the code
        console.log(`AI is fixing ${filePath}...`);
        const pageViolations = newViolations.filter(v => v.urlPath === urlPath);
        try {
            const fixedCode = await fixFileWithAI(filePath, pageViolations);
            fs.writeFileSync(filePath, fixedCode);
            console.log(`SUCCESS:Successfully updated ${filePath}`);
            fixedFiles.push({ filePath, violations: pageViolations });
        } catch (err) {
            console.error(`FAILURE: Failed to fix ${filePath}:`, err);
        }
    }

    // If nothing is changed, exit early
    if (fixedFiles.length === 0) {
        console.log('No files were successfully fixed — skipping summary comment.');
        return;
    }

    // Error handle if github info is missing
    if (!GITHUB_TOKEN || !PR_NUMBER || !GITHUB_REPOSITORY) {
        console.warn('Missing GITHUB_TOKEN / PR_NUMBER / GITHUB_REPOSITORY — skipping summary comment.');
        return;
    }

    // Post the AI Summary to the Pull Request
    const [owner, repo] = GITHUB_REPOSITORY.split('/');
    await deleteExistingAIFixComments(owner, repo);

    const body   = buildFixSummaryComment(fixedFiles, skippedUrls);
    const posted = await githubRequest('POST', `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, { body });
    console.log(`AI fix summary posted: ${posted.html_url}`);
}

main();
