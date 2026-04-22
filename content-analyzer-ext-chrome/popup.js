/**
 * @file popup.js (Chrome version)
 * @description Logic for the Chrome extension popup (popup.html).
 *
 * This script runs every time the user opens the popup by clicking
 * the icon in the browser toolbar.
 *
 * MAIN FUNCTIONS:
 * ----------------------
 *  1. Load configured LLM services from the options page.
 *  2. Filter services based on the current tab's domain.
 *  3. Show a button for each service and a fixed one for "Save to disk".
 *  4. Upon clicking a button, activate the interactive selector on the web page.
 *
 * KEY DIFFERENCE WITH FIREFOX VERSION - SCRIPT INJECTION:
 * -----------------------------------------------------------------
 * Firefox MV3 requires a THREE separate injections architecture ("two worlds")
 * because the ISOLATED world (content scripts) and the MAIN world (web page) don't share
 * the JavaScript scope:
 *
 *   Firefox:
 *     Step 1 → turndown.js in MAIN world
 *     Step 2 → Bridge in ISOLATED world (listens to postMessage, uses browser.runtime.sendMessage)
 *     Step 3 → Selector in MAIN world (uses TurndownService + postMessage to communicate with bridge)
 *
 *   Chrome:
 *     Step 1 → turndown.js (injected without specifying world; goes to ISOLATED world by default)
 *     Step 2 → Selector (also in ISOLATED world, has access to both TurndownService and chrome.runtime)
 *
 * In Chrome, the ISOLATED world DOES have access to `window.chrome` and can call
 * `chrome.runtime.sendMessage()` directly. Additionally, libraries injected with
 * `executeScript({ files: [...] })` (without specifying world) are visible in the ISOLATED
 * world of the tab, so `TurndownService` is globally available in the content script.
 *
 * This considerably simplifies the architecture: no postMessage bridge needed.
 *
 * DOMAIN FILTERING:
 * ----------------------
 * Each service can be linked to specific domains. If `linkWeb: true` and
 * `linkedWebUrl: "example.com, other.es"`, the service will only appear on those domains
 * (and their subdomains). Services without restrictions are always shown.
 */

document.addEventListener("DOMContentLoaded", async () => {
    // Firefox/Chrome compatibility
    const api = window.browser || window.chrome;

    // ---- LOAD SERVICES FROM STORAGE ----
    const data = await api.storage.local.get("llm_services");
    const container = document.getElementById("servicesContainer");
    let servicesList = data.llm_services || [];

    // ---- GET ACTIVE TAB ----
    // We need the current tab's URL for domain filtering.
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const tabUrl = tabs && tabs.length > 0 ? tabs[0].url : "";

    // ---- DOMAIN FILTERING ----
    // Only show services without domain restriction,
    // or whose domain matches the active tab's (including subdomains).
    servicesList = servicesList.filter(m => {
        // No domain restriction: always visible
        if (!m.linkWeb || !m.linkedWebUrl) return true;

        // Parse list of domains (comma separated)
        const domains = m.linkedWebUrl
            .split(',')
            .map(d => d.trim().toLowerCase())
            .filter(d => d.length > 0);

        if (domains.length === 0) return true;

        try {
            const urlObj   = new URL(tabUrl);
            const hostname = urlObj.hostname.toLowerCase();

            // Compare hostname with each domain in the list.
            // `endsWith('.' + domain)` allows subdomains (e.g.: "www.example.com" for "example.com").
            return domains.some(domain => {
                return hostname === domain || hostname.endsWith('.' + domain);
            });
        } catch (e) {
            // Unparseable URL (about:blank, about:debugging, etc.): hide service
            return false;
        }
    });

    // ---- BUTTON RENDERING ----
    container.innerHTML = "";

    if (servicesList.length === 0) {
        // No active services or none apply to current domain
        container.innerHTML = `<div style="font-size:12px;color:#999">${api.i18n.getMessage("errNoServices") || "No active services."}</div>`;
    } else {
        // Generate a button for each available service
        servicesList.forEach(m => {
            const btn = document.createElement("button");
            btn.className = "btn btn-service";
            btn.textContent = "🤖 " + m.name;
            btn.addEventListener("click", () => handleAction("llm", m));
            container.appendChild(btn);
        });
    }

    // ---- FIXED BUTTON: SAVE TO DISK ----
    // Always visible; saves selected content as .md without sending to any LLM.
    document.getElementById("btnDisk").addEventListener("click", () => {
        handleAction("disk");
    });

    // ---- LINK TO OPTIONS PAGE ----
    document.getElementById("openOptions").addEventListener("click", (e) => {
        e.preventDefault();
        api.runtime.openOptionsPage();
        window.close(); // Close the popup
    });
});

