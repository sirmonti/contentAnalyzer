const DEBUG_MODE = false;

function showDebugPopup(debugInfo) {
    const popup = document.createElement("div");
    popup.style.cssText = "position:fixed;top:10%;left:10%;width:80%;height:80%;background:white;color:black;border:2px solid red;z-index:9999;padding:20px;overflow:auto;box-shadow:0 0 10px rgba(0,0,0,0.5);";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.onclick = () => popup.remove();
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(debugInfo, null, 2);
    pre.style.whiteSpace = "pre-wrap";
    pre.style.wordBreak = "break-all";
    popup.appendChild(closeBtn);
    popup.appendChild(document.createElement("br"));
    popup.appendChild(pre);
    document.body.appendChild(popup);
}

/**
 * @file options.js
 * @description Logic for the extension's configuration page (options.html).
 *
 * This page allows the user to manage the AI services available in the extension.
 * For each service, the following can be configured:
 *   - Descriptive name of the service
 *   - Provider type: ollama | openai | anthropic | gemini | groq | openrouter | prompt-api
 *   - Server URL (only for Ollama and OpenAI-compatible servers)
 *   - API Key (depending on the provider)
 *   - Model to use (dynamically queried from the API)
 *   - Instruction prompt for the LLM
 *   - Whether to render the response as Markdown or not
 *   - Whether to limit the service to specific web domains
 *
 * PERSISTENCE:
 * -------------
 * Services are saved in `browser.storage.local` under the `llm_services` key
 * as an array of objects. This storage is local to the Firefox profile and persists
 * between browser sessions.
 *
 * DYNAMIC MODEL LOADING:
 * ---------------------------
 * Instead of requiring the user to manually type the model name,
 * the page queries the list of available models from the configured server in real-time.
 * This is done via a message to the background (`fetchModels`),
 * as network requests must be made from the privileged background context
 * to avoid CORS restrictions on extension pages.
 *
 * The user doesn't have to press any additional buttons: the query is launched
 * automatically with a 500ms debounce every time the user changes the URL
 * or the API key. This avoids saturating the server with requests while typing.
 *
 * STATE PATTERN:
 * -----------------
 * The state of the services list is maintained in the `servicesList` variable in memory.
 * Each create, edit, or delete operation updates this variable AND persists it in storage.
 * `window.editingIndex` stores the index of the service currently being edited,
 * or null if we are in creation mode (new service).
 */

// Firefox/Chrome compatibility without using the webextension-polyfill polyfill
const api = window.browser || window.chrome;

/** @type {Array<Object>} List of LLM services loaded from storage */
let servicesList = [];

/** @type {Array<Object>} List of shared prompts loaded from storage */
let promptsList = [];
let systemPromptsList = [];
window.editingSysPromptIndex = null;

/**
 * Index (in `servicesList`) of the service currently being edited.
 * It is `null` when the form is in "New service" mode.
 * Exposed on `window` to be accessible from DOM button handlers.
 * @type {number|null}
 */
window.editingIndex = null;

/**
 * Index (in `promptsList`) of the prompt currently being edited.
 * It is `null` when the form is in "New prompt" mode.
 * @type {number|null}
 */
window.editingPromptIndex = null;

// Start data loading when the DOM is ready for manipulation
document.addEventListener("DOMContentLoaded", () => {
    loadServices();
    initNavigation();
});

// ============================================================
// NAVIGATION & TABS LOGIC
// ============================================================

function navigateTo(targetId) {
    // Activate page
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(targetId).classList.add('active');

    // Activate nav buttons
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll(`.nav-btn[data-target="${targetId}"]`).forEach(b => b.classList.add('active'));
}

function initNavigation() {
    const navBtns = document.querySelectorAll('.nav-btn');

    navBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = btn.getAttribute('data-target');
            
            navigateTo(targetId);

            // If navigating to add, make sure form is clean and in the correct place
            if (targetId === 'page-add') {
                cancelEditForm(); 
            }
            
            if (targetId === 'page-sys-prompt-add') {
                window.editingSysPromptIndex = null;
                document.getElementById("addSysPromptForm").reset();
                const form = document.getElementById("addSysPromptForm");
                document.getElementById("sys-prompt-form-container-add").appendChild(form);
                document.getElementById("sysPromptSubmitBtn").textContent = api.i18n.getMessage("optSaveSysPromptBtn") || "Guardar System Prompt";
                document.getElementById("cancelSysPromptEditBtn").style.display = "none";
            }
            if (targetId === 'page-prompt-add') {
                cancelPromptEditForm();
            }
        });
    });

    // Close modal logic
    document.getElementById('closeModalBtn').addEventListener('click', cancelEditForm);
    document.getElementById('closePromptModalBtn').addEventListener('click', cancelPromptEditForm);
}

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * Checks whether the Prompt API is available in the current browser or background.
 * @returns {Promise<boolean>}
 */
