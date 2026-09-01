/**
 * @file drivers/groq.js
 * @description Communication driver with the Groq API.
 *
 * Groq offers high-speed inference for open-source LLMs (Llama 3, Mixtral, Gemma,
 * DeepSeek, etc.) through an OpenAI-compatible API endpoint (api.groq.com/openai/v1).
 *
 * AUTHENTICATION:
 * --------------
 * Uses standard Bearer token authentication:
 *   Authorization: Bearer <GROQ_API_KEY>
 *
 * ENDPOINTS USED:
 * -----------------
 * - GET  https://api.groq.com/openai/v1/models
 *     Lists available models in standard OpenAI format.
 *
 * - POST https://api.groq.com/openai/v1/chat/completions
 *     Generates responses using the Chat Completions format with `stream: true`.
 *
 * STREAM FORMAT (Server-Sent Events):
 * -----------------------------------
 * Returns chunks in standard SSE format (`data: {...}`, `data: [DONE]`).
 * Supports `<think>...</think>` filtering for reasoning models (e.g. DeepSeek R1).
 */

/**
 * Formats a clean, concise HTTP error message from the response status and body.
 *
 * @param {number} status - HTTP status code.
 * @param {string} errBody - Raw response text.
 * @returns {string} Clean error string without request dumps.
 */
function formatHttpError(status, errBody) {
    let errorMsg = `HTTP ${status}`;
    if (!errBody || typeof errBody !== "string" || !errBody.trim()) return errorMsg;
    try {
        const errJson = JSON.parse(errBody);
        if (errJson) {
            if (typeof errJson.error === "string") {
                return `${errorMsg}: ${errJson.error}`;
            }
            if (errJson.error && typeof errJson.error.message === "string") {
                return `${errorMsg}: ${errJson.error.message}`;
            }
            if (typeof errJson.message === "string") {
                return `${errorMsg}: ${errJson.message}`;
            }
            if (typeof errJson.detail === "string") {
                return `${errorMsg}: ${errJson.detail}`;
            }
            if (Array.isArray(errJson.detail) && errJson.detail.length > 0) {
                const details = errJson.detail.map(d => (d && d.msg) ? d.msg : (typeof d === "string" ? d : JSON.stringify(d))).join("; ");
                return `${errorMsg}: ${details}`;
            }
            if (errJson.error_description && typeof errJson.error_description === "string") {
                return `${errorMsg}: ${errJson.error_description}`;
            }
        }
    } catch (e) {}

    const clean = errBody.trim();
    if (clean.length > 200) {
        return `${errorMsg}: ${clean.slice(0, 200)}...`;
    }
    return `${errorMsg}: ${clean}`;
}

/**
 * Retrieves the list of available models from Groq.
 *
 * @param {Object} config - Connection configuration.
 * @param {string} config.apikey - Groq API Key (Bearer token).
 * @returns {Promise<Array<{name: string}>>} List of models with a `name` property.
 * @throws {Error} If the HTTP response is an error.
 */
export async function fetchModels(config) {
    const fetchUrl = "https://api.groq.com/openai/v1/models";

    const headers = {};
    if (config.apikey) headers["Authorization"] = "Bearer " + config.apikey;

    const res = await fetch(fetchUrl, { headers });
    if (!res.ok) {
        let errorMsg = `HTTP ${res.status}`;
        try {
            const errBody = await res.text();
            errorMsg = formatHttpError(res.status, errBody);
        } catch (e) {}
        throw new Error(errorMsg);
    }
    const data = await res.json();

    if (data.data && Array.isArray(data.data)) {
        return data.data
            .filter(m => m.active !== false)
            .map(m => ({ name: m.id }));
    }
    return [];
}

/**
 * Normalizes any prompt structure (string, array of objects, nested objects)
 * into a valid OpenAI/Groq chat completions `messages` array with string content.
 *
 * @param {string|Array<Object>|Object} prompt - Prompt or conversation history.
 * @param {string} [systemPrompt] - Optional system prompt instruction.
 * @returns {Array<{role: string, content: string}>} Valid messages array.
 */
