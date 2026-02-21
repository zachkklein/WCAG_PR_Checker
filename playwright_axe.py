# playwright_axe.py
import asyncio
from playwright.async_api import async_playwright

URL = "http://localhost:3000"

async def run_axe(url: str):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = await browser.new_page()

        await page.goto(url, wait_until="networkidle")

        # Inject axe-core
        await page.add_script_tag(
            await page.add_script_tag(url="https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.9.1/axe.min.js")
        )

        # Run axe
        results = await page.evaluate("""
            async () => {
                return await axe.run(document, {
                    runOnly: {
                        type: 'tag',
                        values: ['wcag2a', 'wcag2aa']
                    }
                });
            }
        """)

        await browser.close()

        violations = results["violations"]

        if violations:
            print(f"Found {len(violations)} accessibility violations\n")
            for v in violations:
                print(f"Rule: {v['id']}")
                print(f"Description: {v['help']}")
                print(f"Impact: {v['impact']}")
                for node in v["nodes"]:
                    print(f"  Target: {node['target']}")
                    print(f"  HTML: {node['html']}")
                print("---")
            raise SystemExit(1)
        else:
            print("No accessibility violations found ✅")
            raise SystemExit(0)

asyncio.run(run_axe(URL))