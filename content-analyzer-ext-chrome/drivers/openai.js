// Método para cargar modelos disponibles utilizando la API de OpenAI
export async function fetchModels(config) {
  let fetchUrl = config.url || "";
  if (fetchUrl.endsWith('/')) fetchUrl = fetchUrl.slice(0, -1);
  fetchUrl += "/v1/models";

  const headers = {};
  if (config.apikey) headers["Authorization"] = "Bearer " + config.apikey;

  const res = await fetch(fetchUrl, { headers });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();

  if (data.data) {
    return data.data.map(m => ({ name: m.id }));
  }
  return [];
}

// Función asíncrona principal (Generador) para enviar la petición e iterar sobre el stream (Server-Sent Events)
export async function* generate(config, prompt) {
  let baseUrl = config.url || "";
  if (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  const fetchUrl = baseUrl + "/v1/chat/completions";

  const headers = { "Content-Type": "application/json" };
  if (config.apikey) headers["Authorization"] = "Bearer " + config.apikey;

  const bodyParams = {
    model: config.model,
    messages: [{ role: "user", content: prompt }],
    stream: true
  };

  const response = await fetch(fetchUrl, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(bodyParams)
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let thinkBuffer = "";
  let inThink = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      const tLine = line.trim();
      if (!tLine) continue;
      // Los streams de OpenAI devuelven datos en el formato: "data: {json...}"
      if (tLine.startsWith("data: ")) {
        const textData = tLine.substring(6);
        // Cuando devuelve [DONE], indica que la transferencia ha finalizado satisfactoriamente
        if (textData === "[DONE]") {
          // Si nos encontrábamos fuera de un bloque <think> y quedaron residuos en el buffer, enviarlos antes de terminar.
          if (!inThink && thinkBuffer.length > 0) yield thinkBuffer;
          return;
        }
        try {
          const json = JSON.parse(textData);
          // Convertir de JSON al chunk real (texto delta del modelo)
          if (json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content) {
            const chunk = json.choices[0].delta.content;
            
            // Lógica de filtrado de "Chain of Thought" (Cadena de Pensamiento externa, típica de modelos como DeepSeek).
            // Filtra y omite por completo todo lo que reciba envuelto entre <think> y </think>.
            thinkBuffer += chunk;
            while (true) {
              if (!inThink) {
                // Buscamos si este trozo recién recibido coincide con la etiqueta de apertura
                const openIdx = thinkBuffer.indexOf("<think>");
                if (openIdx !== -1) {
                  // Entregamos el texto válido justo ANTES de <think>
                  if (openIdx > 0) yield thinkBuffer.substring(0, openIdx);
                  inThink = true;
                  // Descartamos la etiqueta de apertura y nos quedamos con el pensamiento interno
                  thinkBuffer = thinkBuffer.substring(openIdx + 7);
                } else {
                  // Si no hay etiqueta pero el buffer tiene suficiente longitud,
                  // liberamos lo más antiguo que es seguro entregar y mantenemos 7 caracteres en reserva (previendo "<think" cortado)
                  if (thinkBuffer.length > 7) {
                    const safeChunk = thinkBuffer.substring(0, thinkBuffer.length - 7);
                    yield safeChunk;
                    thinkBuffer = thinkBuffer.substring(thinkBuffer.length - 7);
                  }
                  break;
                }
              } else {
                // Estando DENTRO de la cadena de pensamiento, localizamos el cierre
                const closeIdx = thinkBuffer.indexOf("</think>");
                if (closeIdx !== -1) {
                  // Ya salimos del pensamiento. Descartamos etiqueta de cierre.
                  inThink = false;
                  thinkBuffer = thinkBuffer.substring(closeIdx + 8);
                } else {
                  // Estando dentro pero sin llegar al final del pensamiento, vamos descartando todo y vaciando buffer 
                  // salvo los últimos 8 caracteres para no truncar la etiqueta "</think>" a medias
                  if (thinkBuffer.length > 8) {
                    thinkBuffer = thinkBuffer.substring(thinkBuffer.length - 8);
                  }
                  break;
                }
              }
            }
          }
        } catch (e) {
          // ignore parsing error for chunk
        }
      }
    }
  }
}
