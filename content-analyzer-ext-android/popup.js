/**
 * @file popup.js
 * @description Logic for the extension popup (popup.html).
 *
 * This script runs every time the user opens the extension popup by
 * clicking the browser toolbar icon.
 *
 * MAIN FUNCTIONS:
 * ----------------------
 *  1. Load LLM services configured in the options page.
 *  2. Filter services based on current tab domain (if linked).
 *  3. Show one button for each active service and a fixed one for "Save to disk".
 *  4. On clicking any button, activate the interactive selector in the web page.
 *
 * TWO-WORLD ARCHITECTURE (Firefox MV3):
 * ------------------------------------------
 * In Firefox (Manifest V3), content scripts run in an "isolated world"
 * (ISOLATED world) that has access to extension APIs (`browser.*`) but
 * doesn't share global JavaScript scope with the web page.
 *
 * This means a library loaded in the MAIN world (page scope)
 * is not visible from the ISOLATED world, and vice versa.
 *
 * To inject TurndownService (which needs MAIN world to convert HTML to Markdown)
 * and communicate with the background (which requires ISOLATED world), we use a
 * THREE-script injection strategy in order:
 *
 *   STEP 1 - MAIN world:     Inject turndown.js
 *                            → TurndownService becomes available in the global page scope
 *
 *   STEP 2 - ISOLATED world: Inject a "bridge" that listens for postMessage
 *                            → Can use `browser.runtime.sendMessage()` (extension APIs)
 *
 *   STEP 3 - MAIN world:     Inject the interactive selector
 *                            → Has access to TurndownService (injected in step 1)
 *                            → Uses window.postMessage() to communicate with the bridge (step 2)
 *
 * This architecture is necessary because no single world has access to both
 * (TurndownService from page + extension APIs) simultaneously.
 *
 * DOMAIN FILTERING:
 * ----------------------
 * Each service can be configured to show only on specific domains.
 * If `linkWeb: true` and `linkedWebUrl: "example.com, another.es"`, the service only
 * appears when the active tab belongs to those domains (or subdomains).
 * Services without domain limitation are always shown.
 */

document.addEventListener("DOMContentLoaded", async () => {
    // Firefox/Chrome compatibility: `window.browser` exists in Firefox, `window.chrome` in Chrome/Edge
    const api = window.browser || window.chrome;

    // ---- LOAD SERVICES FROM STORAGE ----
    const data = await api.storage.local.get("llm_services");
    const container = document.getElementById("servicesContainer");
    let servicesList = data.llm_services || [];

    // ---- GET ACTIVE TAB ----
    // We need current tab URL to filter services linked by domain.
    // `query({ active: true, currentWindow: true })` returns exactly the tab user is seeing.
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const tabUrl = tabs && tabs.length > 0 ? tabs[0].url : "";

    // ---- DOMAIN FILTERING ----
    // Apply filter to service list before rendering.
    servicesList = servicesList.filter(m => {
        // If service has no domain limit, always show it
        if (!m.linkWeb || !m.linkedWebUrl) return true;

        // Parse allowed domain list: can be multiple separated by commas
        const domains = m.linkedWebUrl
            .split(',')
            .map(d => d.trim().toLowerCase())
            .filter(d => d.length > 0); // Remove empty strings from extra commas

        if (domains.length === 0) return true; // Empty list = no restriction

        try {
            // Use URL API to safely parse URL (handles ports, protocol, etc.)
            const urlObj  = new URL(tabUrl);
            const hostname = urlObj.hostname.toLowerCase(); // Only hostname, no port or protocol

            // Compare against each domain in list.
            // Use `endsWith('.' + domain)` to include subdomains:
            //   domain "example.com" → also matches "www.example.com", "api.example.com"
            return domains.some(domain => {
                return hostname === domain || hostname.endsWith('.' + domain);
            });
        } catch (e) {
            // If tab URL is not parseable (e.g.: about:blank, about:debugging),
            // hide linked service to not show non-functional buttons.
            return false;
        }
    });

    // ---- BUTTON RENDERING ----
    container.innerHTML = ""; // Clear container before repainting

    if (servicesList.length === 0) {
        // No active services or compatible with current domain
        container.innerHTML = `<div style="font-size:12px;color:#999">${api.i18n.getMessage("errNoServices") || "No active services."}</div>`;
    } else {
        // Dynamically create one button for each available service.
        // Clicking calls handleAction("llm", serviceData) to activate selector.
        servicesList.forEach(m => {
            const btn = document.createElement("button");
            btn.className = "btn btn-service";
            btn.textContent = "🤖 " + m.name; // Robot emoji visually identifies LLM buttons
            btn.addEventListener("click", () => handleAction("llm", m));
            container.appendChild(btn);
        });
    }

    // ---- FIXED BUTTON: SAVE TO DISK ----
    // This button always appears, regardless of configured services.
    // Saves selected content as a local Markdown file (without sending to any LLM).
    document.getElementById("btnDisk").addEventListener("click", () => {
        handleAction("disk");
    });

    // ---- LINK TO OPTIONS PAGE ----
    // Use `runtime.openOptionsPage()` instead of href link because
    // Firefox might have the options page already open and focuses it in that case.
    document.getElementById("openOptions").addEventListener("click", (e) => {
        e.preventDefault();
        api.runtime.openOptionsPage();
        window.close(); // Close popup so it doesn't stay floating
    });
});

