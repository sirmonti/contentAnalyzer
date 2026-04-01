document.addEventListener("DOMContentLoaded", async () => {
    const api = window.browser || window.chrome;
    // Cargar la lista de servicios LLM almacenada en la configuración
    const data = await api.storage.local.get("llm_services");
    const container = document.getElementById("servicesContainer");
    let servicesList = data.llm_services || [];
    
    // Obtener la pestaña actualmente visible para usarla en los filtros de dominio
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const tabUrl = tabs && tabs.length > 0 ? tabs[0].url : "";

    // Filtrar los servicios: solo mostrar los vinculados a (todos) o a el dominio en el que nos encontramos
    servicesList = servicesList.filter(m => {
        if (!m.linkWeb || !m.linkedWebUrl) return true; // Si no tiene limitación de dominio
        
        const domains = m.linkedWebUrl.split(',').map(d => d.trim().toLowerCase()).filter(d => d.length > 0);
        if (domains.length === 0) return true;
        
        try {
            const urlObj = new URL(tabUrl);
            const hostname = urlObj.hostname.toLowerCase();
            
            return domains.some(domain => {
                return hostname === domain || hostname.endsWith('.' + domain);
            });
        } catch (e) {
            return false;
        }
    });

    container.innerHTML = "";
    if (servicesList.length === 0) {
        // Enviar mensaje informativo si la extensión está vacía o el dominio actual no tiene servicios asignados
        container.innerHTML = `<div style="font-size:12px;color:#999">${api.i18n.getMessage("errNoServices") || "No hay servicios activos."}</div>`;
    } else {
        // Generar dinámicamente cada botón basado en los modelos guardados
        servicesList.forEach(m => {
            const btn = document.createElement("button");
            btn.className = "btn btn-service";
            btn.textContent = "🤖 " + m.name;
            btn.addEventListener("click", () => handleAction("llm", m));
            container.appendChild(btn);
        });
    }

    document.getElementById("btnDisk").addEventListener("click", () => {
        handleAction("disk");
    });
    
    document.getElementById("openOptions").addEventListener("click", (e) => {
        e.preventDefault();
        api.runtime.openOptionsPage();
        window.close();
    });
});

function showError(msg) {
    const errorDiv = document.getElementById("errorMsg");
    errorDiv.textContent = msg;
    errorDiv.style.display = "block";
}

// Función principal invocada al pulsar un servicio o 'grabar en disco'.
// Su función es inyectar un script en la página actual del usuario que permite interaccionar con ella (la caja verde).
async function handleAction(type, serviceData = null) {
    try {
        const api = window.browser || window.chrome;
        const tabs = await api.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0) throw new Error(api.i18n.getMessage("errNoTab") || "No hay pestaña activa");
        const tab = tabs[0];
        
        // Primero inyectamos la librería turndown que convierte HTML a Markdown
        await api.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["turndown.js"]
        });
        
        // Luego inyectamos nuestra lógica para el selector interactivo (hover verde)
        await api.scripting.executeScript({
            target: { tabId: tab.id },
            func: (actionType, servData, srvMsgTip, srvMsgCapAll, srvMsgErrParse) => {
                if (window._articleExtractorActive) return; // Evitar ejecuciones múltiples superpuestas
                window._articleExtractorActive = true;

                let lastHovered = null;
                const originalOutlines = new WeakMap();
                const originalCursors = new WeakMap();

                // Lógica decorativa: Resalta en verde el elemento HTML bajo el cursor
                const mouseOverHandler = (e) => {
                    const tip = document.getElementById('article-extractor-tip');
                    if (tip && (e.target === tip || tip.contains(e.target))) return;

                    if (lastHovered) {
                        lastHovered.style.outline = originalOutlines.get(lastHovered) || '';
                        lastHovered.style.cursor = originalCursors.get(lastHovered) || '';
                    }
                    lastHovered = e.target;
                    if (!originalOutlines.has(lastHovered)) {
                        originalOutlines.set(lastHovered, lastHovered.style.outline);
                        originalCursors.set(lastHovered, lastHovered.style.cursor);
                    }
                    lastHovered.style.outline = '3px solid #10b981';
                    lastHovered.style.cursor = 'crosshair';
                    e.stopPropagation();
                };

                // Lógica extractora: Cuando el usuario hace click, capturamos el elemento y frenamos el selector
                const clickHandler = (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    // Limpiar eventos para retornar la pantalla a la normalidad
                    document.removeEventListener('mouseover', mouseOverHandler, true);
                    document.removeEventListener('click', clickHandler, true);
                    
                    if (lastHovered) {
                        lastHovered.style.outline = originalOutlines.get(lastHovered) || '';
                        lastHovered.style.cursor = originalCursors.get(lastHovered) || '';
                    }
                    window._articleExtractorActive = false;
                    
                    let targetToParse = e.target;
                    if (e.target.id === 'article-extractor-capture-all') {
                        targetToParse = document.body;
                    }

                    const tip = document.getElementById('article-extractor-tip');
                    if (tip) tip.remove();

                    try {
                        let markdown;
                        // Comprobar si se ha pedido explícitamente contenido en crudo (HTML) o convertirlo a sintaxis Markdown
                        if (servData && servData.hasOwnProperty('useMarkdown') && servData.useMarkdown === false) {
                            markdown = targetToParse.outerHTML || targetToParse.innerHTML;
                        } else {
                            const t = new TurndownService({ headingStyle: 'atx' });
                            markdown = t.turndown(targetToParse.outerHTML || targetToParse.innerHTML);
                        }
                        const extApi = window.browser || window.chrome;
                        // Mandar toda la selección en background, pasando toda la metadata útil (idiomas, urls...)
                        extApi.runtime.sendMessage({
                            action: "processSelection",
                            type: actionType,
                            serviceData: servData,
                            markdown: markdown,
                            title: document.title,
                            url: window.location.href,
                            domain: window.location.hostname,
                            lang: document.documentElement.lang || "NONE",
                            syslang: navigator.language
                        });
                    } catch (err) {
                        alert(srvMsgErrParse.replace("$1", err.message));
                    }
                };

                document.addEventListener('mouseover', mouseOverHandler, true);
                document.addEventListener('click', clickHandler, true);
                
                const tip = document.createElement('div');
                tip.id = 'article-extractor-tip';
                tip.style.position = 'fixed';
                tip.style.top = '20px';
                tip.style.right = '20px';
                tip.style.background = '#10b981';
                tip.style.color = '#fff';
                tip.style.padding = '12px 20px';
                tip.style.borderRadius = '8px';
                tip.style.fontWeight = 'bold';
                tip.style.zIndex = '2147483647';
                tip.style.pointerEvents = 'auto';
                tip.style.fontFamily = 'system-ui, sans-serif';
                tip.style.boxShadow = '0 4px 6px rgba(0,0,0,0.3)';
                tip.innerHTML = `
                    <div style="margin-bottom: 8px;">${srvMsgTip}</div>
                    <button id="article-extractor-capture-all" style="width: 100%; border: none; background: #fff; color: #10b981; padding: 6px; border-radius: 4px; cursor: pointer; font-weight: bold; box-shadow: 0 1px 3px rgba(0,0,0,0.2);">${srvMsgCapAll}</button>
                `;
                document.body.appendChild(tip);
            },
            args: [type, serviceData, api.i18n.getMessage("tipInstruction"), api.i18n.getMessage("capAllBtn"), api.i18n.getMessage("errParse")]
        });

        window.close();

    } catch (e) {
        showError("Error: " + e.message);
    }
}
