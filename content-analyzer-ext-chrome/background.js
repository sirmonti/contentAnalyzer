import * as ollama from './drivers/ollama.js';
import * as openai from './drivers/openai.js';
import * as anthropic from './drivers/anthropic.js';
import * as gemini from './drivers/gemini.js';

const DRIVERS = {
  ollama,
  openai,
  anthropic,
  gemini
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "processSelection") {
    if (message.type === "disk") {
      let cleanTitle = message.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      if (!cleanTitle || cleanTitle.trim() === "") cleanTitle = "articulo";
      const filename = cleanTitle + ".md";
      
      const blob = new Blob([message.markdown], { type: "text/markdown" });
      const reader = new FileReader();
      reader.onload = function() {
        chrome.downloads.download({
          url: reader.result,
          filename: filename,
          saveAs: true
        }).catch(err => {
          console.error("Error en la descarga: ", err);
        });
      };
      reader.readAsDataURL(blob);
    } else if (message.type === "llm") {
      const executionId = Date.now().toString();
      chrome.storage.local.set({
        [`exec_${executionId}`]: {
          markdown: message.markdown,
          title: message.title,
          service: message.serviceData,
          url: message.url,
          domain: message.domain,
          lang: message.lang,
          syslang: message.syslang
        }
      }).then(() => {
        chrome.tabs.create({ url: `result.html?id=${executionId}` });
      });
    }
  }

  if (message.action === "fetchModels") {
    const type = message.serviceType || "ollama";
    const driver = DRIVERS[type];
    if (!driver) {
      sendResponse({ success: false, error: chrome.i18n.getMessage("errUnsupportedService").replace("$1", "") });
      return false;
    }

    driver.fetchModels({ url: message.url, apikey: message.apikey })
      .then(models => sendResponse({ success: true, data: { models } }))
      .catch(err => sendResponse({ success: false, error: err.message }));

    return true; // Keep message port open for async
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "ollama-generate" || port.name === "llm-generate") {
    port.onMessage.addListener(async (msg) => {
      if (msg.action === "generate") {
        try {
          const type = msg.serviceType || "ollama";
          const driver = DRIVERS[type];
          if (!driver) throw new Error(chrome.i18n.getMessage("errUnsupportedService").replace("$1", type));

          const generator = driver.generate(
            { url: msg.url, apikey: msg.apikey, model: msg.model },
            msg.prompt
          );

          for await (const chunkText of generator) {
            port.postMessage({ type: "chunk", chunk: chunkText });
          }

          console.log("[Background-Gen] Stream de procesado ha finalizado.");
          port.postMessage({ type: "done" });
        } catch (e) {
          console.error("[Background-Gen] Excepción durante la petición/lectura API de parseo:", e);
          port.postMessage({ type: "error", error: e.message });
        }
      }
    });
  }
});
