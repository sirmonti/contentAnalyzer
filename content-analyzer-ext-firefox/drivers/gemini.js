export async function fetchModels(config) {
  const fetchUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${config.apikey}`;
  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  
  if (data.models) {
    return data.models.map(m => ({ name: m.name.replace('models/', '') }));
  }
  return [];
}

export async function* generate(config, prompt) {
  const fetchUrl = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:streamGenerateContent?key=${config.apikey}&alt=sse`;
  const headers = { "Content-Type": "application/json" };
  const bodyParams = { contents: [{ role: "user", parts: [{ text: prompt }] }] };

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
          if (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts.length > 0) {
            yield json.candidates[0].content.parts[0].text;
          }
        } catch (e) {
             // ignore parse error
        }
      }
    }
  }
}
