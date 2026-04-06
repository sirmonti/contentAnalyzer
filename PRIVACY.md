# Privacy Policy for contentAnalyzer

**Last Updated: April 2026**

## 1. Introduction

The "contentAnalyzer" Chrome extension (the "Extension") is designed to process the content of the current webpage using artificial intelligence services configured by the user. This Privacy Policy explains our commitment to your privacy and how data is handled.

## 2. No Data Collection by the Developer

We value your privacy above all. The developer of this Extension **does not collect, store, or transmit any of your personal data, browsing history, or processed content to any server controlled by the developer.**

All configuration settings (such as API keys or custom prompts) are stored locally within your browser's storage (e.g., `chrome.storage.local`) and are never accessible to the developer.

## 3. Data Transmission to Third-Party Services

To provide its core functionality, the Extension sends the content of the webpage you choose to analyze to the third-party AI service provider (the "AI Service") that **you** have configured in the settings.

### 3.1. User-Configured Services

The Extension only communicates with the specific endpoints/APIs provided by the user. Because these services are selected and configured by the user, the developer of "contentAnalyzer" has no control over how these third-party sites handle the data sent to them.

### 3.2. Third-Party Privacy Policies

The developer cannot be held responsible for the privacy practices, data retention policies, or security measures of the AI Services you choose to use. Before using the Extension with a specific service, we strongly recommend that you review the Privacy Policy and Terms of Service of that provider (e.g., OpenAI, Anthropic, Google, or any custom LLM provider).

## 4. Permissions

The Extension requires specific permissions to function:

- **`activeTab` or `<all_urls>`**: To read the content of the page you wish to analyze.
    
- **`storage`**: To save your configuration and API settings locally.
    
- **`host permissions`**: To send the content to the AI Service API you have specified.
    

## 5. Security

While the Extension facilitates the transmission of data via standard web protocols, the security of the data once it leaves your browser depends entirely on the AI Service you have configured. We recommend using services that provide secure (HTTPS) API endpoints.

## 6. Changes to This Policy

The developer reserves the right to update this Privacy Policy at any time. Any changes will be reflected in a new version of the Extension and updated on this page.

## 7. Contact

If you have any questions regarding this Privacy Policy, please contact the developer through the support channels provided in the Chrome Web Store.
