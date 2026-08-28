/**
 * @file drivers/openai.js
 * @description Communication driver with the OpenAI-compatible API.
 *
 * This module implements integration with any API that follows the
 * OpenAI standard (official OpenAI, Azure OpenAI, xAI Grok, Together AI, Groq, LM Studio,
 * LocalAI, etc.). Since the base URL is configurable, it works with any provider
 * that has adopted the same API format.
 *
 * AUTHENTICATION:
 * --------------
 * Uses the standard HTTP Bearer token:
 *   Authorization: Bearer <api_key>
 *
 * For local instances without authentication (e.g.: LM Studio), the `apikey` field
 * can be left empty, in which case the Authorization header is not sent.
 *
 * ENDPOINTS USED:
 * -----------------
 * - GET  {url}/v1/models              → List of available models.
 * - POST {url}/v1/chat/completions    → Text generation in chat mode.
 *
 * STREAM FORMAT (Server-Sent Events):
 * ------------------------------------------
 * With `stream: true`, the API responds with an SSE event stream where each line
 * follows the `data: {json}` format. The relevant field is in:
 *   choices[0].delta.content  → assistant text fragment
 *
 * The stream ends with the special line `data: [DONE]`.
 *
 * "CHAIN OF THOUGHT" FILTERING (<think>):
 * -------------------------------------------
 * Some models like DeepSeek-R1 include an "internal reasoning" block
 * delimited by <think>...</think> tags before the actual response.
 * This content is the model's internal thought process and should not be shown
 * to the end user. This driver implements a streaming filtering system that:
 *
 *   1. Detects in real-time when the block starts (<think>) and ends (</think>).
 *   2. Discards all text between those tags.
 *   3. Delivers only the text that is outside <think> blocks.
 *   4. Maintains a "safety buffer" of N characters at the end to not cut
 *      tags that arrive split between two different network chunks.
 */

/**
 * Retrieves the list of available models from an OpenAI-compatible server.
 *
 * @param {Object} config - Connection configuration.
 * @param {string} config.url    - Server base URL (e.g.: "https://api.openai.com").
 * @param {string} [config.apikey] - API Key (Bearer token). Can be empty.
 * @returns {Promise<Array<{name: string}>>} List of models with a `name` (=id) property.
 * @throws {Error} If the HTTP response is an error.
 */
export async function fetchModels(config) {
    // Normalize base URL: remove trailing slash and add endpoint path
    let fetchUrl = config.url || "";
    if (fetchUrl.endsWith('/')) fetchUrl = fetchUrl.slice(0, -1);
    if (!fetchUrl.match(/\/v\d+$/)) {
        fetchUrl += "/v1";
    }
    fetchUrl += "/models"; // Standard OpenAI model listing endpoint

    const headers = {};
    // Only add Authorization header if an API key is configured.
    // This allows using the driver with unauthenticated local servers.
    if (config.apikey) headers["Authorization"] = "Bearer " + config.apikey;

    const res = await fetch(fetchUrl, { headers });
    if (!res.ok) {
        let errorMsg = `HTTP ${res.status}`;
        try {
            const errBody = await res.text();
            const errJson = JSON.parse(errBody);
            if (errJson.error) {
                if (typeof errJson.error === 'string') {
                    errorMsg += `: ${errJson.error}`;
                } else if (errJson.error.message) {
                    errorMsg += `: ${errJson.error.message}`;
                } else {
                    errorMsg += `: ${errBody}`;
                }
            } else {
                errorMsg += `: ${errBody}`;
            }
        } catch (e) {
            // ignore JSON parse error
        }
        throw new Error(errorMsg);
    }
    const data = await res.json();

    // The response follows the standard OpenAI format:
    // { "data": [ { "id": "gpt-4o", "object": "model", ... }, ... ] }
    // Map to { name: id } to normalize with other drivers.
    if (data.data) {
        return data.data.map(m => ({ name: m.id }));
    }
    return [];
}

