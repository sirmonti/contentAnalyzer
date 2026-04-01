document.addEventListener("DOMContentLoaded", () => {
    const api = window.browser || window.chrome;
    
    const uiLang = api.i18n.getUILanguage();
    if (uiLang.startsWith("ar") || uiLang.startsWith("he") || uiLang.startsWith("iw") || uiLang.startsWith("fa") || uiLang.startsWith("ur")) {
        document.documentElement.dir = "rtl";
    }

    document.title = api.i18n.getMessage("extName") || document.title;
    document.querySelectorAll("[data-i18n]").forEach(el => {
        const key = el.getAttribute("data-i18n");
        const msg = api.i18n.getMessage(key);
        if (msg) {
            if (el.tagName === "INPUT" && el.hasAttribute("placeholder")) {
                el.placeholder = msg;
            } else {
                const isHtml = el.hasAttribute("data-i18n-html");
                if (isHtml) el.innerHTML = msg;
                else el.textContent = msg;
            }
        }
    });
});