function normalizeMessages(prompt, systemPrompt) {
    const messages = [];
    if (systemPrompt && typeof systemPrompt === "string" && systemPrompt.trim()) {
        messages.push({ role: "system", content: systemPrompt.trim() });
    }

    if (!prompt) return messages;

    if (typeof prompt === "string") {
        messages.push({ role: "user", content: prompt });
        return messages;
    }

    let list = [];
    if (Array.isArray(prompt)) {
        list = prompt;
    } else if (typeof prompt === "object" && typeof prompt.length === "number" && !prompt.role) {
        list = Array.from(prompt);
    } else {
        list = [prompt];
    }

    for (const item of list) {
        if (!item) continue;
        if (typeof item === "string") {
            messages.push({ role: "user", content: item });
        } else if (typeof item === "object") {
            const role = item.role || "user";
            let contentStr = "";
            if (typeof item.content === "string") {
                contentStr = item.content;
            } else if (Array.isArray(item.content)) {
                contentStr = item.content
                    .map(part => {
                        if (typeof part === "string") return part;
                        if (part && typeof part.text === "string") return part.text;
                        if (part && typeof part.content === "string") return part.content;
                        return JSON.stringify(part);
                    })
                    .join("\n");
            } else if (item.content !== undefined && item.content !== null) {
                contentStr = typeof item.content === "object" ? JSON.stringify(item.content) : String(item.content);
            } else if (item.parts) {
                contentStr = Array.isArray(item.parts)
                    ? item.parts.map(p => typeof p === "string" ? p : (p && p.text ? p.text : JSON.stringify(p))).join("\n")
                    : String(item.parts);
            }
            messages.push({ role: role, content: contentStr });
        }
    }

    return messages;
}

/**
 * Generates responses from Groq in streaming mode (SSE).
 *
 * @param {Object} config  - Service configuration.
 * @param {string} config.model  - Model ID (e.g.: "llama-3.3-70b-versatile").
 * @param {string} config.apikey - Bearer API Key.
 * @param {string} [config.systemPrompt] - Optional system instructions.
 * @param {AbortSignal} [config.signal] - Signal to abort stream.
 * @param {string|Array<Object>} prompt  - Full prompt text or messages array.
 * @yields {string} Clean text snippets (without <think> blocks).
 * @throws {Error} If the initial HTTP response is an error.
 */
export async function* generate(config, prompt) {
    const fetchUrl = "https://api.groq.com/openai/v1/chat/completions";

    const headers = { "Content-Type": "application/json" };
    if (config.apikey) headers["Authorization"] = "Bearer " + config.apikey;

    const messages = normalizeMessages(prompt, config.systemPrompt);

    const bodyParams = {
        model: config.model,
        messages: messages,
        stream: true
    };

    const fetchOptions = {
        method: "POST",
        headers: headers,
        body: JSON.stringify(bodyParams)
    };
    if (config.signal) fetchOptions.signal = config.signal;

    const response = await fetch(fetchUrl, fetchOptions);

    if (!response.ok) {
        let errorMsg = `HTTP ${response.status}`;
        try {
            const errBody = await response.text();
            errorMsg = formatHttpError(response.status, errBody);
        } catch (e) {}
        throw new Error(errorMsg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";     // Accumulates partial network bytes not yet processed
    let thinkBuffer = ""; // Secondary buffer for <think> block filtering
    let inThink = false;  // State: are we currently inside a <think> block?

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            let lines = buffer.split("\n");
            buffer = lines.pop(); // Keep potentially incomplete last line

            for (const line of lines) {
                const tLine = line.trim();
                if (!tLine) continue;

                if (tLine.startsWith("data: ")) {
                    const textData = tLine.substring(6);

                    if (textData === "[DONE]") {
                        if (!inThink && thinkBuffer.length > 0) yield thinkBuffer;
                        return;
                    }

                    try {
                        const json = JSON.parse(textData);

                        if (json.choices && json.choices[0] && json.choices[0].delta) {
                            const delta = json.choices[0].delta;
                            const chunk = delta.content || delta.reasoning || "";

                            if (chunk) {
                                thinkBuffer += chunk;

                                while (true) {
                                    if (!inThink) {
                                        const openIdx = thinkBuffer.indexOf("<think>");
                                        if (openIdx !== -1) {
                                            if (openIdx > 0) yield thinkBuffer.substring(0, openIdx);
                                            inThink = true;
                                            thinkBuffer = thinkBuffer.substring(openIdx + 7);
                                        } else {
                                            if (thinkBuffer.length > 7) {
                                                const safeChunk = thinkBuffer.substring(0, thinkBuffer.length - 7);
                                                yield safeChunk;
                                                thinkBuffer = thinkBuffer.substring(thinkBuffer.length - 7);
                                            }
                                            break;
                                        }
                                    } else {
                                        const closeIdx = thinkBuffer.indexOf("</think>");
                                        if (closeIdx !== -1) {
                                            inThink = false;
                                            thinkBuffer = thinkBuffer.substring(closeIdx + 8);
                                        } else {
                                            if (thinkBuffer.length > 8) {
                                                thinkBuffer = thinkBuffer.substring(thinkBuffer.length - 8);
                                            }
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        // Ignore parsing errors for partial SSE chunks
                    }
                }
            }
        }
    } finally {
        try {
            reader.cancel();
        } catch (e) {}
    }
}