/**
 * Shows an error message in the popup error area.
 *
 * @param {string} msg - Error text to display.
 */
function showError(msg) {
    const errorDiv = document.getElementById("errorMsg");
    errorDiv.textContent = msg;
    errorDiv.style.display = "block";
}

/**
 * Activates interactive selector in user's active tab.
 *
 * This is the central popup function. When user clicks a service button
 * or "Save to disk", three scripts are injected into the active tab's
 * web page to enable selector mode.
 *
 * Selector shows an instruction tooltip and highlights in green any HTML
 * element user hovers over. On click, it captures HTML, converts to
 * Markdown (if configured) and sends to background.
 *
 * @param {string} type          - Action type: "llm" (process with IA) or "disk" (save).
 * @param {Object|null} serviceData - Selected LLM service configuration (null if type="disk").
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
        // STEP 1: Inject TurndownService into page'S MAIN world.
        // =====================================================================
        // MAIN world shares `window` object with web page, so any variable
        // declared in a MAIN world script becomes available globally,
        // including for other MAIN world scripts injected later.
        //
        // TurndownService is a library that converts HTML to Markdown.
        // Must be in MAIN world because it needs to access page DOM
        // and library declares a global variable next script will use.
        await api.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["turndown.js"],  // Turndown library file included in extension
            world: "MAIN"           // Runs in global web page context
        });

        // =====================================================================
        // STEP 2: Inject "bridge" into ISOLATED world.
        // =====================================================================
        // Bridge is a communication script acting as a bridge between
        // MAIN world (where interactive selector lives) and extension APIs
        // (only available in ISOLATED world).
        //
        // Works by listening to `window.postMessage()` and forwarding messages
        // having `__source: "content-analyzer-ext"` marker to background
        // via `browser.runtime.sendMessage()`.
        //
        // Injected BEFORE selector (step 3) so listener is already active
        // when selector sends postMessage with captured data.
        await api.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                // Guard: Avoid registering listener more than once if user
                // clicks multiple buttons before selecting an element.
                if (window._extractorBridgeActive) return;
                window._extractorBridgeActive = true;

                window.addEventListener("message", (event) => {
                    // Filter messages not from our extension.
                    // __source property acts as a "namespace" to prevent
                    // messages from web page itself or other extensions
                    // from being accidentally processed by this listener.
                    if (!event.data || event.data.__source !== "content-analyzer-ext") return;

                    const payload = event.data.payload;

                    // In Firefox ISOLATED world, `browser` is a global variable
                    // of content script environment, but NOT in `window.browser`.
                    // That's why we can't use `window.browser` here; we must use
                    // direct global variable `browser` (or `chrome` in Chrome).
                    // eslint-disable-next-line no-undef
                    const extApi = (typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null));
                    if (!extApi) return; // Should never happen in an ISOLATED world

                    // Forward payload to background, which processes it with `runtime.onMessage`
                    extApi.runtime.sendMessage(payload);
                }, false);
            }
            // Note: Without specifying `world: "MAIN"`, script runs in ISOLATED world (default)
        });

        // =====================================================================
        // STEP 3: Inject interactive selector into MAIN world.
        // =====================================================================
        // This script:
        //   - Shows fixed tooltip in top-right corner of page.
        //   - Highlights green element under cursor on hover.
        //   - On click, converts element to Markdown with TurndownService
        //     (available thanks to step 1) and sends to bridge (step 2).
        //
        // `args` parameters are passed as arguments to `func` function
        // so injected script has access to service configuration
        // and translated interface strings (i18n).
        await api.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: (actionType, servData, srvMsgTip, srvMsgCapAll, srvMsgCancel, srvMsgErrParse) => {

                // Guard: If selector already active (user clicked popup again),
                // don't activate another one on top to avoid duplicate listeners.
                if (window._articleExtractorActive) return;
                window._articleExtractorActive = true;

                let lastHovered = null;
                // Use WeakMap to store original element styles.
                // WeakMap doesn't prevent GC from removing entries when element disappears from DOM,
                // avoiding memory leaks on pages dynamically modifying DOM.
                const originalOutlines = new WeakMap();
                const originalCursors = new WeakMap();

                // ---- HOVER HANDLER: Highlight element under cursor ----
                const mouseOverHandler = (e) => {
                    // Don't highlight instruction tooltip itself to avoid confusing visual feedback
                    const tip = document.getElementById('article-extractor-tip');
                    if (tip && (e.target === tip || tip.contains(e.target))) return;

                    // Restore style of previously highlighted element
                    if (lastHovered) {
                        lastHovered.style.outline = originalOutlines.get(lastHovered) || '';
                        lastHovered.style.cursor  = originalCursors.get(lastHovered) || '';
                    }

                    // Store reference to new element under cursor
                    lastHovered = e.target;

                    // Store original styles ONLY THE FIRST TIME
                    // (if already in WeakMap, we'd overwrite with "3px solid #10b981")
                    if (!originalOutlines.has(lastHovered)) {
                        originalOutlines.set(lastHovered, lastHovered.style.outline);
                        originalCursors.set(lastHovered,  lastHovered.style.cursor);
                    }

                    // Apply green visual highlight and selection cursor
                    lastHovered.style.outline = '3px solid #10b981';
                    lastHovered.style.cursor  = 'crosshair';

                    // stopPropagation in capture phase to process event before page does
                    e.stopPropagation();
                };

                // ---- CLICK HANDLER: Capture selected element ----
                const clickHandler = (e) => {
                    e.preventDefault();    // Prevents click from activating links or other page behaviors
                    e.stopPropagation();   // Prevents page from also processing event

                    // Clear listeners and restore page to original state
                    document.removeEventListener('mouseover', mouseOverHandler, true);
                    document.removeEventListener('click', clickHandler, true);

                    if (lastHovered) {
                        lastHovered.style.outline = originalOutlines.get(lastHovered) || '';
                        lastHovered.style.cursor  = originalCursors.get(lastHovered) || '';
                    }
                    window._articleExtractorActive = false; // Free guard for future uses

                    if (e.target.id === 'article-extractor-cancel') {
                        const tip = document.getElementById('article-extractor-tip');
                        if (tip) tip.remove();
                        return;
                    }

                    // Determine target element:
                    // If user pressed "Capture all" button, use full document.body.
                    let targetToParse = e.target;
                    if (e.target.id === 'article-extractor-capture-all') {
                        targetToParse = document.body || document.documentElement;
                    }

                    // Validation: nodeType === 1 means a normal HTMLElement.
                    // Other nodeTypes (text, comment, etc.) don't have outerHTML and might error.
                    if (!targetToParse || targetToParse.nodeType !== 1) {
                        targetToParse = document.body || document.documentElement;
                    }

                    // Remove instruction tooltip since user has selected
                    const tip = document.getElementById('article-extractor-tip');
                    if (tip) tip.remove();

                    if (!targetToParse) {
                        alert(srvMsgErrParse.replace("$1", "DOM unavailable"));
                        return;
                    }

                    try {
                        let markdown;
                        // Use outerHTML to include root element, with fallback to innerHTML
                        const htmlContent = targetToParse.outerHTML || targetToParse.innerHTML || "";

                        if (servData && servData.hasOwnProperty('useMarkdown') && servData.useMarkdown === false) {
                            // Service configured for raw HTML (not Markdown).
                            // Send HTML directly without conversion.
                            markdown = htmlContent;
                        } else {
                            // Convert HTML to Markdown using TurndownService.
                            // `headingStyle: 'atx'` uses "# Heading" format (with hashes)
                            // instead of "setext" style with underlines (=== or ---).
                            const t = new TurndownService({ headingStyle: 'atx' });
                            markdown = t.turndown(htmlContent);
                        }

                        // ---- SEND TO BRIDGE VIA postMessage ----
                        // Use window.postMessage because from MAIN world we have no access
                        // to `browser.runtime.sendMessage()`. Bridge (step 2) listens to this
                        // and forwards to background which can process action.
                        //
                        // "__source" acts as namespace for bridge identifying our messages.
                        // Second parameter "*" allows message to any origin (necessary since
                        // injected content script origin is web page's, not extension's).
                        window.postMessage({
                            __source: "content-analyzer-ext",
                            payload: {
                                action:      "processSelection",
                                type:        actionType,   // "llm" o "disk"
                                serviceData: servData,     // LLM service config (null if disk)
                                markdown:    markdown,     // Captured content (Markdown or HTML)
                                title:       document.title,                 // Page title
                                url:         window.location.href,           // Full URL
                                domain:      window.location.hostname,       // Domain only
                                lang:        document.documentElement.lang || "NONE", // <html lang="...">
                                syslang:     navigator.language              // User's system language
                            }
                        }, "*");

                    } catch (err) {
                        const errMsg = (err && err.message) ? err.message : String(err);
                        alert(srvMsgErrParse.replace("$1", errMsg));
                    }
                };

                // Register both handlers in CAPTURE phase (third argument `true`).
                // This makes our listeners trigger BEFORE page ones,
                // allowing us to intercept and cancel events with preventDefault/stopPropagation.
                document.addEventListener('mouseover', mouseOverHandler, true);
                document.addEventListener('click', clickHandler, true);

                // ---- INSTRUCTION TOOLTIP ----
                // Create floating tooltip explaining how to use selector.
                // Use maximum z-index (2147483647 = 2^31 - 1) to ensure
                // tooltip always appears above any element in page.
                const tip = document.createElement('div');
                tip.id = 'article-extractor-tip';
                tip.style.cssText = [
                    'position: fixed',
                    'top: 20px',
                    'right: 20px',
                    'background: #10b981',       // Emerald green (same as highlight)
                    'color: #fff',
                    'padding: 12px 20px',
                    'border-radius: 8px',
                    'font-weight: bold',
                    'z-index: 2147483647',        // Max possible z-index in CSS
                    'pointer-events: auto',       // Tooltip must receive events (for inner button)
                    'font-family: system-ui, sans-serif',
                    'box-shadow: 0 4px 6px rgba(0,0,0,0.3)'
                ].join(';');

                // Tooltip contains:
                //   - Instruction text (localized via i18n)
                //   - "Capture all" button to select document.body without clicking
                tip.innerHTML = `
                    <div style="margin-bottom: 8px;">${srvMsgTip}</div>
                    <button id="article-extractor-capture-all" style="width: 100%; border: none; background: #fff; color: #10b981; padding: 6px; border-radius: 4px; cursor: pointer; font-weight: bold; box-shadow: 0 1px 3px rgba(0,0,0,0.2); margin-bottom: 6px;">${srvMsgCapAll}</button>
                    <button id="article-extractor-cancel" style="width: 100%; border: none; background: rgba(0,0,0,0.2); color: #fff; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-weight: bold;">${srvMsgCancel}</button>
                `;
                document.body.appendChild(tip);
            },
            // Pass values needed from popup context as arguments to `func`.
            // These variables wouldn't be available in MAIN world without this mechanism.
            args: [
                type,                                        // Action type ("llm" or "disk")
                serviceData,                                 // LLM service config
                api.i18n.getMessage("tipInstruction"),       // Instruction tooltip text
                api.i18n.getMessage("capAllBtn"),            // "Capture all" button text
                api.i18n.getMessage("optCancelBtn"),         // Cancel text
                api.i18n.getMessage("errParse", ["$1"])      // Pass "$1" as-is for later replacement
            ]
        });

        // Close popup immediately after injecting scripts.
        // Selector is already active in page; popup doesn't need to stay open.
        window.close();

    } catch (e) {
        showError("Error: " + e.message);
    }
}
