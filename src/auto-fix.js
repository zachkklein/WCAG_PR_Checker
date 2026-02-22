'use strict';

const fs       = require('fs');
const https    = require('https');
const path     = require('path');
const minimist = require('minimist');

const args = minimist(process.argv.slice(2));
const DIFF_FILE       = args.diff || '/tmp/a11y_diff.json';
const PR_PROJECT_PATH = process.env.PR_PROJECT_PATH || '.';
const MODEL_ID        = args.model || 'google/gemini-2.0-flash-001';

// Get AI Key and Github info
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GITHUB_TOKEN       = process.env.GITHUB_TOKEN;
const PR_NUMBER          = process.env.PR_NUMBER;
const GITHUB_REPOSITORY  = process.env.GITHUB_REPOSITORY;

const IMPACT_EMOJI   = { critical: '🔴', serious: '🟠', moderate: '🟡', minor: '🔵' };
const AI_FIX_MARKER  = '';

/**
 * Dynamically resolves a URL path to a physical file on disk.
 * Supports standard static builds and Next.js internal structures.
 */
function resolveUrlToFile(urlPath, projectRoot) {
    // 1. Normalize the path (remove domain if it exists)
    let pathname;
    try {
        pathname = new URL(urlPath, 'http://localhost').pathname;
    } catch (e) {
        pathname = urlPath;
    }

    // 2. Map '/' to 'index.html'
    if (pathname === '/' || pathname === '') {
        const rootIndex = path.join(projectRoot, 'index.html');
        return fs.existsSync(rootIndex) ? rootIndex : null;
    }

    const cleanPath = pathname.startsWith('/') ? pathname.slice(1) : pathname;

    // 3. Define the search order (Standard -> Next.js App -> Next.js Pages)
    const searchPaths = [
        path.join(projectRoot, cleanPath),
        path.join(projectRoot, `${cleanPath}.html`),
        path.join(projectRoot, cleanPath, 'index.html'),
        // Next.js internal build locations
        path.join(projectRoot, '.next/server/app', `${cleanPath}.html`),
        path.join(projectRoot, '.next/server/app', cleanPath, 'index.html'),
        path.join(projectRoot, '.next/server/pages', `${cleanPath}.html`),
        path.join(projectRoot, '.next/server/pages', cleanPath, 'index.html')
    ];

    for (const testPath of searchPaths) {
        if (fs.existsSync(testPath) && fs.lstatSync(testPath).isFile()) {
            return testPath;
        }
    }

    return null;
}

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
    - Return the complete file content exactly as it should be written to disk`;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/zachkklein/WCAG_PR_Checker",
            "X-Title": "a11yGuard-Bot"
        },
        body: JSON.stringify({
            model: MODEL_ID,
            messages: [{ role: "user", content: prompt }]
        })
    });

    const data = await response.json();

    if (!response.ok) {
        const apiError = data.error?.message || JSON.stringify(data);
        throw new Error(`OpenRouter API error (HTTP ${response.status}): ${apiError}`);
    }

    if (!data.choices || data.choices.length === 0) {
        throw new Error("OpenRouter returned success but no choices were found in the response.");
    }

    // Strip Markdown code blocks if the AI ignored instructions and included them
    let code = data.choices[0].message.content.trim();
    if (code.startsWith('```')) {
        code = code.replace(/^```[a-z]*\n/i, '').replace(/\n```$/g, '');
    }
    
    return code;
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

async function deleteExistingAIFixComments(owner, repo) {
    try {
        const comments = await githubRequest('GET', `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`);
        for (const comment of comments) {
            if (comment.body && comment.body.includes(AI_FIX_MARKER)) {
                await githubRequest('DELETE', `/repos/${owner}/${repo}/issues/comments/${comment.id}`);
                console.log(`  Deleted previous AI fix comment ${comment.id}`);
            }
        }
    } catch (e) {
        console.warn('Could not delete old comments:', e.message);
    }
}

function buildFixSummaryComment(fixedFiles, skippedUrls) {
    const rows = fixedFiles.flatMap(({ filePath, violations }) =>
        violations.map(v =>
            `| ${IMPACT_EMOJI[v.impact] || '⚪'} ${v.impact} | \`${v.id}\` | \`${(v.target || []).join(' > ')}\` | \`${v.urlPath}\` |`
        )
    ).join('\n');

    const skippedSection = skippedUrls.length > 0
        ? `\n> **Skipped** (no local file mapping found): ${skippedUrls.map(u => `\`${u}\``).join(', ')}\n`
        : '';

    return `${AI_FIX_MARKER}
## INFO: AI Accessibility Auto-Fix Summary

The AI has automatically generated patches for the following violations and committed them to this branch.

| Impact | Rule | Selector | Page |
|--------|------|----------|------|
${rows}
${skippedSection}
**Files modified:** ${fixedFiles.map(f => `\`${f.filePath}\``).join(', ')}

> **Note:** Re-run the accessibility check to confirm all violations are resolved.

---
<sub>Generated by <a href="[https://github.com/zachkklein/WCAG_PR_Checker](https://github.com/zachkklein/WCAG_PR_Checker)">a11yGuard</a></sub>`;
}

async main() {
    if (!OPENROUTER_API_KEY) {
        console.error('FAILURE: OPENROUTER_API_KEY is not set. Skipping AI auto-fix.');
        return;
    }

    if (!fs.existsSync(DIFF_FILE)) {
        console.log('No diff file found. Skipping.');
        return;
    }
    
    const diff = JSON.parse(fs.readFileSync(DIFF_FILE, 'utf8'));

    // If the diff logic uses "regression" as a boolean
    if (!diff.regression && (!diff.newViolations || diff.newViolations.length === 0)) {
        console.log('SUCCESS: No new violations detected.');
        return;
    }

    const newViolations = diff.newViolations || [];
    const pagesToFix    = [...new Set(newViolations.map(v => v.urlPath))];

    const fixedFiles  = [];
    const skippedUrls = [];

    for (const urlPath of pagesToFix) {
        const filePath = resolveUrlToFile(urlPath, PR_PROJECT_PATH);

        if (!filePath) {
            console.warn(`WARN: No file mapping found for URL: ${urlPath}`);
            skippedUrls.push(urlPath);
            continue;
        }
        
        console.log(`INFO: AI is fixing ${urlPath} (File: ${filePath})...`);
        const pageViolations = newViolations.filter(v => v.urlPath === urlPath);
        
        try {
            const fixedCode = await fixFileWithAI(filePath, pageViolations);
            fs.writeFileSync(filePath, fixedCode);
            console.log(`SUCCESS: Successfully updated ${filePath}`);
            fixedFiles.push({ filePath, violations: pageViolations });
        } catch (err) {
            console.error(`FAILURE: Failed to fix ${filePath}:`, err.message);
        }
    }

    if (fixedFiles.length === 0) {
        console.log('No files were successfully fixed.');
        return;
    }

    if (!GITHUB_TOKEN || !PR_NUMBER || !GITHUB_REPOSITORY) {
        console.warn('Missing GitHub metadata — skipping PR comment.');
        return;
    }

    const [owner, repo] = GITHUB_REPOSITORY.split('/');
    await deleteExistingAIFixComments(owner, repo);

    const body   = buildFixSummaryComment(fixedFiles, skippedUrls);
    try {
        const posted = await githubRequest('POST', `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, { body });
        console.log(`SUCCESS: AI fix summary posted: ${posted.html_url}`);
    } catch (e) {
        console.error('Failed to post comment to GitHub:', e.message);
    }
}

main().catch(err => {
    console.error('Fatal error in auto-fixer:', err);
    process.exit(1);
});