/**
 * @file drivers/prompt-api.js
 * @description Communication driver with the browser's native Prompt API (Chrome Built-in AI / Gemini Nano).
 *
 * This module allows the extension to interact with on-device language models
 * running natively inside the browser (such as Gemini Nano in Chromium)
 * through the standard Prompt API (`ai.languageModel` / `window.ai`).
 *
 * CHARACTERISTICS:
 * ----------------
 * - 100% on-device local execution (zero network latency, total privacy).
 * - No API keys or remote server URLs required.
 * - Supports streaming response generation.
 * - Auto-detects model availability (e.g., 'readily' or 'after-download').
 */

/**
 * Helper to retrieve the AI root object from available global contexts.
 * @returns {Object|null}
 */
function getAiObject() {
    if (typeof self !== 'undefined' && self.ai) return self.ai;
    if (typeof window !== 'undefined' && window.ai) return window.ai;
    if (typeof globalThis !== 'undefined' && globalThis.ai) return globalThis.ai;
    return null;
}

/**
 * Checks if the Prompt API is available in the current browser environment
 * and if an active model is ready or downloadable.
 *
 * @returns {Promise<boolean>} True if Prompt API is available and usable.
 */
export async function isAvailable() {
    try {
        const aiObj = getAiObject();
        if (!aiObj || !aiObj.languageModel) {
            return false;
        }

        // Modern Chromium Prompt API specification: availability()
        if (typeof aiObj.languageModel.availability === 'function') {
            const status = await aiObj.languageModel.availability();
            return status === 'readily' || status === 'after-download';
        }

        // Earlier draft specification: capabilities()
        if (typeof aiObj.languageModel.capabilities === 'function') {
            const caps = await aiObj.languageModel.capabilities();
            return caps.available === 'readily' || caps.available === 'after-download';
        }

        // Alternative earlier draft: canCreateTextSession()
        if (typeof aiObj.canCreateTextSession === 'function') {
            const status = await aiObj.canCreateTextSession();
            return status === 'readily' || status === 'after-download';
        }

        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Returns available models for the Prompt API.
 *
 * @param {Object} [config] - Connection configuration (optional).
 * @returns {Promise<Array<{name: string}>>} List of models with a `name` property.
 * @throws {Error} If Prompt API is not available.
 */
export async function fetchModels(config) {
    const available = await isAvailable();
    if (!available) {
        throw new Error("Prompt API is not available or no active model is ready in this browser.");
    }
    return [{ name: "gemini-nano" }];
}

/**
 * Generates text using the Prompt API with streaming.
 *
 * @param {Object} config - Service configuration.
 * @param {string} [config.systemPrompt] - System prompt instructions.
 * @param {string} prompt - Full user prompt text.
 * @yields {string} Incremental text snippets as generated.
 * @throws {Error} If Prompt API session initialization fails.
 */
export async function* generate(config, prompt) {
    const aiObj = getAiObject();
    if (!aiObj || !aiObj.languageModel) {
        throw new Error("Prompt API (ai.languageModel) is not supported in this browser environment.");
    }

    const options = {};
    if (config && config.systemPrompt) {
        options.systemPrompt = config.systemPrompt;
    }

    if (Array.isArray(prompt)) {
        if (prompt.length > 1) {
            options.initialPrompts = prompt.slice(0, -1);
        }
        prompt = prompt[prompt.length - 1].content;
    }
    let session = null;
    try {
        session = await aiObj.languageModel.create(options);
    } catch (err) {
        throw new Error("Failed to initialize Prompt API session: " + err.message);
    }

    try {
        if (typeof session.promptStreaming === 'function') {
            const stream = session.promptStreaming(prompt);
            let previousLength = 0;

            for await (const chunk of stream) {
                // In Chromium's Prompt API, promptStreaming emits the accumulated text so far.
                // We slice off previously yielded text to output incremental deltas.
                const delta = chunk.slice(previousLength);
                previousLength = chunk.length;
                if (delta) {
                    yield delta;
                }
            }
        } else if (typeof session.prompt === 'function') {
            const result = await session.prompt(prompt);
            if (result) {
                yield result;
            }
        } else {
            throw new Error("Prompt API session does not provide promptStreaming or prompt methods.");
        }
    } finally {
        if (session && typeof session.destroy === 'function') {
            session.destroy();
        }
    }
}
