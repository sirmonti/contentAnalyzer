export async function fetchModels(config) {
  const fetchUrl = "https://api.anthropic.com/v1/models";
  const headers = {
    "x-api-key": config.apikey,
    "anthropic-version": "2023-06-01",
    "anthropic-cors-request": "true"
  };

  const res = await fetch(fetchUrl, { headers });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  
  if (data.data) {
    return data.data.map(m => ({ name: m.id }));
  }
  return [];
}

export async function* generate(config, prompt) {
  const fetchUrl = "https://api.anthropic.com/v1/messages";
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": config.apikey,
    "anthropic-version": "2023-06-01",
    "anthropic-cors-request": "true"
  };
  
  const bodyParams = { 
    model: config.model, 
    max_tokens: 4096, 
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    let lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      const tLine = line.trim();
      if (!tLine) continue;
      if (tLine.startsWith("data: ")) {
        const textData = tLine.substring(6);
        try {
          const json = JSON.parse(textData);
          if (json.type === "content_block_delta" && json.delta && json.delta.text) {
            yield json.delta.text;
          }
        } catch (e) {
          // ignore parsing error for chunk
        }
      }
    }
  }
}
