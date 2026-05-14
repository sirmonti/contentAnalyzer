import os
import re
import urllib.request
import shutil

# The User-Agent is important so Google Fonts returns woff2 instead of ttf
HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'}

urls = {
    'tailwind': 'https://cdn.tailwindcss.com?plugins=forms,container-queries',
    'fonts_1': 'https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=Source+Code+Pro:wght@400;600&family=Source+Serif+4:wght@400;600&display=swap',
    'fonts_2': 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap'
}

def download_text(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req) as response:
        return response.read().decode('utf-8')

def download_binary(url, path):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req) as response:
        with open(path, 'wb') as f:
            f.write(response.read())

print("Downloading tailwind...")
tailwind_js = download_text(urls['tailwind'])

print("Downloading fonts css...")
fonts_1_css = download_text(urls['fonts_1'])
fonts_2_css = download_text(urls['fonts_2'])
combined_css = fonts_1_css + "\n" + fonts_2_css

# Find all url(...) in the css
woff2_urls = re.findall(r'url\((https://[^)]+\.woff2)\)', combined_css)

# Create a master assets dir
os.makedirs('vendor/css', exist_ok=True)
os.makedirs('vendor/js', exist_ok=True)
os.makedirs('vendor/fonts', exist_ok=True)

with open('vendor/js/tailwind.js', 'w', encoding='utf-8') as f:
    f.write(tailwind_js)

for font_url in set(woff2_urls):
    font_filename = font_url.split('/')[-1]
    print(f"Downloading {font_filename}...")
    download_binary(font_url, f"vendor/fonts/{font_filename}")
    # Update css
    combined_css = combined_css.replace(font_url, f"../fonts/{font_filename}")

with open('vendor/css/fonts.css', 'w', encoding='utf-8') as f:
    f.write(combined_css)

# Now, copy vendor into each extension
extensions = ['content-analyzer-ext-android', 'content-analyzer-ext-chrome', 'content-analyzer-ext-firefox']
for ext in extensions:
    dest = os.path.join(ext, 'vendor')
    if os.path.exists(dest):
        shutil.rmtree(dest)
    shutil.copytree('vendor', dest)
    
    # Update result.html
    html_path = os.path.join(ext, 'result.html')
    with open(html_path, 'r', encoding='utf-8') as f:
        html = f.read()
    
    # Replace the remote links with local ones
    # Tailwind
    html = re.sub(r'<script src="https://cdn\.tailwindcss\.com\?plugins=forms,container-queries"></script>', 
                  '<script src="vendor/js/tailwind.js"></script>', html)
    
    # Fonts
    # Remove the fonts_2 (it appears twice or once depending on how it was written)
    html = re.sub(r'<link href="https://fonts\.googleapis\.com/css2\?family=Material\+Symbols\+Outlined:wght,FILL@100\.\.700,0\.\.1&amp;display=swap" rel="stylesheet"/>\s*', '', html)
    
    # Replace fonts_1 with our local css
    html = re.sub(r'<link href="https://fonts\.googleapis\.com/css2\?family=Libre\+Baskerville:wght@400;700&amp;family=Source\+Code\+Pro:wght@400;600&amp;family=Source\+Serif\+4:wght@400;600&amp;display=swap" rel="stylesheet"/>',
                  '<link href="vendor/css/fonts.css" rel="stylesheet"/>', html)
    
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html)
    
    print(f"Updated {html_path}")

print("Done!")