async function checkPromptApiAvailability() {
    // 1. Direct check in current window context
    try {
        const aiObj = (typeof window !== 'undefined' && window.ai) || (typeof self !== 'undefined' && self.ai) || globalThis.ai;
        if (aiObj && aiObj.languageModel) {
            if (typeof aiObj.languageModel.availability === 'function') {
                const status = await aiObj.languageModel.availability();
                if (status === 'readily' || status === 'after-download') return true;
            } else if (typeof aiObj.languageModel.capabilities === 'function') {
                const caps = await aiObj.languageModel.capabilities();
                if (caps.available === 'readily' || caps.available === 'after-download') return true;
            } else if (typeof aiObj.canCreateTextSession === 'function') {
                const status = await aiObj.canCreateTextSession();
                if (status === 'readily' || status === 'after-download') return true;
            } else {
                return true;
            }
        }
    } catch(e) {}

    // 2. Check via background message (if background context has self.ai)
    try {
        const res = await api.runtime.sendMessage({ action: "checkPromptApi" });
        if (res && res.success && res.available) {
            return true;
        }
    } catch(e) {}

    return false;
}

/**
 * Updates the visibility of the Prompt API option in the provider type dropdown.
 * If Prompt API is supported and active, or if any existing service uses it, the option is shown.
 */
async function updatePromptApiVisibility() {
    const isAvail = await checkPromptApiAvailability();
    const promptApiOpt = document.getElementById("opt_prompt_api");
    const hasPromptApiService = servicesList.some(s => s.type === "prompt-api");

    if (isAvail || hasPromptApiService) {
        if (promptApiOpt) {
            promptApiOpt.style.display = "";
            promptApiOpt.disabled = false;
        } else {
            const select = document.getElementById("m_type");
            const opt = document.createElement("option");
            opt.value = "prompt-api";
            opt.id = "opt_prompt_api";
            opt.textContent = api.i18n.getMessage("optTypePromptApi") || "Prompt API (Built-in)";
            select.appendChild(opt);
        }
    } else {
        if (promptApiOpt) {
            promptApiOpt.style.display = "none";
            promptApiOpt.disabled = true;
        }
    }
}

/**
 * Loads the services saved in storage.local and renders the table.
 * Also initializes the form in "New service" (empty) state.
 */
async function loadServices() {
    const data = await api.storage.local.get(["llm_services", "prompts", "systemPrompts"]);
    servicesList = data.llm_services || [];
    promptsList = data.prompts || [];
    systemPromptsList = data.systemPrompts || [];

    // Migration check: ensure every service has a promptId field (defaults to "")
    let migrationNeeded = false;
    servicesList.forEach(srv => {
        if (!srv.hasOwnProperty("promptId")) {
            srv.promptId = "";
            migrationNeeded = true;
        }
    });
    if (migrationNeeded) {
        await api.storage.local.set({ llm_services: servicesList });
    }

    await updatePromptApiVisibility();

    renderTable();
    renderPromptsTable();
    populatePromptsDropdown();
    renderSysPromptsTable();
    populateSysPromptsDropdown();
    cancelEditForm(); // Sets the form to a clean initial state
    cancelPromptEditForm();
}

// ============================================================
// FORM ELEMENT REFERENCES
// ============================================================
// We get references only once at the beginning to avoid repeating querySelector
// in every function (micro-optimization and cleaner code).
const urlInput    = document.getElementById("m_url");
const modelSelect = document.getElementById("m_model");
const apiKeyInput = document.getElementById("m_apikey");
const typeInput   = document.getElementById("m_type");

/** @type {number|null} Handle for the fetchModels debounce setTimeout */
let fetchTimeout;

// ============================================================
// DEBOUNCE LOGIC AND MODEL QUERYING
// ============================================================

/**
 * Launches a model query with a 500ms debounce.
 *
 * Debouncing avoids sending a request to the server for every keystroke the user makes.
 * It only executes when the user stops typing for 500ms.
 * If called again before the 500ms have passed, the timer restarts.
 */
function triggerFetch() {
    clearTimeout(fetchTimeout); // Cancels any previous pending request
    fetchTimeout = setTimeout(() => {
        fetchModelsCombo(urlInput.value.trim(), typeInput.value, apiKeyInput.value.trim());
    }, 500); // 500ms debounce: enough time not to interrupt the user while typing
}

// Enable debounce on both URL and API key changes,
// as both affect which models are available.
urlInput.addEventListener("input", triggerFetch);
apiKeyInput.addEventListener("input", triggerFetch);

// The reload button forces the query immediately, without debounce,
// for cases where the user knows the server is already ready.
document.getElementById("btnReloadModels").addEventListener("click", () => {
    fetchModelsCombo(urlInput.value.trim(), typeInput.value, apiKeyInput.value.trim(), true);
});

/**
 * Queries available models by sending a message to the background script.
 *
 * We don't make the network request directly from options.js because:
 *   1. Some providers block direct requests from extension pages (CORS).
 *   2. The background has broader network permissions as it is not subject to
 *      extension page CSP restrictions.
 *
 * Results are used to populate the form's model `<select>`.
 *
 * Preliminary validations before making the request:
 *   - Ollama and OpenAI-compatible servers require a valid URL starting with "http".
 *   - OpenAI, Anthropic, Gemini, Groq, and OpenRouter require an API key for authentication.
 *
 * @param {string} url    - Server base URL (empty for Anthropic/Gemini/Groq/OpenRouter/Mistral).
 * @param {string} type   - Provider type: "ollama"|"openai"|"anthropic"|"gemini"|"groq"|"openrouter"|"mistral"|"prompt-api".
 * @param {string} apikey - API Key (can be empty for Ollama without authentication).
 */
