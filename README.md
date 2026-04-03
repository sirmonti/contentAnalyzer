# Content Analyzer Extension

![Icon](Logo/Icono128.png)

This project provides a versatile browser extension designed for both **Firefox** and **Chrome**. Its core purpose is to process web content by passing it through various Artificial Intelligence (AI) services. 

Unlike typical web page summarizers, this extension allows you to create **multiple custom AI services**, each with a highly specific prompt that dictates exactly what the AI should do with the collected information. You can use it to extract code, translate specific terms, analyze sentiment, generate targeted reports, and much more.

## Key Features

*   **Custom Content Capture**: You can easily select a specific part of a web page using an interactive "hover tool", or opt to capture the entire page content.
*   **Multiple Custom AI Prompts**: Create different services tailored to your exact needs (e.g., "Summarize article", "Extract JSON data", "Translate to Spanish", etc.).
*   **Domain-Specific Servicing**: You can link your custom services to specific web domains. This helps keep your extension clean by only showing relevant AI tools (e.g., a "Code Review" service that only activates when you browse github.com or stackoverflow.com).
*   **Widespread LLM Compatibility**: Fully supports connections (including text streaming) with local servers via **Ollama**, as well as cloud API providers like **OpenAI**, **Anthropic**, and **Google Gemini**.

---

## Prompt Dynamic Tags

To make your AI prompts more contextual and powerful, you can utilize the following dynamic tags. The extension will automatically substitute them before sending the prompt to the AI model:

*   `{DATE}`: Replaced by the current date in your local format.
*   `{HOUR}`: Replaced by the current time in your local format.
*   `{URL}`: The complete URL of the web page currently being processed.
*   `{DOMAIN}`: The root domain of the web page being processed.
*   `{LANG}`: The language of the web page. Note: This relies on the page's HTML `<html lang="...">` declaration; the extension does not automatically detect the language if the website omits it.
*   `{SYSLANG}`: The current system/browser language configuration.

---

## Example Configurations

Below are a few examples showcasing how you can structure your services:

### Example 1: Multilingual Translation Assistant
- **Service Name:** Translate to local language
- **Linked domains:** (Empty - Available everywhere)
- **Prompt:**
  ```
  Act as a professional translator. I am browsing a site in the {LANG} language at {URL}, but my browser is set to {SYSLANG}.
  
  Please accurately translate the following content to {SYSLANG}, keeping the original markdown and text formatting intact. 
  ```

### Example 2: Code Reviewer (Domain Specific)
- **Service Name:** Python Code Review
- **Linked domains:** `github.com, gitlab.com, stackoverflow.com`
- **Prompt:**
  ```
  You are an expert developer. The code snippets provided below were found on {DOMAIN}.
  Analyze the code strictly for potential bugs, security vulnerabilities, and code smell. Do not explain what the code does, just list the issues and provide a corrected version.
  ```

### Example 3: Daily Briefing Extractor
- **Service Name:** Extract Key Entities
- **Linked domains:** `news.ycombinator.com, techcrunch.com, bbc.com`
- **Prompt:**
  ```
  Today is {DATE} at {HOUR}. Scan the following news article and extract a neat JSON list containing the main "People", "Organizations", and "Locations" mentioned in the text.
  ```

## Browser Installation

1. **Google Chrome**: 
  Pending upload to Chrome Web Store

2. **Mozilla Firefox**:
  Pending upload to Firefox Add-ons

---
**Note:** Ensure you have configured the global settings (API Keys or local Ollama instances) properly in the extension's Options page before running any captures.
