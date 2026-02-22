'use strict';

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

const args = minimist(process.argv.slice(2));
const DIFF_FILE = args.diff || '/tmp/a11y_diff.json';
const PR_PROJECT_PATH = process.env.PR_PROJECT_PATH || '.';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Mapping URL paths (from scan) to local file paths relative to PR_PROJECT_PATH.
// Adjust to match your project (e.g. add /pricing -> pricing.html).
const URL_TO_FILE_MAP = {
    '/': 'index.html',
    '/about': 'about.html',
    '/contact': 'contact.html'
};

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

async function main() {
    if (!OPENROUTER_API_KEY) {
        console.error('❌ OPENROUTER_API_KEY is not set. Skipping AI auto-fix.');
        console.error('   Add it as a repository secret: Settings → Secrets → Actions → New repository secret.');
        return;
    }

    if (!fs.existsSync(DIFF_FILE)) return;
    const diff = JSON.parse(fs.readFileSync(DIFF_FILE, 'utf8'));
    
    if (!diff.regression) {
        console.log("✅ No new violations to fix.");
        return;
    }

    // Group violations by page
    const newViolations = diff.newViolations;
    const pagesToFix = [...new Set(newViolations.map(v => v.urlPath))];

    for (const urlPath of pagesToFix) {
        const relativePath = URL_TO_FILE_MAP[urlPath];
        if (!relativePath) {
            console.warn(`⚠️ No file mapping for URL ${urlPath}`);
            continue;
        }
        const filePath = path.join(PR_PROJECT_PATH, relativePath);
        if (!fs.existsSync(filePath)) {
            console.warn(`⚠️ Could not find local file for ${urlPath} at ${filePath}`);
            continue;
        }

        console.log(`🤖 AI is fixing ${filePath}...`);
        const pageViolations = newViolations.filter(v => v.urlPath === urlPath);

        try {
            const fixedCode = await fixFileWithAI(filePath, pageViolations);
            fs.writeFileSync(filePath, fixedCode);
            console.log(`✨ Successfully updated ${filePath}`);
        } catch (err) {
            console.error(`❌ Failed to fix ${filePath}:`, err);
        }
    }
}

main();
