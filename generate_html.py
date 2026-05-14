import re

with open('resulttpl.html', 'r', encoding='utf-8') as f:
    tpl = f.read()

# Fix PAGELANG id
tpl = tpl.replace('<span style="font-weight: bold">ES</span></div>', '<span id="PAGELANG" style="font-weight: bold">ES</span></div>')

# Add loader CSS
loader_css = """
        .loader { border: 4px solid #e2e2eb; border-top: 4px solid #094cb2; border-radius: 50%; width: 30px; height: 30px; animation: spin 1s linear infinite; display: inline-block; vertical-align: middle; margin-right: 10px;}
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
"""
tpl = tpl.replace('</style>', loader_css + '    </style>')

# Replace the Content Placeholder
old_placeholder = """<!-- Content Placeholder -->
<div class="bg-surface-article border border-border-subtle rounded-DEFAULT p-xl min-h-[400px] flex items-center justify-center">
<p id="resultBox" class="font-body text-body text-neutral-text-secondary italic"></p>
</div>"""

new_placeholder = """<!-- Content Placeholder -->
<div id="status" class="bg-surface-article border border-border-subtle rounded-DEFAULT p-xl min-h-[400px] flex flex-col items-center justify-center">
    <div class="flex items-center gap-sm"><div class="loader"></div> <span data-i18n="statusProcessing" class="font-body text-body text-text-secondary">Procesando...</span></div>
</div>
<div id="resultBox" style="display:none" class="bg-surface-article border border-border-subtle rounded-DEFAULT p-xl min-h-[400px] font-body text-body text-text-primary">
</div>
<div class="mt-lg">
    <button id="saveBtn" style="display:none;" class="px-lg py-sm bg-primary text-on-primary font-body-bold rounded-DEFAULT hover:bg-primary-hover transition-colors shadow-sm" data-i18n="resSaveBtn">
        Guardar en archivo
    </button>
</div>"""

tpl = tpl.replace(old_placeholder, new_placeholder)

# Add scripts before </body>
scripts = """
<script src="i18n.js"></script>
<script src="result.js"></script>
"""
tpl = tpl.replace('</body>', scripts + '</body>')

# Replace the translation headers
tpl = tpl.replace('<span class="font-h2-section', '<span data-i18n="extName" class="font-h2-section')
tpl = tpl.replace('Resultado - <span id="serviceName">...</span>', '<span data-i18n="resHeader">Resultado - </span><span id="serviceName">...</span>')

# Update the files
targets = [
    'content-analyzer-ext-android/result.html',
    'content-analyzer-ext-chrome/result.html',
    'content-analyzer-ext-firefox/result.html'
]

for t in targets:
    with open(t, 'w', encoding='utf-8') as f:
        f.write(tpl)
    print(f"Updated {t}")