function fetchModelsCombo(url, type, apikey, isManual = false) {
    // Validation: Ollama and OpenAI need a valid URL starting with "http" or "https"
    if ((type === "ollama" || type === "openai") && (!url || !url.startsWith("http"))) {
        return; // Do nothing if the URL is incomplete
    }

    // Validation: Cloud providers need an API key for authentication
    if ((type === "openai" || type === "anthropic" || type === "gemini" || type === "groq" || type === "openrouter" || type === "mistral") && !apikey) {
        return; // Wait for the user to enter the key
    }

    // Normalize the URL by removing the trailing slash
    if (url.endsWith("/")) url = url.slice(0, -1);

    // Show a "searching" indicator while waiting for the response
    modelSelect.innerHTML = `<option value="">${api.i18n.getMessage("optModelLoading") || "Searching for models..."}</option>`;

    // Send message to background to make the network request.
    // background.js calls DRIVERS[type].fetchModels() and returns the list.
    api.runtime.sendMessage({ action: "fetchModels", serviceType: type, url: url, apikey: apikey })
        .then(res => {
            modelSelect.innerHTML = ''; // Clear "searching" indicator

            if (res && res.success) {
                if (res.data && res.data.models && res.data.models.length > 0) {
                    // Sort models alphabetically by name to facilitate visual search
                    const sortedModels = res.data.models.sort((a, b) => a.name.localeCompare(b.name));

                    sortedModels.forEach(m => {
                        const opt = document.createElement("option");
                        opt.value = m.name;
                        opt.textContent = m.name;

                        // If editing an existing service, automatically select 
                        // the saved model if it appears in the list.
                        if (window.editingIndex !== null && servicesList[window.editingIndex].model === m.name) {
                            opt.selected = true;
                        }
                        modelSelect.appendChild(opt);
                    });
                } else {
                    // API responded correctly but no models are available
                    modelSelect.innerHTML = `<option value="">${api.i18n.getMessage("errNoModels") || "No models available"}</option>`;
                }
            } else {
                // API returned an error (wrong credentials, server unavailable, etc.)
                modelSelect.innerHTML = `<option value="">${api.i18n.getMessage("errConn") || "Connection error"}</option>`;
                if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE && res && res.error && isManual) {
                    try {
                        const errData = JSON.parse(res.error);
                        if (errData._debug) {
                            showDebugPopup(errData);
                        }
                    } catch (e) {}
                }
            }
        })
        .catch(err => {
            // Network error or other unexpected error (e.g. background couldn't process message)
            modelSelect.innerHTML = `<option value="">${api.i18n.getMessage("errConn") || "Connection error"}</option>`;
        });
}

// ============================================================
// DYNAMIC PROVIDER TYPE CHANGE
// ============================================================

/**
 * Controls the visibility and default values of the form
 * when the user changes the LLM provider type in the dropdown.
 *
 * Each provider has different requirements:
 *   - Ollama:    Needs URL (local), no API key required (though can be provided)
 *   - OpenAI:    Needs URL (can be compatible) and mandatory API key
 *   - Anthropic: No URL needed (hardcoded in driver), mandatory API key
 *   - Gemini:    No URL needed (hardcoded in driver), mandatory API key
 *
 * When changing types, we assign default values for the URL where applicable,
 * provided the URL field doesn't already have a relevant value for another provider.
 */
document.getElementById("m_link_web").addEventListener("change", (e) => {
    // Show/hide linked domain field based on checkbox state
    document.getElementById("linked_url_group").style.display = e.target.checked ? "block" : "none";
});

