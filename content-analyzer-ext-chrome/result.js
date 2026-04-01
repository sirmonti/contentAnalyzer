const api = window.browser || window.chrome;
document.addEventListener("DOMContentLoaded", async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const execId = urlParams.get('id');
    if (!execId) {
        document.getElementById("status").textContent = api.i18n.getMessage("resInvalidId") || "ID de ejecución no válido.";
        return;
    }

    const mKey = `exec_${execId}`;
    const data = await api.storage.local.get(mKey);
    const execData = data[mKey];
    
    if (!execData) {
        document.getElementById("status").innerHTML = `<span style="color:red">${api.i18n.getMessage("resDataNotFound") || "No se encontraron los datos del artículo."}</span>`;
        return;
    }

    const { markdown, title, service, url, domain, lang, syslang } = execData;
    document.getElementById("serviceName").textContent = service.name;

    try {
        let pText = service.prompt || "";
        pText = pText.replace(/\{DATE\}/g, new Date().toLocaleDateString());
        pText = pText.replace(/\{HOUR\}/g, new Date().toLocaleTimeString());
        pText = pText.replace(/\{URL\}/g, url || "");
        pText = pText.replace(/\{DOMAIN\}/g, domain || "");
        pText = pText.replace(/\{LANG\}/g, lang || "NONE");
        pText = pText.replace(/\{SYSLANG\}/g, syslang || navigator.language);

        const promptParams = pText + "\n\n" + markdown;
        
        const statusDiv = document.getElementById("status");
        const resultBox = document.getElementById("resultBox");
        const saveBtn = document.getElementById("saveBtn");
        
        function parseMarkdown(text) {
            let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre style="background:#1e1e2f;padding:10px;border-radius:5px;overflow-x:auto;"><code>$2</code></pre>');
            html = html.replace(/```([\s\S]*?)```/g, '<pre style="background:#1e1e2f;padding:10px;border-radius:5px;overflow-x:auto;"><code>$1</code></pre>');
            html = html.replace(/`([^`]+)`/g, '<code style="background:#444;padding:2px 5px;border-radius:3px;">$1</code>');
            html = html.replace(/^### (.*$)/gim, '<h3 style="margin-top:10px; padding-bottom:5px; border-bottom:1px dotted #444;">$1</h3>');
            html = html.replace(/^## (.*$)/gim, '<h2 style="margin-top:10px; padding-bottom:5px; border-bottom:1px solid #444;">$1</h2>');
            html = html.replace(/^# (.*$)/gim, '<h1 style="margin-top:10px; padding-bottom:5px; border-bottom:2px solid #444;">$1</h1>');
            html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
            return html;
        }
        
        let retryCount = 0;
        const MAX_RETRIES = 3;

        function startGeneration() {
            let isDone = false;
            let attemptTimeout = null;
            let resultText = "";
            
            if (retryCount > 0) {
                statusDiv.style.display = "block";
                const msgBase = api.i18n.getMessage("resReconnecting") || "Reintentando consulta... (Intento $1/$2)";
                statusDiv.innerHTML = `<span>${msgBase.replace("$1", retryCount).replace("$2", MAX_RETRIES)}</span>`;
                resultBox.innerHTML = "";
                resultBox.style.display = "none";
            }

            const port = api.runtime.connect({ name: "llm-generate" });
            
            function resetTimeout(isFirstChunk) {
                if (attemptTimeout) clearTimeout(attemptTimeout);
                const delay = isFirstChunk ? 120000 : 120000;
                attemptTimeout = setTimeout(() => {
                    console.warn(`Timeout de conexión colgada (intento ${retryCount})`);
                    triggerRetry();
                }, delay);
            }

            function triggerRetry() {
                if (isDone) return;
                isDone = true;
                if (attemptTimeout) clearTimeout(attemptTimeout);
                port.disconnect();
                
                if (retryCount < MAX_RETRIES) {
                    retryCount++;
                    startGeneration();
                } else {
                    statusDiv.innerHTML = `<span style="color:#ff5555">${api.i18n.getMessage("resConnError") || "Error: La conexión se cerró inesperadamente."}</span>`;
                    statusDiv.style.display = "block";
                    statusDiv.className = "";
                }
            }

            port.onDisconnect.addListener(() => {
                if (!isDone) {
                    console.warn(`Puerto desconectado de forma inesperada (intento ${retryCount})`);
                    triggerRetry();
                }
            });

            port.postMessage({
                action: "generate",
                serviceType: service.type || "ollama",
                url: service.url,
                model: service.model,
                apikey: service.apikey,
                prompt: promptParams
            });

            resetTimeout(true);

            port.onMessage.addListener(async (msg) => {
                if (isDone) return;
                
                if (msg.type === "chunk") {
                    resetTimeout(false);
                    statusDiv.style.display = "none";
                    resultBox.style.display = "block";
                    
                    if (msg.chunk) {
                        resultText += msg.chunk;
                        resultBox.innerHTML = parseMarkdown(resultText);
                        window.scrollTo(0, document.body.scrollHeight);
                    }
                } else if (msg.type === "error") {
                    console.error("AI Error:", msg.error);
                    triggerRetry();
                } else if (msg.type === "done") {
                    isDone = true;
                    if (attemptTimeout) clearTimeout(attemptTimeout);
                    saveBtn.style.display = "inline-block";
                    
                    saveBtn.onclick = () => {
                        const blob = new Blob([resultText], { type: "text/markdown" });
                        const url = URL.createObjectURL(blob);
                        
                        let cleanTitle = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
                        if (!cleanTitle || cleanTitle.trim() === "") cleanTitle = api.i18n.getMessage("resDefaultFilename") || "respuesta_ia";
                        const filename = cleanTitle + "_ia.md";
                        
                        api.downloads.download({
                            url: url,
                            filename: filename,
                            saveAs: true
                        }).then(() => setTimeout(() => URL.revokeObjectURL(url), 10000))
                          .catch(err => {
                              console.error("Error en descarga:", err);
                              URL.revokeObjectURL(url);
                          });
                    };

                    await api.storage.local.remove(mKey); // Clean up context
                }
            });
        }
        
        startGeneration();
        
    } catch (e) {
        let msg = api.i18n.getMessage("resAIError") || "Error al comunicarse con la IA: $1";
        document.getElementById("status").innerHTML = `<span style="color:#ff5555">${msg.replace("$1", e.message)}</span>`;
        document.getElementById("status").className = ""; // remove loader
    }
});
