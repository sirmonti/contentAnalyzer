/**
 * @file i18n.js
 * @description Internationalization (i18n) module for the extension.
 *
 * This script is responsible for applying translations to all HTML pages
 * of the extension (popup, options, result) as soon as the DOM is ready.
 *
 * GENERAL OPERATION:
 * -----------------------
 * Firefox exposes the `browser.i18n` API (compatible with `chrome.i18n` in Chrome)
 * that reads text strings from JSON files hosted in `_locales/<lang>/messages.json`.
 * This script centralizes all translation logic so it doesn't have to be repeated
 * on every extension page.
 *
 * DOM TRANSLATION STRATEGY:
 * ------------------------------------
 * Instead of calling `browser.i18n.getMessage()` manually in each script,
 * we use a custom `data-i18n` HTML attribute on elements that need
 * to be translated. For example:
 *
 *   <button data-i18n="btnSave"></button>
 *
 * This script finds all elements with that attribute and replaces their content
 * with the localized text. This keeps HTML clean and translation logic isolated.
 *
 * SUPPORT FOR RTL (Right-to-Left) LANGUAGES:
 * ------------------------------------------
 * Arabic (ar), Hebrew (he/iw), Persian (fa), and Urdu (ur) languages are written
 * from right to left. To ensure the interface displays correctly, the
 * `dir="rtl"` attribute is set on the root `<html>` element of the document,
 * causing the browser to automatically reverse the layout flow direction.
 */

document.addEventListener("DOMContentLoaded", () => {
    // We use `window.browser` (Firefox) with fallback to `window.chrome` (Chrome/Edge)
    // to ensure this same script works across both browsers.
    const api = window.browser || window.chrome;

    // ---- RTL DIRECTION DETECTION AND APPLICATION ----
    // `getUILanguage()` returns the BCP-47 code for the browser interface language
    // (e.g.: "es", "en-US", "ar", "he"). We use `startsWith` to cover regional
    // variants like "ar-SA", "he-IL", etc.
    const uiLang = api.i18n.getUILanguage();
    if (
        uiLang.startsWith("ar") || // Arabic
        uiLang.startsWith("he") || // Hebrew (modern code)
        uiLang.startsWith("iw") || // Hebrew (old code, still used in some APIs)
        uiLang.startsWith("fa") || // Persian (Farsi)
        uiLang.startsWith("ur")    // Urdu
    ) {
        // By setting dir="rtl" on <html>, all elements inherit RTL direction
        // without needing to modify CSS. The browser automatically adjusts margins,
        // text alignment, flexbox order, etc.
        document.documentElement.dir = "rtl";
    }

    // ---- TAB TITLE TRANSLATION ----
    // Update document <title> with the "extName" key from the i18n catalog.
    // The fallback (`|| document.title`) preserves the original HTML title
    // if the key is missing from the catalog (useful during development).
    document.title = api.i18n.getMessage("extName") || document.title;

    // ---- MASSIVE DOM ELEMENT TRANSLATION ----
    // Find all elements that have the `data-i18n` attribute.
    // This attribute contains the message key in the translation catalog.
    document.querySelectorAll("[data-i18n]").forEach(el => {
        const key = el.getAttribute("data-i18n");
        const msg = api.i18n.getMessage(key); // Returns "" if key doesn't exist

        // Only update the element if the API returned a non-empty string,
        // which prevents clearing elements whose keys are not translated.
        if (msg) {
            if (el.tagName === "INPUT" && el.hasAttribute("placeholder")) {
                // Special case: <input> fields with placeholders.
                // We don't set text as content (inputs don't show text),
                // but as the placeholder attribute so it appears as a hint.
                el.placeholder = msg;
            } else {
                // Check if the element also has the `data-i18n-html` attribute.
                // When present, the message can contain HTML tags (e.g.: <strong>, <a>),
                // and is injected using innerHTML instead of textContent for rendering.
                // Without this attribute, we use textContent (safer, avoids XSS).
                const isHtml = el.hasAttribute("data-i18n-html");
                if (isHtml) el.innerHTML = msg;
                else        el.textContent = msg;
            }
        }
    });
});