document.getElementById("m_type").addEventListener("change", (e) => {
    const type = e.target.value;

    // Get local references for elements we will show/hide/modify
    const urlGroup     = document.getElementById("url_group");
    const mUrl         = document.getElementById("m_url");
    const modelSelect  = document.getElementById("m_model");
    const apikeyLabel  = document.getElementById("apikey_label");
    const apiKeyInput  = document.getElementById("m_apikey");
    const apikeyGroup  = document.getElementById("apikey_group") || apiKeyInput.parentElement;
    const urlHint      = document.getElementById("url_hint");

    // Reset model selector when changing provider (models are different)
    modelSelect.innerHTML = `<option value="">${api.i18n.getMessage("optModelEmpty") || "-- Enter valid configuration --"}</option>`;

    if (type === "ollama") {
        urlGroup.style.display = "block";  // Show URL group
        mUrl.required = true;              // URL is mandatory for Ollama
        urlHint.textContent = api.i18n.getMessage("optUrlHint") || "Models will be queried as you type the URL.";
        apikeyGroup.style.display = "block";
        apikeyLabel.textContent = api.i18n.getMessage("optApiKeyLabel") || "API Key (optional)";
        apiKeyInput.required = false;      // Ollama doesn't require API key

        // If URL field is empty or has OpenAI default URL, set Ollama's
        if (!mUrl.value || mUrl.value === "https://api.openai.com") {
            mUrl.value = "http://localhost:11434"; // Local Ollama default URL
        }

    } else if (type === "openai") {
        urlGroup.style.display = "block";
        mUrl.required = true;
        urlHint.textContent = "e.g.: https://api.openai.com/v1 or compatible";
        apikeyGroup.style.display = "block";
        apikeyLabel.textContent = "API Key";
        apiKeyInput.required = true; // OpenAI always requires API key

        // If field has Ollama default URL, replace with OpenAI's
        if (!mUrl.value || mUrl.value === "http://localhost:11434") {
            mUrl.value = "https://api.openai.com";
        }

    } else if (type === "prompt-api") {
        urlGroup.style.display = "none";  // Hide URL field
        mUrl.required = false;
        mUrl.value = "";
        apikeyGroup.style.display = "none"; // Hide API key field (local execution)
        apiKeyInput.required = false;
        apiKeyInput.value = "";

    } else {
        // anthropic, gemini, groq, openrouter, mistral: URL is hardcoded in drivers, not configured here
        urlGroup.style.display = "none";  // Hide URL field
        mUrl.required = false;
        mUrl.value = "";                  // Clear previous value to not save it
        apikeyGroup.style.display = "block";
        apikeyLabel.textContent = "API Key";
        apiKeyInput.required = true;      // Cloud always requires API key
    }

    // Launch model query if enough data is already configured
    // (useful when editing an existing service: loads models automatically)
    triggerFetch();
});

// ============================================================
// FORM SUBMISSION (CREATE / EDIT SERVICE)
// ============================================================

/**
 * Service form submit handler.
 *
 * Depending on whether `window.editingIndex` is null or not, it creates a new service
 * or updates an existing one at the same array position.
 * In both cases, the full list is persisted in storage.local.
 */
document.getElementById("addServiceForm").addEventListener("submit", async (e) => {
    e.preventDefault(); // Prevent normal form submission navigation

    // Read URL and normalize
    let url = document.getElementById("m_url").value.trim();
    if (url.endsWith("/")) url = url.slice(0, -1);

    const type       = document.getElementById("m_type").value;
    const modelValue = document.getElementById("m_model").value;

    // Build the service configuration object with all form fields
    const newService = {
        name:        document.getElementById("m_name").value,      // Descriptive name
        type:        type,                                          // Provider type
        url:         url,                                           // Server URL (empty for cloud)
        model:       modelValue,                                    // Selected model
        apikey:      document.getElementById("m_apikey").value,    // API Key
        prompt:      document.getElementById("m_prompt").value,    // System/instruction prompt
        promptId:    document.getElementById("m_prompt_id").value || "",
        systemPrompt:document.getElementById("m_system_prompt") ? document.getElementById("m_system_prompt").value : "",
        systemPromptId:document.getElementById("m_system_prompt_id") ? document.getElementById("m_system_prompt_id").value || "" : "", // Linked prompt ID
        useMarkdown: document.getElementById("m_use_markdown").checked, // Convert to Markdown?
        linkWeb:     document.getElementById("m_link_web").checked,     // Link to domains?
        linkedWebUrl: document.getElementById("m_linked_web_url").value.trim() // Linked domains
    };

    if (window.editingIndex !== null) {
        // EDIT MODE: replace service at the position being edited
        servicesList[window.editingIndex] = newService;
    } else {
        // CREATION MODE: add the new service to the end of the list
        servicesList.push(newService);
    }

    // Persist the updated list in storage.local
    await api.storage.local.set({ llm_services: servicesList });

    // Return form to initial state and update table
    cancelEditForm();
    renderTable();
    navigateTo('page-list'); // Go back to the list after saving
});

// ============================================================
// FORM STATE MANAGEMENT
// ============================================================

/**
 * Resets the form to "New service" state.
 *
 * Clears all fields, resets button texts,
 * hides the edit cancel button and enables default values.
 * Also triggers the m_type change so the UI adapts to the default type.
 */
function cancelEditForm() {
    window.editingIndex = null; // No longer editing any service

    document.getElementById("addServiceForm").reset(); // Clears all HTML form fields

    // Hide modal and ensure form is in the Add page
    document.getElementById("edit-modal").classList.remove('active');
    const form = document.getElementById("addServiceForm");
    document.getElementById("form-container-add").appendChild(form);

    // Update dynamic form texts for "New service" mode
    document.getElementById("submitBtn").textContent    = api.i18n.getMessage("optSaveBtn") || "Guardar Servicio";
    document.getElementById("cancelEditBtn").style.display = "none";

    // Reset model selector to empty state
    document.getElementById("m_model").innerHTML = `<option value="">${api.i18n.getMessage("optModelEmpty") || "-- Introduce configuración válida --"}</option>`;

    // Default values for prompts fields
    document.getElementById("m_prompt_id").value = "";
    document.getElementById("m_prompt").readOnly = false;
    document.getElementById("m_prompt").required = true;
    if(document.getElementById("m_system_prompt_id")) document.getElementById("m_system_prompt_id").value = "";
    if(document.getElementById("m_system_prompt")) {
        document.getElementById("m_system_prompt").value = "";
        document.getElementById("m_system_prompt").readOnly = false;
    }

    // Default checkbox values
    document.getElementById("m_use_markdown").checked = true;  // Markdown enabled by default
    document.getElementById("m_link_web").checked = false;     // No domain limitation by default
    document.getElementById("linked_url_group").style.display = "none"; // Hide domains field
    document.getElementById("m_linked_web_url").value = "";

    // Trigger "change" event on type select to update URL/API key fields visibility
    // based on the default selected type
    document.getElementById("m_type").dispatchEvent(new Event("change"));
}

