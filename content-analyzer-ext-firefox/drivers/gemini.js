/**
 * @file drivers/gemini.js
 * @description Communication driver with the Google Gemini API.
 *
 * This module allows the extension to interact with the Gemini family
 * language models from Google (gemini-1.5-pro, gemini-1.5-flash, etc.)
 * through the Google AI public API (generativelanguage.googleapis.com).
 *
 * AUTHENTICATION:
 * --------------
 * The Gemini API does not use Bearer tokens in headers, but requires
 * passing the API key directly as a query string parameter `?key=`:
 *   https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSy...
 *
 * ENDPOINTS USED:
 * -----------------
 * - GET  /v1beta/models?key=...
 *     Lists available models. Response includes models like
 *     "models/gemini-1.5-pro", "models/gemini-1.5-flash", etc.
 *
 * - POST /v1beta/models/{model}:streamGenerateContent?key=...&alt=sse
 *     Generates content in streaming mode. The `alt=sse` parameter enables
 *     Server-Sent Events (SSE) mode.
 *
 * GENERATION BODY FORMAT:
 * -----------------------------------
 * Gemini uses a "contents" format with parts, different from OpenAI/Anthropic:
 *   {
 *     "contents": [
 *       { "role": "user", "parts": [{ "text": "prompt here" }] }
 *     ]
 *   }
 *
 * STREAM FORMAT (SSE):
 * --------------------------
 * `data:` lines contain JSON objects with the following relevant structure:
 *   {
 *     "candidates": [
 *       {
 *         "content": {
 *           "parts": [{ "text": "generated snippet" }]
 *         }
 *       }
 *     ]
 *   }
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
 * Retrieves the list of available models from the Google Gemini API.
 *
 * The "models/" prefix returned by the API is removed to expose only
 * the clean model ID (e.g.: "gemini-1.5-flash" instead of "models/gemini-1.5-flash").
 *
 * @param {Object} config - Connection configuration.
 * @param {string} config.apikey - Google AI Studio API key.
 * @returns {Promise<Array<{name: string}>>} List of models with a `name` property.
 * @throws {Error} If the HTTP response is an error.
 */
export async function fetchModels(config) {
    // API key is passed as a query parameter, not an authentication header
    const fetchUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${config.apikey}`;
    const res = await fetch(fetchUrl);
    if (!res.ok) {
        let errorMsg = `HTTP ${res.status}`;
        try {
            const errBody = await res.text();
            errorMsg = formatHttpError(res.status, errBody);
        } catch (e) {}
        throw new Error(errorMsg);
    }
    const data = await res.json();

    // Response looks like: { "models": [ { "name": "models/gemini-1.5-pro", ... }, ... ] }
    // Remove "models/" prefix to get clean ID used in requests.
    if (data.models) {
        return data.models.map(m => ({ name: m.name.replace('models/', '') }));
    }
    return [];
}

/**
 * Normalizes any prompt structure (string, array of objects, nested objects/parts)
 * into a valid Gemini API `contents` array with strictly string text parts.
 *
 * @param {string|Array<Object>|Object} prompt - Prompt data.
 * @returns {Array<{role: string, parts: Array<{text: string}>}>} Valid Gemini contents array.
 */
function formatGeminiContents(prompt) {
    if (!prompt) return [{ role: "user", parts: [{ text: "" }] }];

    if (typeof prompt === "string") {
        return [{ role: "user", parts: [{ text: prompt }] }];
    }

    let list = [];
    if (Array.isArray(prompt)) {
        list = prompt;
    } else if (typeof prompt === "object" && typeof prompt.length === "number" && !prompt.role) {
        list = Array.from(prompt);
    } else {
        list = [prompt];
    }

    const contents = [];
    for (const item of list) {
        if (!item) continue;
        if (typeof item === "string") {
            contents.push({ role: "user", parts: [{ text: item }] });
            continue;
        }

        let role = "user";
        if (item.role === "assistant" || item.role === "model") {
            role = "model";
        }

        let textVal = "";
        if (typeof item.content === "string") {
            textVal = item.content;
        } else if (typeof item.text === "string") {
            textVal = item.text;
        } else if (Array.isArray(item.parts)) {
            const parts = item.parts.map(p => {
                if (typeof p === "string") return { text: p };
                if (p && typeof p.text === "string") return { text: p.text };
                return { text: JSON.stringify(p) };
            });
            contents.push({ role, parts });
            continue;
        } else if (Array.isArray(item.content)) {
            textVal = item.content.map(c => {
                if (typeof c === "string") return c;
                if (c && typeof c.text === "string") return c.text;
                if (c && typeof c.content === "string") return c.content;
                return JSON.stringify(c);
            }).join("\n");
        } else if (item.content && typeof item.content === "object") {
            textVal = typeof item.content.content === "string" ? item.content.content : (typeof item.content.text === "string" ? item.content.text : JSON.stringify(item.content));
        } else {
            textVal = typeof item === "string" ? item : JSON.stringify(item);
        }

        contents.push({
            role,
            parts: [{ text: textVal }]
        });
    }

    return contents.length > 0 ? contents : [{ role: "user", parts: [{ text: "" }] }];
}

/**
 * Generates text from a prompt using the Gemini API with SSE streaming.
 *
 * Uses the `streamGenerateContent` endpoint with `alt=sse` to receive the response
 * incrementally and emit (`yield`) it snippet by snippet.
 *
 * @param {Object} config  - Service configuration.
 * @param {string} config.apikey - Google AI Studio API key.
 * @param {string} config.model  - Clean model ID (without "models/" prefix).
 * @param {string|Array<Object>} prompt  - Full prompt text or chat messages array.
 * @yields {string} Text snippets as generated by the model.
 * @throws {Error} If the initial HTTP response is an error.
 */
export async function* generate(config, prompt) {
    // Model is included in URL. The `alt=sse` parameter enables SSE format.
    // Without `alt=sse`, the API returns a full JSON array upon finishing (no streaming).
    const fetchUrl = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:streamGenerateContent?key=${config.apikey}&alt=sse`;

    const headers = { "Content-Type": "application/json" };

    // Gemini specific body format: "contents" with nested "parts".
    // "user" role indicates message comes from human in conversation.
    const contents = formatGeminiContents(prompt);
    const bodyParams = { contents: contents };
    if (config.systemPrompt) {
        const sysText = typeof config.systemPrompt === "string" ? config.systemPrompt : (config.systemPrompt.prompt || JSON.stringify(config.systemPrompt));
        bodyParams.system_instruction = {
            parts: [{ text: sysText }]
        };
    }

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
    let buffer = ""; // Accumulates partial network data until complete

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Decode byte chunk and add to accumulated buffer
            buffer += decoder.decode(value, { stream: true });

            // Split by lines since SSE sends data line by line
            let lines = buffer.split("\n");
            buffer = lines.pop(); // The last line might be incomplete: keep it

            for (const line of lines) {
                const tLine = line.trim();
                if (!tLine) continue; // Empty line breaks: separators between SSE events

                if (tLine.startsWith("data: ")) {
                    const textData = tLine.substring(6); // Extract JSON after "data: "
                    try {
                        const json = JSON.parse(textData);

                        // Navigate the nested Gemini response structure:
                        // candidates[0].content.parts[0].text
                        // Check each level to avoid errors if any are undefined.
                        if (
                            json.candidates &&
                            json.candidates[0] &&
                            json.candidates[0].content &&
                            json.candidates[0].content.parts.length > 0
                        ) {
                            yield json.candidates[0].content.parts[0].text;
                        }
                    } catch (e) {
                        // Ignore parsing errors from incomplete or malformed SSE lines
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
