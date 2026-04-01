// Variables globales de estado para la lista de servicios y el índice de edición activa
const api = window.browser || window.chrome;
let servicesList = [];
window.editingIndex = null;

document.addEventListener("DOMContentLoaded", loadServices);

// ---- INIT: Carga inicial de datos ----
// Recupera la lista de servicios LLM almacenada en Storage y repinta la tabla
async function loadServices() {
    const data = await api.storage.local.get("llm_services");
    servicesList = data.llm_services || [];
    renderTable();
    cancelEditForm();
}

// Referencias a los campos del formulario
const urlInput = document.getElementById("m_url");
const modelSelect = document.getElementById("m_model");
const apiKeyInput = document.getElementById("m_apikey");
const typeInput = document.getElementById("m_type");
let fetchTimeout;

// ---- LÓGICA DE OPTIMIZACIÓN DE BÚSQUEDA (Debounce) ----
// Evita ahogar al servidor con peticiones mientras el usuario teclea la URL o API Key
function triggerFetch() {
    clearTimeout(fetchTimeout);
    fetchTimeout = setTimeout(() => {
        fetchModelsCombo(urlInput.value.trim(), typeInput.value, apiKeyInput.value.trim());
    }, 500);
}

urlInput.addEventListener("input", triggerFetch);
apiKeyInput.addEventListener("input", triggerFetch);

document.getElementById("btnReloadModels").addEventListener("click", () => {
    fetchModelsCombo(urlInput.value.trim(), typeInput.value, apiKeyInput.value.trim());
});

// ---- CONSULTA DE MODELOS A LA API ----
// Obtiene de fondo (Background) un listado de modelos compatibles basándose en el "tipo" de proveedor
function fetchModelsCombo(url, type, apikey) {
    if ((type === "ollama" || type === "openai") && (!url || !url.startsWith("http"))) {
        return;
    }
    if ((type === "openai" || type === "anthropic" || type === "gemini") && !apikey) {
        return;
    }

    if (url.endsWith("/")) url = url.slice(0, -1);

    modelSelect.innerHTML = `<option value="">${api.i18n.getMessage("optModelLoading") || "Buscando modelos..."}</option>`;
    
    api.runtime.sendMessage({ action: "fetchModels", serviceType: type, url: url, apikey: apikey })
        .then(res => {
            modelSelect.innerHTML = '';
            if (res && res.success) {
                if (res.data && res.data.models && res.data.models.length > 0) {
                    const sortedModels = res.data.models.sort((a, b) => a.name.localeCompare(b.name));
                    sortedModels.forEach(m => {
                        const opt = document.createElement("option");
                        opt.value = m.name;
                        opt.textContent = m.name;
                        if (window.editingIndex !== null && servicesList[window.editingIndex].model === m.name) {
                            opt.selected = true;
                        }
                        modelSelect.appendChild(opt);
                    });
                } else {
                    modelSelect.innerHTML = `<option value="">${api.i18n.getMessage("errNoModels") || "No hay modelos"}</option>`;
                }
            } else {
                modelSelect.innerHTML = `<option value="">${api.i18n.getMessage("errConn") || "Error al conectar"}</option>`;
            }
        })
        .catch(err => {
            modelSelect.innerHTML = `<option value="">${api.i18n.getMessage("errConn") || "Error al conectar"}</option>`;
        });
}

document.getElementById("m_link_web").addEventListener("change", (e) => {
    document.getElementById("linked_url_group").style.display = e.target.checked ? "block" : "none";
});

document.getElementById("m_type").addEventListener("change", (e) => {
    const type = e.target.value;
    const urlGroup = document.getElementById("url_group");
    const mUrl = document.getElementById("m_url");
    const modelSelect = document.getElementById("m_model");
    const apikeyLabel = document.getElementById("apikey_label");
    const apiKeyInput = document.getElementById("m_apikey");
    const urlHint = document.getElementById("url_hint");

    modelSelect.innerHTML = `<option value="">${api.i18n.getMessage("optModelEmpty") || "-- Introduce configuración válida --"}</option>`;

    if (type === "ollama") {
        urlGroup.style.display = "block";
        mUrl.required = true;
        urlHint.textContent = api.i18n.getMessage("optUrlHint") || "Al escribir la URL se consultarán los modelos disponibles.";
        apikeyLabel.textContent = api.i18n.getMessage("optApiKeyLabel") || "Clave de API (opcional)";
        apiKeyInput.required = false;
        if (!mUrl.value || mUrl.value === "https://api.openai.com") mUrl.value = "http://localhost:11434";
    } else if (type === "openai") {
        urlGroup.style.display = "block";
        mUrl.required = true;
        urlHint.textContent = "Ej: https://api.openai.com/v1 o compatible";
        apikeyLabel.textContent = "Clave de API";
        apiKeyInput.required = true;
        if (!mUrl.value || mUrl.value === "http://localhost:11434") mUrl.value = "https://api.openai.com";
    } else {
        // anthropic, gemini
        urlGroup.style.display = "none";
        mUrl.required = false;
        mUrl.value = "";
        apikeyLabel.textContent = "Clave de API";
        apiKeyInput.required = true;
    }
    
    // Trigger un fetch si ya hay datos suficientes
    triggerFetch();
});