/**
 * Normalizes any prompt structure (string, array of objects, nested objects)
 * into a valid OpenAI chat completions `messages` array with string content.
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
            continue;
        }

        let role = item.role || "user";
        if (role === "model") role = "assistant";

        let content = "";
        if (typeof item.content === "string") {
            content = item.content;
        } else if (typeof item.text === "string") {
            content = item.text;
        } else if (Array.isArray(item.content)) {
            content = item.content.map(c => {
                if (typeof c === "string") return c;
                if (c && typeof c.content === "string") return c.content;
                if (c && typeof c.text === "string") return c.text;
                return JSON.stringify(c);
            }).join("\n");
        } else if (item.content && typeof item.content === "object") {
            content = typeof item.content.content === "string" ? item.content.content : (typeof item.content.text === "string" ? item.content.text : JSON.stringify(item.content));
        } else {
            content = typeof item === "string" ? item : JSON.stringify(item);
        }

        messages.push({ role, content });
    }

    return messages;
}

/**
 * Generates text using the OpenAI-compatible Chat Completions API with SSE streaming.
 *
 * This function is an async generator that emits text snippets as
 * the model generates them. It also implements <think>...</think> block filtering
 * for DeepSeek-like models that expose their chain of thought.
 *
 * @param {Object} config  - Service configuration.
 * @param {string} config.url    - Server base URL.
 * @param {string} config.model  - Model ID (e.g.: "gpt-4o", "deepseek-r1").
 * @param {string} [config.apikey] - Bearer API Key.
 * @param {string|Array<Object>} prompt  - Full prompt text or messages array.
 * @yields {string} "Clean" text snippets (without <think> blocks).
 * @throws {Error} If the initial HTTP response is an error.
 */
export async function* generate(config, prompt) {
    let baseUrl = config.url || "";
    if (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
    if (!baseUrl.match(/\/v\d+$/)) {
        baseUrl += "/v1";
    }
    const fetchUrl = baseUrl + "/chat/completions"; // Standard chat endpoint

    const headers = { "Content-Type": "application/json" };
    if (config.apikey) headers["Authorization"] = "Bearer " + config.apikey;

    // OpenAI Chat Completions request body format.
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
            const errJson = JSON.parse(errBody);
            if (errJson.error) {
                if (typeof errJson.error === 'string') {
                    errorMsg += `: ${errJson.error}`;
                } else if (errJson.error.message) {
                    errorMsg += `: ${errJson.error.message}`;
                } else {
                    errorMsg += `: ${errBody}`;
                }
            } else {
                errorMsg += `: ${errBody}`;
            }
        } catch (e) {
            // ignore JSON parse error
        }
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

                // SSE data is prefixed with "data: "
                if (tLine.startsWith("data: ")) {
                    const textData = tLine.substring(6); // Remove "data: "

                    // The "data: [DONE]" signal indicates the stream has finished correctly.
                    if (textData === "[DONE]") {
                        // If text remained in thinkBuffer outside of a <think> block,
                        // emit it now before finishing so as not to lose the end of the response.
                        if (!inThink && thinkBuffer.length > 0) yield thinkBuffer;
                        return; // Exit generator: generation finished
                    }

                    try {
                        const json = JSON.parse(textData);

                        // Extract text fragment from the first choice delta.
                        // Standard structure is: choices[0].delta.content
                        if (json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content) {
                            const chunk = json.choices[0].delta.content;

                            // ---- START: <think> block filtering ----
                            thinkBuffer += chunk;

                            while (true) {
                                if (!inThink) {
                                    // NORMAL MODE: search for the start of a <think> block
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
                                        break; // Wait for more stream data
                                    }
                                } else {
                                    // INSIDE <think> MODE: search for </think> closure
                                    const closeIdx = thinkBuffer.indexOf("</think>");
                                    if (closeIdx !== -1) {
                                        inThink = false;
                                        thinkBuffer = thinkBuffer.substring(closeIdx + 8);
                                    } else {
                                        if (thinkBuffer.length > 8) {
                                            thinkBuffer = thinkBuffer.substring(thinkBuffer.length - 8);
                                        }
                                        break; // Wait for more stream data
                                    }
                                }
                            }
                            // ---- END: <think> block filtering ----
                        }
                    } catch (e) {
                        // Ignore parsing errors for incomplete SSE chunks
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