/**
 * Displays an error message in the popup's error area.
 * @param {string} msg - Error text.
 */
function showError(msg) {
    const errorDiv = document.getElementById("errorMsg");
    errorDiv.textContent = msg;
    errorDiv.style.display = "block";
}

/**
 * Activates the interactive selector on the user's active tab.
 *
 * CHROME INJECTION ARCHITECTURE (simpler than Firefox):
 * ---------------------------------------------------------------
 * Chrome doesn't require Firefox's "two worlds" architecture because:
 *   1. Libraries injected with `executeScript({ files: [...] })` are
 *      accessible in the same ISOLATED world content script.
 *   2. Chrome's ISOLATED world has access to `window.chrome` and can
 *      call `chrome.runtime.sendMessage()` directly, without a bridge.
 *
 * Therefore, we only need TWO steps instead of three:
 *   Step 1 → Inject turndown.js (becomes available in content script)
 *   Step 2 → Inject interactive selector (uses TurndownService + sendMessage)
 *
 * @param {string} type          - Action type: "llm" or "disk".
 * @param {Object|null} serviceData - LLM service configuration (null if type="disk").
 */
async function handleAction(type, serviceData = null) {
    try {
        const api = window.browser || window.chrome;
        const tabs = await api.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0) {
            throw new Error(api.i18n.getMessage("errNoTab") || "No active tab");
        }
        const tab = tabs[0];

        // =====================================================================
        // STEP 1: Inject TurndownService into the page's content script.
        // =====================================================================
        // In Chrome, by not specifying `world`, the script is injected into the
        // ISOLATED world (content script context). TurndownService declares
        // a global variable that remains available for the step 2 script,
        // which runs in the same ISOLATED context.
        //
        // Note: Unlike Firefox, we DON'T need to specify `world: "MAIN"`,
        // as Chrome's ISOLATED world DOES have access to these global variables
        // previously injected with executeScript.
        await api.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["turndown.js"]
            // No `world` → ISOLATED world by default (Chrome behavior)
        });

        // =====================================================================
        // STEP 2: Inject the interactive selector into the content script.
        // =====================================================================
        // Unlike Firefox (which needs postMessage + bridge), in Chrome
        // the ISOLATED world content script can use `window.chrome.runtime.sendMessage()`
        // directly to communicate with the background, without any intermediary.
        //
        // TurndownService (injected in step 1) is also available here
        // as both scripts share the same ISOLATED world of the tab.
        await api.scripting.executeScript({
            target: { tabId: tab.id },
            func: (actionType, servData, srvMsgTip, srvMsgCapAll, srvMsgCancel) => {

                // Guard: don't activate selector if one is already active
                if (window._articleExtractorActive) return;
                window._articleExtractorActive = true;

                let lastHovered = null;
                // WeakMap to store original styles without causing memory leaks
                const originalOutlines = new WeakMap();
                const originalCursors  = new WeakMap();

                // ---- HOVER HANDLER: Green highlight of the element under the cursor ----
                const mouseOverHandler = (e) => {
                    // Don't highlight instruction tooltip
                    const tip = document.getElementById('article-extractor-tip');
                    if (tip && (e.target === tip || tip.contains(e.target))) return;

                    // Restore style of previously highlighted element
                    if (lastHovered) {
                        lastHovered.style.outline = originalOutlines.get(lastHovered) || '';
                        lastHovered.style.cursor  = originalCursors.get(lastHovered) || '';
                    }

                    lastHovered = e.target;

                    // Save original styles only the first time
                    if (!originalOutlines.has(lastHovered)) {
                        originalOutlines.set(lastHovered, lastHovered.style.outline);
                        originalCursors.set(lastHovered,  lastHovered.style.cursor);
                    }

                    // Apply visual highlight
                    lastHovered.style.outline = '3px solid #10b981'; // Emerald green
                    lastHovered.style.cursor  = 'crosshair';
                    e.stopPropagation(); // Prevent page from processing hover event
                };

                // ---- CLICK HANDLER: Capture and send selected element ----
                const clickHandler = (e) => {
                    e.preventDefault();  // Stop click from activating links/other page handlers
                    e.stopPropagation(); // stop click propagation to the page

                    // Remove selector listeners and restore page
                    document.removeEventListener('mouseover', mouseOverHandler, true);
                    document.removeEventListener('click', clickHandler, true);

                    if (lastHovered) {
                        lastHovered.style.outline = originalOutlines.get(lastHovered) || '';
                        lastHovered.style.cursor  = originalCursors.get(lastHovered) || '';
                    }
                    window._articleExtractorActive = false;

                    if (e.target.id === 'article-extractor-cancel') {
                        const tip = document.getElementById('article-extractor-tip');
                        if (tip) tip.remove();
                        return;
                    }

                    // If user clicked "Capture all", use full document.body.
                    // Otherwise, process the element they clicked on.
                    let targetToParse = e.target;
                    if (e.target.id === 'article-extractor-capture-all') {
                        targetToParse = document.body;
                    }

                    // Remove tooltip as selection is finished
                    const tip = document.getElementById('article-extractor-tip');
                    if (tip) tip.remove();

                    try {
                        let markdown;
                        // Determine whether to convert to Markdown or send raw HTML
                        if (servData && servData.hasOwnProperty('useMarkdown') && servData.useMarkdown === false) {
                            // Raw HTML mode: send original HTML without conversion
                            markdown = targetToParse.outerHTML || targetToParse.innerHTML;
                        } else {
                            // Markdown mode: convert with TurndownService.
                            // TurndownService is available as it was injected in step 1
                            // and both scripts share the same ISOLATED world in Chrome.
                            const t = new TurndownService({ headingStyle: 'atx' });
                            markdown = t.turndown(targetToParse.outerHTML || targetToParse.innerHTML);
                        }

                        // ---- DIRECT SEND TO BACKGROUND VIA chrome.runtime ----
                        // In Chrome (ISOLATED world), `window.chrome` is available,
                        // so we can call sendMessage directly without a bridge.
                        // This is the most important difference with the Firefox version.
                        const extApi = window.browser || window.chrome;
                        extApi.runtime.sendMessage({
                            action:      "processSelection",
                            type:        actionType,   // "llm" or "disk"
                            serviceData: servData,     // LLM service config (null if disk)
                            markdown:    markdown,     // Captured content (Markdown or HTML)
                            title:       document.title,                 // Page title
                            url:         window.location.href,           // Full URL
                            domain:      window.location.hostname,       // Domain only
                            lang:        document.documentElement.lang || "NONE", // <html lang="...">
                            syslang:     navigator.language              // System language
                        });

                    } catch (err) {
                        const failMsg = extApi.i18n.getMessage("errParse", [err.message]) || `Capture error: ${err.message}`;
                        alert(failMsg);
                    }
                };

                // Register in CAPTURE phase to intercept before the page
                document.addEventListener('mouseover', mouseOverHandler, true);
                document.addEventListener('click', clickHandler, true);

                // ---- INSTRUCTION TOOLTIP ----
                // Show floating box with instructions and "Capture all" button.
                // Maximum z-index (2^31 - 1) to appear on top of everything.
                const tip = document.createElement('div');
                tip.id = 'article-extractor-tip';
                tip.style.position    = 'fixed';
                tip.style.top         = '20px';
                tip.style.right       = '20px';
                tip.style.background  = '#10b981';
                tip.style.color       = '#fff';
                tip.style.padding     = '12px 20px';
                tip.style.borderRadius = '8px';
                tip.style.fontWeight  = 'bold';
                tip.style.zIndex      = '2147483647'; // Max possible CSS z-index
                tip.style.pointerEvents = 'auto';     // Tooltip must receive events (inner button)
                tip.style.fontFamily  = 'system-ui, sans-serif';
                tip.style.boxShadow   = '0 4px 6px rgba(0,0,0,0.3)';
                tip.innerHTML = `
                    <div style="margin-bottom: 8px;">${srvMsgTip}</div>
                    <button id="article-extractor-capture-all" style="width: 100%; border: none; background: #fff; color: #10b981; padding: 6px; border-radius: 4px; cursor: pointer; font-weight: bold; box-shadow: 0 1px 3px rgba(0,0,0,0.2); margin-bottom: 6px;">${srvMsgCapAll}</button>
                    <button id="article-extractor-cancel" style="width: 100%; border: none; background: rgba(0,0,0,0.2); color: #fff; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-weight: bold;">${srvMsgCancel}</button>
                `;
                document.body.appendChild(tip);
            },
            // Pass external values as arguments to the injected function.
            // Without this mechanism, the content script wouldn't have access to these variables
            // from the popup context, which is a separate JavaScript context.
            args: [
                type,
                serviceData,
                api.i18n.getMessage("tipInstruction"),
                api.i18n.getMessage("capAllBtn"),
                api.i18n.getMessage("optCancelBtn")
            ]
        });

        // Close popup; selector is now active on the page
        window.close();

    } catch (e) {
        showError("Error: " + e.message);
    }
}