// Cancel button calls cancelEditForm, discarding current changes
document.getElementById("cancelEditBtn").addEventListener("click", cancelEditForm);

// ============================================================
// SERVICE TABLE RENDERING
// ============================================================

/**
 * Completely repaints the HTML services table with the current `servicesList` data.
 *
 * Uses innerHTML to regenerate rows, simplifying the code although 
 * it destroys and recreates all event listeners. Edit/delete listeners 
 * are restored with querySelectorAll after creating rows.
 */
function renderTable() {
    const tbody = document.querySelector("#servicesTable tbody");
    tbody.innerHTML = ""; // Clear previous table content

    servicesList.forEach((srv, index) => {
        // Descriptive text for the domain filter for this table row
        const domainsText = srv.linkWeb && srv.linkedWebUrl ? srv.linkedWebUrl : "All";

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${srv.name}</td>
            <td>${srv.type}</td>
            <td>${domainsText}</td>
            <td>${srv.model}</td>
            <td>
                <!-- Edit Button: opens form preloaded with this service's data -->
                <button class="action-btn edit-btn" data-index="${index}">${api.i18n.getMessage("btnEdit") || "Editar"}</button>
                <!-- Delete Button: deletes service directly without confirmation -->
                <button class="action-btn delete-btn" data-index="${index}">${api.i18n.getMessage("btnDelete") || "Eliminar"}</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // ---- EDIT LISTENERS ----
    // Preload the form with data from the selected service.
    // We use `data-index` as a data attribute instead of a closure to avoid
    // all buttons capturing the same `index` value from a loop.
    document.querySelectorAll("#servicesTable .edit-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const idx = parseInt(e.target.getAttribute("data-index"));
            window.editingIndex = idx;
            const srv = servicesList[idx]; // The service we are going to edit

            // Move form to modal
            const form = document.getElementById("addServiceForm");
            document.getElementById("form-container-modal").appendChild(form);
            
            // Show modal
            document.getElementById("edit-modal").classList.add("active");

            // If editing a prompt-api service, ensure option is enabled/visible
            if (srv.type === "prompt-api") {
                const promptApiOpt = document.getElementById("opt_prompt_api");
                if (promptApiOpt) {
                    promptApiOpt.style.display = "";
                    promptApiOpt.disabled = false;
                }
            }

            // Preload all form fields with service values
            document.getElementById("m_name").value      = srv.name;
            document.getElementById("m_type").value      = srv.type;
            document.getElementById("m_url").value       = srv.url || "";
            document.getElementById("m_apikey").value    = srv.apikey || "";

            const promptId = srv.promptId || "";
            document.getElementById("m_prompt_id").value = promptId;
            const promptTextarea = document.getElementById("m_prompt");
            if (promptId) {
                const matched = promptsList.find(p => p.id === promptId);
                promptTextarea.value = matched ? matched.prompt : "";
                promptTextarea.readOnly = true;
                promptTextarea.required = false;
            } else {
                promptTextarea.value = srv.prompt || "";
                promptTextarea.readOnly = false;
                promptTextarea.required = true;
            }

            const sysPromptId = srv.systemPromptId || "";
            document.getElementById("m_system_prompt_id").value = sysPromptId;
            const sysPromptTextarea = document.getElementById("m_system_prompt");
            if (sysPromptId) {
                const matched = systemPromptsList.find(p => p.id === sysPromptId);
                sysPromptTextarea.value = matched ? matched.prompt : "";
                sysPromptTextarea.readOnly = true;
            } else {
                sysPromptTextarea.value = srv.systemPrompt || "";
                sysPromptTextarea.readOnly = false;
            }


            // hasOwnProperty avoids an old service without the `useMarkdown` field
            // from appearing with an unchecked checkbox (preserving default `true`)
            document.getElementById("m_use_markdown").checked = srv.hasOwnProperty("useMarkdown") ? srv.useMarkdown : true;
            document.getElementById("m_link_web").checked = srv.linkWeb || false;
            document.getElementById("m_linked_web_url").value = srv.linkedWebUrl || "";
            document.getElementById("linked_url_group").style.display = srv.linkWeb ? "block" : "none";

            // Update form texts for "Edit" mode
            document.getElementById("submitBtn").textContent = api.i18n.getMessage("optSaveChanges") || "Guardar Cambios";
            document.getElementById("cancelEditBtn").style.display = "inline-block";

            // Trigger change on m_type so the UI adapts to the edited service type
            // (shows/hides URL and API key fields based on type)
            document.getElementById("m_type").dispatchEvent(new Event("change"));

            // Wait 300ms for the models request to finish before selecting the model.
            // Without the timeout, the select wouldn't have the options available yet
            // when we try to assign the value. Delay gives fetchModelsCombo time to receive the response.
            setTimeout(() => {
                const mModel = document.getElementById("m_model");

                // If the service's model is not in the received list (e.g.: it was deleted from server),
                // we add it manually so the user can see it and change it if they want.
                if (!Array.from(mModel.options).some(o => o.value === srv.model)) {
                    const opt = document.createElement("option");
                    opt.value = srv.model;
                    opt.textContent = srv.model;
                    mModel.appendChild(opt);
                }
                mModel.value = srv.model; // Select saved model

            }, 300); // 300ms: estimated time for fetchModels response to arrive

            // Scroll to the top of the modal just in case
            document.getElementById("form-container-modal").scrollTop = 0;
        });
    });

    // ---- DELETE LISTENERS ----
    // Delete service at indicated index and persist updated list.
    // No confirmation requested by design (button is clearly labeled).
    document.querySelectorAll("#servicesTable .delete-btn").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            const idx = parseInt(e.target.getAttribute("data-index"));
            servicesList.splice(idx, 1); // Remove element from in-memory array
            await api.storage.local.set({ llm_services: servicesList }); // Persist change
            renderTable(); // Re-render table to reflect deletion
        });
    });
}