// ---- MANEJADOR DE ENVÍO DE FORMULARIO (Crear/Editar) ----
// Guarda los parámetros del servicio interactivo de inteligencia artificial actual
document.getElementById("addServiceForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    let url = document.getElementById("m_url").value.trim();
    if(url.endsWith("/")) url = url.slice(0, -1);

    const type = document.getElementById("m_type").value;
    const modelValue = document.getElementById("m_model").value;

    const newService = {
        name: document.getElementById("m_name").value,
        type: type,
        url: url,
        model: modelValue,
        apikey: document.getElementById("m_apikey").value,
        prompt: document.getElementById("m_prompt").value,
        useMarkdown: document.getElementById("m_use_markdown").checked,
        linkWeb: document.getElementById("m_link_web").checked,
        linkedWebUrl: document.getElementById("m_linked_web_url").value.trim()
    };
    
    if (window.editingIndex !== null) {
        servicesList[window.editingIndex] = newService;
    } else {
        servicesList.push(newService);
    }
    await api.storage.local.set({ llm_services: servicesList });
    
    cancelEditForm();
    renderTable();
});

// ---- GESTIÓN DE LA INTERFAZ TRAS AÑADIR/EDITAR ----
// Limpia y reinicia todos los campos del formulario para un uso fresco
function cancelEditForm() {
    window.editingIndex = null;
    document.getElementById("addServiceForm").reset();
    document.getElementById("formTitle").textContent = api.i18n.getMessage("optAddService") || "Añadir Nuevo Servicio";
    document.getElementById("submitBtn").textContent = api.i18n.getMessage("optSaveBtn") || "Guardar Servicio";
    document.getElementById("cancelEditBtn").style.display = "none";
    document.getElementById("m_model").innerHTML = `<option value="">${api.i18n.getMessage("optModelEmpty") || "-- Introduce configuración válida --"}</option>`;
    document.getElementById("m_use_markdown").checked = true;
    document.getElementById("m_link_web").checked = false;
    document.getElementById("linked_url_group").style.display = "none";
    document.getElementById("m_linked_web_url").value = "";
    document.getElementById("m_type").dispatchEvent(new Event("change"));
}

document.getElementById("cancelEditBtn").addEventListener("click", cancelEditForm);

// ---- RENDERIZADO VISUAL ----
// Pinta todos los elementos del Storage en la tabla visible
function renderTable() {
    const tbody = document.querySelector("#servicesTable tbody");
    tbody.innerHTML = "";
    servicesList.forEach((srv, index) => {
        const domainsText = srv.linkWeb && srv.linkedWebUrl ? srv.linkedWebUrl : "Todos";
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${srv.name}</td>
            <td>${srv.type}</td>
            <td>${domainsText}</td>
            <td>${srv.model}</td>
            <td>
                <button class="edit-btn" data-index="${index}" style="background:#f59e0b; padding:5px 10px; font-size:12px; margin-right:5px; color:white; border:none; border-radius:4px; cursor:pointer;">${api.i18n.getMessage("btnEdit") || "Editar"}</button>
                <button class="delete-btn" data-index="${index}">${api.i18n.getMessage("btnDelete") || "Eliminar"}</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
    
    document.querySelectorAll(".edit-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const idx = parseInt(e.target.getAttribute("data-index"));
            window.editingIndex = idx;
            const srv = servicesList[idx];
            
            document.getElementById("m_name").value = srv.name;
            document.getElementById("m_type").value = srv.type;
            document.getElementById("m_url").value = srv.url || "";
            document.getElementById("m_apikey").value = srv.apikey || "";
            document.getElementById("m_prompt").value = srv.prompt;
            document.getElementById("m_use_markdown").checked = srv.hasOwnProperty("useMarkdown") ? srv.useMarkdown : true;
            document.getElementById("m_link_web").checked = srv.linkWeb || false;
            document.getElementById("m_linked_web_url").value = srv.linkedWebUrl || "";
            document.getElementById("linked_url_group").style.display = srv.linkWeb ? "block" : "none";
            
            document.getElementById("formTitle").textContent = api.i18n.getMessage("optEditService") || "Editar Servicio";
            document.getElementById("submitBtn").textContent = api.i18n.getMessage("optSaveChanges") || "Guardar Cambios";
            document.getElementById("cancelEditBtn").style.display = "inline-block";
            
            document.getElementById("m_type").dispatchEvent(new Event("change"));
            
            setTimeout(() => {
                const mModel = document.getElementById("m_model");
                if (!Array.from(mModel.options).some(o => o.value === srv.model)) {
                    const opt = document.createElement("option");
                    opt.value = srv.model;
                    opt.textContent = srv.model;
                    mModel.appendChild(opt);
                }
                mModel.value = srv.model;
            }, 300);
            
            window.scrollTo(0, 0);
        });
    });
    
    document.querySelectorAll(".delete-btn").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            const idx = parseInt(e.target.getAttribute("data-index"));
            servicesList.splice(idx, 1);
            await api.storage.local.set({ llm_services: servicesList });
            renderTable();
        });
    });
}
