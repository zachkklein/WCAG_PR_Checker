'use strict';

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DIFF_FILE = 'diff.json';

// Mapping URLs to local file paths (Standard for most Hackathon projects)
// Adjust these to match your project structure!
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
    Rewrite the code to fix these specific violations while maintaining the exact same functionality and style.
    ONLY output the new code. Do not include explanations, markdown formatting, or backticks.`;

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
    return data.choices[0].message.content.trim();
}

async function main() {
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
        const filePath = URL_TO_FILE_MAP[urlPath];
        if (!filePath || !fs.existsSync(filePath)) {
            console.warn(`⚠️ Could not find local file for ${urlPath}`);
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
