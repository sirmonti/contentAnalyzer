// Obtener la lista de modelos instalados localmente a través del endpoint /api/tags de Ollama
export async function fetchModels(config) {
  let url = config.url || "";
  if (url.endsWith("/")) url = url.slice(0, -1);
  const fetchUrl = url + "/api/tags";
  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  return data.models || [];
}

// Generador asíncrono que se conecta a Ollama y extrae el texto (JSON objects consecutivos)
export async function* generate(config, prompt) {
  let url = config.url || "";
  if (url.endsWith("/")) url = url.slice(0, -1);
  const fetchUrl = url + "/api/generate";
  const headers = { "Content-Type": "application/json" };
  if (config.apikey) headers["Authorization"] = "Bearer " + config.apikey;
  
  const bodyParams = { model: config.model, prompt: prompt, stream: true };

  const response = await fetch(fetchUrl, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(bodyParams)
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    // Usamos split("\n") porque Ollama en modo stream devuelve cada chunk como una línea de texto individual
    let lines = buffer.split("\n");
    // Extraemos la última línea (que podría estar incompleta si se ha cortado a mitad de un mensaje) y la dejamos en el búfer
    buffer = lines.pop(); 

    for (const line of lines) {
      const tLine = line.trim();
      if (!tLine) continue;
      try {
        const json = JSON.parse(tLine);
        if (json.response) yield json.response;
      } catch (e) {
        // ignore incomplete JSON
      }
    }
  }
}
