/**
 * @file options.js
 * @description Logic for the extension's configuration page (options.html).
 *
 * This page allows the user to manage the AI services available in the extension.
 * For each service, the following can be configured:
 *   - Descriptive name of the service
 *   - Provider type: ollama | openai | anthropic | gemini
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

/**
 * Index (in `servicesList`) of the service currently being edited.
 * It is `null` when the form is in "New service" mode.
 * Exposed on `window` to be accessible from DOM button handlers.
 * @type {number|null}
 */
window.editingIndex = null;

// Start data loading when the DOM is ready for manipulation
document.addEventListener("DOMContentLoaded", loadServices);

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * Loads the services saved in storage.local and renders the table.
 * Also initializes the form in "New service" (empty) state.
 */
async function loadServices() {
    const data = await api.storage.local.get("llm_services");
    servicesList = data.llm_services || [];
    renderTable();
    cancelEditForm(); // Sets the form to a clean initial state
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
    fetchModelsCombo(urlInput.value.trim(), typeInput.value, apiKeyInput.value.trim());
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
 *   - OpenAI, Anthropic, and Gemini require an API key for authentication.
 *
 * @param {string} url    - Server base URL (empty for Anthropic/Gemini).
 * @param {string} type   - Provider type: "ollama"|"openai"|"anthropic"|"gemini".
 * @param {string} apikey - API Key (can be empty for Ollama without authentication).
 */
function fetchModelsCombo(url, type, apikey) {
    // Validation: Ollama and OpenAI need a valid URL starting with "http" or "https"
    if ((type === "ollama" || type === "openai") && (!url || !url.startsWith("http"))) {
        return; // Do nothing if the URL is incomplete
    }

    // Validation: Cloud providers need an API key for authentication
    if ((type === "openai" || type === "anthropic" || type === "gemini") && !apikey) {
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
    const urlHint      = document.getElementById("url_hint");

    // Reset model selector when changing provider (models are different)
    modelSelect.innerHTML = `<option value="">${api.i18n.getMessage("optModelEmpty") || "-- Enter valid configuration --"}</option>`;

    if (type === "ollama") {
        urlGroup.style.display = "block";  // Show URL group
        mUrl.required = true;              // URL is mandatory for Ollama
        urlHint.textContent = api.i18n.getMessage("optUrlHint") || "Models will be queried as you type the URL.";
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
        apikeyLabel.textContent = "API Key";
        apiKeyInput.required = true; // OpenAI always requires API key

        // If field has Ollama default URL, replace with OpenAI's
        if (!mUrl.value || mUrl.value === "http://localhost:11434") {
            mUrl.value = "https://api.openai.com";
        }

    } else {
        // anthropic, gemini: URL is hardcoded in drivers, not configured here
        urlGroup.style.display = "none";  // Hide URL field
        mUrl.required = false;
        mUrl.value = "";                  // Clear previous value to not save it
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

    // Update dynamic form texts for "New service" mode
    document.getElementById("formTitle").textContent    = api.i18n.getMessage("optAddService") || "Add New Service";
    document.getElementById("submitBtn").textContent    = api.i18n.getMessage("optSaveBtn") || "Save Service";
    document.getElementById("cancelEditBtn").style.display = "none";

    // Reset model selector to empty state
    document.getElementById("m_model").innerHTML = `<option value="">${api.i18n.getMessage("optModelEmpty") || "-- Enter valid configuration --"}</option>`;

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
                <button class="edit-btn" data-index="${index}" style="background:#f59e0b; padding:5px 10px; font-size:12px; margin-right:5px; color:white; border:none; border-radius:4px; cursor:pointer;">${api.i18n.getMessage("btnEdit") || "Edit"}</button>
                <!-- Delete Button: deletes service directly without confirmation -->
                <button class="delete-btn" data-index="${index}">${api.i18n.getMessage("btnDelete") || "Delete"}</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // ---- EDIT LISTENERS ----
    // Preload the form with data from the selected service.
    // We use `data-index` as a data attribute instead of a closure to avoid
    // all buttons capturing the same `index` value from a loop.
    document.querySelectorAll(".edit-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const idx = parseInt(e.target.getAttribute("data-index"));
            window.editingIndex = idx;
            const srv = servicesList[idx]; // The service we are going to edit

            // Preload all form fields with service values
            document.getElementById("m_name").value      = srv.name;
            document.getElementById("m_type").value      = srv.type;
            document.getElementById("m_url").value       = srv.url || "";
            document.getElementById("m_apikey").value    = srv.apikey || "";
            document.getElementById("m_prompt").value    = srv.prompt;

            // hasOwnProperty avoids an old service without the `useMarkdown` field
            // from appearing with an unchecked checkbox (preserving default `true`)
            document.getElementById("m_use_markdown").checked = srv.hasOwnProperty("useMarkdown") ? srv.useMarkdown : true;
            document.getElementById("m_link_web").checked = srv.linkWeb || false;
            document.getElementById("m_linked_web_url").value = srv.linkedWebUrl || "";
            document.getElementById("linked_url_group").style.display = srv.linkWeb ? "block" : "none";

            // Update form texts for "Edit" mode
            document.getElementById("formTitle").textContent = api.i18n.getMessage("optEditService") || "Edit Service";
            document.getElementById("submitBtn").textContent = api.i18n.getMessage("optSaveChanges") || "Save Changes";
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

            // Scroll to the top of the page to make the form visible
            window.scrollTo(0, 0);
        });
    });

    // ---- DELETE LISTENERS ----
    // Delete service at indicated index and persist updated list.
    // No confirmation requested by design (button is clearly labeled).
    document.querySelectorAll(".delete-btn").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            const idx = parseInt(e.target.getAttribute("data-index"));
            servicesList.splice(idx, 1); // Remove element from in-memory array
            await api.storage.local.set({ llm_services: servicesList }); // Persist change
            renderTable(); // Re-render table to reflect deletion
        });
    });
}