// ============================================================
// PROMPTS DROPDOWN AND SELECT EVENT LISTENERS
// ============================================================

function populatePromptsDropdown() {
    const select = document.getElementById("m_prompt_id");
    if (!select) return;

    select.innerHTML = `<option value="" data-i18n="optSelectPromptDefault">${api.i18n.getMessage("optSelectPromptDefault") || "-- Utilizar prompt específico --"}</option>`;

    promptsList.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        select.appendChild(opt);
    });
}

document.getElementById("m_prompt_id").addEventListener("change", (e) => {
    const promptId = e.target.value;
    const promptTextarea = document.getElementById("m_prompt");
    if (promptId) {
        const matched = promptsList.find(p => p.id === promptId);
        if (matched) {
            promptTextarea.value = matched.prompt;
            promptTextarea.readOnly = true;
            promptTextarea.required = false;
        }
    } else {
        promptTextarea.value = "";
        promptTextarea.readOnly = false;
        promptTextarea.required = true;
    }
});

// ============================================================
// PROMPTS TABLE RENDERING
// ============================================================

function renderPromptsTable() {
    const tbody = document.querySelector("#promptsTable tbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    promptsList.forEach((p, index) => {
        const previewText = p.prompt.length > 60 ? p.prompt.substring(0, 57) + "..." : p.prompt;

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${p.name}</td>
            <td style="color:var(--color-text-muted); font-size:0.9rem;">${previewText}</td>
            <td>
                <button class="action-btn edit-btn edit-prompt-btn" data-index="${index}">${api.i18n.getMessage("btnEdit") || "Editar"}</button>
                <button class="action-btn delete-btn delete-prompt-btn" data-index="${index}">${api.i18n.getMessage("btnDelete") || "Eliminar"}</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    document.querySelectorAll(".edit-prompt-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const idx = parseInt(e.target.getAttribute("data-index"));
            window.editingPromptIndex = idx;
            const p = promptsList[idx];

            const form = document.getElementById("addPromptForm");
            document.getElementById("prompt-form-container-modal").appendChild(form);
            document.getElementById("edit-prompt-modal").classList.add("active");

            document.getElementById("p_name").value = p.name;
            document.getElementById("p_prompt").value = p.prompt;

            document.getElementById("promptSubmitBtn").textContent = api.i18n.getMessage("optSaveChanges") || "Guardar Cambios";
            document.getElementById("cancelPromptEditBtn").style.display = "inline-block";
        });
    });

    document.querySelectorAll(".delete-prompt-btn").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            const idx = parseInt(e.target.getAttribute("data-index"));
            const deletedPrompt = promptsList[idx];

            promptsList.splice(idx, 1);
            await api.storage.local.set({ prompts: promptsList });

            // If a service was using the deleted prompt, fallback to local prompt
            let servicesUpdated = false;
            servicesList.forEach(srv => {
                if (srv.promptId === deletedPrompt.id) {
                    srv.promptId = "";
                    srv.prompt = deletedPrompt.prompt; // Copy prompt text to service so it is not lost!
                    servicesUpdated = true;
                }
            });
            if (servicesUpdated) {
                await api.storage.local.set({ llm_services: servicesList });
                renderTable();
            }

            renderPromptsTable();
            populatePromptsDropdown();
        });
    });
}

// ============================================================
// PROMPT FORM STATE AND SUBMISSION
// ============================================================

function cancelPromptEditForm() {
    window.editingPromptIndex = null;

    document.getElementById("addPromptForm").reset();

    document.getElementById("edit-prompt-modal").classList.remove('active');
    const form = document.getElementById("addPromptForm");
    document.getElementById("prompt-form-container-add").appendChild(form);

    document.getElementById("promptSubmitBtn").textContent = api.i18n.getMessage("optSavePromptBtn") || "Guardar Prompt";
    document.getElementById("cancelPromptEditBtn").style.display = "none";
}

