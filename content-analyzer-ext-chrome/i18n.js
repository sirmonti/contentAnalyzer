/**
 * @file i18n.js
 * @description Internationalization (i18n) Module for the extension.
 *
 * This script is responsible for applying translations to all HTML pages
 * of the extension (popup, options, result) when the DOM is ready.
 *
 * GENERAL OPERATION:
 * -----------------------
 * Firefox exposes the `browser.i18n` API (compatible with `chrome.i18n` in Chrome)
 * which reads text strings from JSON files located in `_locales/<lang>/messages.json`.
 * This script centralizes all translation logic so it doesn't have to be repeated
 * in each page of the extension.
 *
 * DOM TRANSLATION STRATEGY:
 * ------------------------------------
 * Instead of calling `browser.i18n.getMessage()` manually in each script,
 * we use a custom HTML attribute `data-i18n` on elements that need
 * to be translated. For example:
 *
 *   <button data-i18n="btnSave"></button>
 *
 * This script finds all elements with that attribute and replaces their content
 * with the localized text. This keeps HTML clean and the translation logic isolated.
 *
 * SUPPORT FOR RTL (Right-to-Left) LANGUAGES:
 * ------------------------------------------
 * Arabic (ar), Hebrew (he/iw), Persian (fa), and Urdu (ur) languages are written
 * from right to left. For the interface to display correctly, the
 * `dir="rtl"` attribute is set on the document's root `<html>` element, which
 * causes the browser to automatically reverse the layout flow direction.
 */

document.addEventListener("DOMContentLoaded", () => {
    // We use `window.browser` (Firefox) with fallback to `window.chrome` (Chrome/Edge)
    // to ensure that this same script works in both browsers.
    const api = window.browser || window.chrome;

    // ---- RTL DIRECTION DETECTION AND APPLICATION ----
    // `getUILanguage()` returns the BCP-47 code of the browser's interface language
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
        // By setting dir="rtl" on <html>, all elements inherit the RTL direction
        // without needing to modify the CSS. The browser automatically adjusts margins, 
        // text alignment, flexbox order, etc.
        document.documentElement.dir = "rtl";
    }

    // ---- TAB TITLE TRANSLATION ----
    // Update the document's <title> with the "extName" key from the i18n catalog.
    // The fallback (`|| document.title`) preserves the original HTML title
    // if the key does not exist in the catalog (useful in development).
    document.title = api.i18n.getMessage("extName") || document.title;

    // ---- BULK TRANSLATION OF DOM ELEMENTS ----
    // Find all elements containing the `data-i18n` attribute.
    // This attribute contains the message key in the translation catalog.
    document.querySelectorAll("[data-i18n]").forEach(el => {
        const key = el.getAttribute("data-i18n");
        const msg = api.i18n.getMessage(key); // Returns "" if the key does not exist

        // Only update the element if the API returned a non-empty string,
        // which prevents deleting the content of elements whose key is not translated.
        if (msg) {
            if (el.tagName === "INPUT" && el.hasAttribute("placeholder")) {
                // Special case: <input> fields with placeholders.
                // We don't set the text as content (inputs don't show text),
                // but as the placeholder attribute so it appears as a hint.
                el.placeholder = msg;
            } else {
                // Check if the element also has the `data-i18n-html` attribute.
                // When present, the message can contain HTML tags (e.g.: <strong>, <a>),
                // and it is injected with innerHTML instead of textContent for the browser
                // to render them. Without this attribute, we use textContent (safer, no XSS).
                const isHtml = el.hasAttribute("data-i18n-html");
                if (isHtml) el.innerHTML = msg;
                else        el.textContent = msg;
            }
        }
    });
});
