from selenium import webdriver
from axe_selenium_python import Axe
import sys

options = webdriver.ChromeOptions()
options.add_argument("--headless")
options.add_argument("--no-sandbox")
options.add_argument("--disable-dev-shm-usage")
driver = webdriver.Chrome(options=options)

# Change port if your app runs somewhere else
driver.get("http://localhost:3000")

# Initialize axe and run accessibility checks
axe = Axe(driver)
axe.inject()
results = axe.run()
axe.write_results(results, 'axe-results.json')

# Extract the violations from the results
violations = results['violations']

if violations:
    # Print the number of violations and details about each violation
    print(f"Found {len(violations)} accessibility violations")
    for v in violations:
        print(v['help'], v['impact'])
        # Print the target elements that caused the violation
        for node in v['nodes']:
            print("  Target:", node['target'])
axe.write_results(results, 'axe-results.json')
driver.quit()
if violations:
    print("Would exit potentially")
    # sys.exit(1)


import requests 
import json
import os

#call this function with the text of the violations to get a summary from OpenRouter
def get_ai_summary(violations_text):
    """Calls OpenRouter to summarize violations into 2 paragraphs."""
    url = "https://openrouter.ai/api/v1/chat/completions"
    api_key = os.getenv("OPENROUTER_API_KEY") # Ensure this is set in your environment
    
    prompt = (
        "You are an accessibility expert. I will provide a list of axe-core violations. "
        "Please provide a 2-paragraph summary. The first paragraph should explain the "
        "major themes of the errors found. The second paragraph should provide actionable "
        "advice for the developer to fix them according to WCAG standards.\n\n"
        f"Violations:\n{violations_text}"
    )

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-Title": "Axe-Core-Summarizer"
    }

    data = {
        "model": "google/gemini-2.0-flash-lite-preview-02-05:free",
        "messages": [{"role": "user", "content": prompt}]
    }

    try:
        response = requests.post(url, headers=headers, data=json.dumps(data))
        response.raise_for_status()
        return response.json()['choices'][0]['message']['content']
    except Exception as e:
        return f"Could not generate AI summary: {str(e)}"