document.getElementById("cancelPromptEditBtn").addEventListener("click", cancelPromptEditForm);
document.getElementById("closePromptModalBtn").addEventListener("click", cancelPromptEditForm);

document.getElementById("addPromptForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const name = document.getElementById("p_name").value.trim();
    const promptText = document.getElementById("p_prompt").value.trim();

    if (window.editingPromptIndex !== null) {
        const p = promptsList[window.editingPromptIndex];
        p.name = name;
        p.prompt = promptText;
    } else {
        const newPrompt = {
            id: "prompt_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9),
            name: name,
            prompt: promptText
        };
        promptsList.push(newPrompt);
    }

    await api.storage.local.set({ prompts: promptsList });

    cancelPromptEditForm();
    renderPromptsTable();
    populatePromptsDropdown();
    renderSysPromptsTable();
    populateSysPromptsDropdown();
    navigateTo('page-prompts-list');
});


// ============================================================
// SYSTEM PROMPTS DROPDOWN AND SELECT EVENT LISTENERS
// ============================================================

function populateSysPromptsDropdown() {
    const select = document.getElementById("m_system_prompt_id");
    if (!select) return;

    select.innerHTML = `<option value="" data-i18n="optSelectSysPromptDefault">${api.i18n.getMessage("optSelectSysPromptDefault") || "-- Sin System Prompt --"}</option>`;

    systemPromptsList.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        select.appendChild(opt);
    });
}

document.getElementById("m_system_prompt_id").addEventListener("change", (e) => {
    const promptId = e.target.value;
    const promptTextarea = document.getElementById("m_system_prompt");
    if (promptId) {
        const matched = systemPromptsList.find(p => p.id === promptId);
        if (matched) {
            promptTextarea.value = matched.prompt;
            promptTextarea.readOnly = true;
            // system prompt is optional, so we don't set required=true
        }
    } else {
        promptTextarea.value = "";
        promptTextarea.readOnly = false;
    }
});

// ============================================================
// SYSTEM PROMPTS TABLE RENDERING
// ============================================================

function renderSysPromptsTable() {
    const tbody = document.querySelector("#sysPromptsTable tbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    systemPromptsList.forEach((p, index) => {
        const previewText = p.prompt.length > 60 ? p.prompt.substring(0, 57) + "..." : p.prompt;

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${p.name}</td>
            <td style="color:var(--color-text-muted); font-size:0.9rem;">${previewText}</td>
            <td>
                <button class="action-btn edit-btn edit-sys-prompt-btn" data-index="${index}">${api.i18n.getMessage("btnEdit") || "Editar"}</button>
                <button class="action-btn delete-btn delete-sys-prompt-btn" data-index="${index}">${api.i18n.getMessage("btnDelete") || "Eliminar"}</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    document.querySelectorAll(".edit-sys-prompt-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const idx = parseInt(e.target.getAttribute("data-index"));
            window.editingSysPromptIndex = idx;
            const p = systemPromptsList[idx];

            const form = document.getElementById("addSysPromptForm");
            document.getElementById("sys-prompt-form-container-modal").appendChild(form);
            document.getElementById("edit-sys-prompt-modal").classList.add("active");

            document.getElementById("p_sys_name").value = p.name;
            document.getElementById("p_sys_prompt").value = p.prompt;

            document.getElementById("sysPromptSubmitBtn").textContent = api.i18n.getMessage("optSaveChanges") || "Guardar Cambios";
            document.getElementById("cancelSysPromptEditBtn").style.display = "inline-block";
        });
    });

    document.querySelectorAll(".delete-sys-prompt-btn").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            const idx = parseInt(e.target.getAttribute("data-index"));
            const deletedPrompt = systemPromptsList[idx];

            systemPromptsList.splice(idx, 1);
            await api.storage.local.set({ systemPrompts: systemPromptsList });

            let servicesUpdated = false;
            servicesList.forEach(srv => {
                if (srv.systemPromptId === deletedPrompt.id) {
                    srv.systemPromptId = "";
                    srv.systemPrompt = deletedPrompt.prompt;
                    servicesUpdated = true;
                }
            });
            if (servicesUpdated) {
                await api.storage.local.set({ llm_services: servicesList });
                renderTable();
            }

            renderSysPromptsTable();
            populateSysPromptsDropdown();
        });
    });
}

// ============================================================
// SYSTEM PROMPT FORM STATE AND SUBMISSION
// ============================================================

function cancelSysPromptEditForm() {
    window.editingSysPromptIndex = null;

    document.getElementById("addSysPromptForm").reset();

    document.getElementById("edit-sys-prompt-modal").classList.remove('active');
    const form = document.getElementById("addSysPromptForm");
    document.getElementById("sys-prompt-form-container-add").appendChild(form);

    document.getElementById("sysPromptSubmitBtn").textContent = api.i18n.getMessage("optSaveSysPromptBtn") || "Guardar System Prompt";
    document.getElementById("cancelSysPromptEditBtn").style.display = "none";
}

document.getElementById("cancelSysPromptEditBtn").addEventListener("click", cancelSysPromptEditForm);
document.getElementById("closeSysPromptModalBtn").addEventListener("click", cancelSysPromptEditForm);

document.getElementById("addSysPromptForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const name = document.getElementById("p_sys_name").value.trim();
    const promptText = document.getElementById("p_sys_prompt").value.trim();

    if (window.editingSysPromptIndex !== null) {
        const p = systemPromptsList[window.editingSysPromptIndex];
        p.name = name;
        p.prompt = promptText;
    } else {
        const newPrompt = {
            id: "sysprompt_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9),
            name: name,
            prompt: promptText
        };
        systemPromptsList.push(newPrompt);
    }

    await api.storage.local.set({ systemPrompts: systemPromptsList });

    cancelSysPromptEditForm();
    renderSysPromptsTable();
    populateSysPromptsDropdown();
    navigateTo('page-sys-prompts-list');
});


// ============================================================
// IMPORT / EXPORT LOGIC
// ============================================================

async function deriveKey(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        "PBKDF2",
        false,
        ["deriveBits", "deriveKey"]
    );
    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt,
            iterations: 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}


async function compressData(data) {
    const stream = new Blob([data]).stream();
    const compressedStream = stream.pipeThrough(new CompressionStream('gzip'));
    const response = new Response(compressedStream);
    return await response.arrayBuffer();
}

async function decompressData(buffer) {
    const stream = new Blob([buffer]).stream();
    const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
    const response = new Response(decompressedStream);
    return await response.arrayBuffer();
}

document.getElementById('btnExport').addEventListener('click', async () => {
    const password = document.getElementById('export_password').value;
    const confirmPassword = document.getElementById('export_password_confirm').value;

    if (password !== confirmPassword) {
        alert(api.i18n.getMessage("errPasswordMismatch") || "Las contraseñas no coinciden.");
        return;
    }
    
    const data = await api.storage.local.get(["llm_services", "prompts", "systemPrompts"]);
    const payload = JSON.stringify(data);
    
    let exportObj = {
        signature: "content-analyzer-config-v1",
        encrypted: false
    };

    if (password) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        
        const key = await deriveKey(password, salt);
        
        const enc = new TextEncoder();
        const compressedData = await compressData(enc.encode(payload));
        
        const encryptedContent = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            key,
            compressedData
        );
        
        exportObj.encrypted = true;
        exportObj.compressed = true;
        exportObj.salt = arrayBufferToBase64(salt);
        exportObj.iv = arrayBufferToBase64(iv);
        exportObj.data = arrayBufferToBase64(encryptedContent);
    } else {
        exportObj.data = data;
    }
    
    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `content-analyzer-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
    alert(api.i18n.getMessage("msgExportSuccess") || "Configuración exportada exitosamente.");
    document.getElementById('export_password').value = '';
});

document.getElementById('btnImport').addEventListener('click', async () => {
    const fileInput = document.getElementById('import_file');
    const password = document.getElementById('import_password').value;
    
    if (!fileInput.files.length) {
        alert(api.i18n.getMessage("errFileRead") || "Error al leer el archivo.");
        return;
    }
    
    const file = fileInput.files[0];
    const reader = new FileReader();
    
    reader.onload = async (e) => {
        try {
            const importedObj = JSON.parse(e.target.result);
            
            if (importedObj.signature !== "content-analyzer-config-v1") {
                throw new Error("Invalid signature");
            }
            
            let dataToSave;
            
            if (importedObj.encrypted) {
                if (!password) {
                    alert(api.i18n.getMessage("errInvalidPassword") || "Contraseña incorrecta o archivo corrupto.");
                    return;
                }
                
                try {
                    const salt = base64ToArrayBuffer(importedObj.salt);
                    const iv = base64ToArrayBuffer(importedObj.iv);
                    const encryptedData = base64ToArrayBuffer(importedObj.data);
                    
                    const key = await deriveKey(password, salt);
                    
                    const decryptedContent = await crypto.subtle.decrypt(
                        { name: "AES-GCM", iv: new Uint8Array(iv) },
                        key,
                        encryptedData
                    );
                    
                    let finalContent = decryptedContent;
                    if (importedObj.compressed) {
                        finalContent = await decompressData(decryptedContent);
                    }
                    
                    const dec = new TextDecoder();
                    dataToSave = JSON.parse(dec.decode(finalContent));
                } catch (cryptoErr) {
                    alert(api.i18n.getMessage("errInvalidPassword") || "Contraseña incorrecta o archivo corrupto.");
                    return;
                }
            } else {
                dataToSave = importedObj.data;
            }
            
            await api.storage.local.set({
                llm_services: dataToSave.llm_services || [],
                prompts: dataToSave.prompts || [],
                systemPrompts: dataToSave.systemPrompts || []
            });
            
            alert(api.i18n.getMessage("msgImportSuccess") || "Configuración importada exitosamente.");
            
            location.reload();
            
        } catch (err) {
            console.error(err);
            if (err.message === "Invalid signature") {
                alert(api.i18n.getMessage("errInvalidSignature") || "Archivo de configuración inválido (firma inválida).");
            } else {
                alert(api.i18n.getMessage("errFileRead") || "Error al leer el archivo.");
            }
        }
    };
    
    reader.readAsText(file);
});

