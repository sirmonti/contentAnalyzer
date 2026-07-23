import os
import sys
import json
import shutil
import urllib.request
import urllib.error
import re
import argparse


# Configuración de idiomas
SOURCE_CODE = 'en'
SOURCE_LANG = 'English'

# Todos los idiomas soportados por la aplicación
SUPPORTED_LANGS = {
    'ar': 'Arabic',
    'de': 'German',
    'en': 'English',
    'es': 'Spanish',
    'fr': 'French',
    'he': 'Hebrew',
    'it': 'Italian',
    'ja': 'Japanese',
    'ko': 'Korean',
    'pl': 'Polish',
    'pt': 'Portuguese',
    'ru': 'Russian',
    'zh': 'Chinese'
}

SYSTEM_PROMPT_TEMPLATE = """You are a professional {SOURCE_LANG} ({SOURCE_CODE}) to {TARGET_LANG} ({TARGET_CODE}) translator. Your goal is to accurately convey the meaning and nuances of the original {SOURCE_LANG} text while adhering to {TARGET_LANG} grammar, vocabulary, and cultural sensitivities.
Produce only the {TARGET_LANG} translation, without any additional explanations or commentary."""

USER_PROMPT_TEMPLATE = """The attached text is an HTML document that you must translate from {SOURCE_LANG} ({SOURCE_CODE}) to {TARGET_LANG} ({TARGET_CODE}). You must not alter the structure of the document. HTML tags and attributes must be kept exactly as they are, without any modification. Translate only the text content. Do not add or remove tags, do not modify attributes, and do not add or remove classes. Produce only the translation without any additional explanations or commentary.

{HTML_TEXT}"""

def translate_content(text, target_code, target_lang):
    url = os.environ.get('TRANS_URL')
    model = os.environ.get('TRANS_MODEL')
    api_type = os.environ.get('TRANS_API', 'ollama').lower()
    api_key = os.environ.get('TRANS_API_KEY', '')
    
    if not url or not model:
        print("Error: Las variables de entorno TRANS_URL y TRANS_MODEL deben estar definidas.")
        sys.exit(1)
        
    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
        SOURCE_LANG=SOURCE_LANG,
        SOURCE_CODE=SOURCE_CODE,
        TARGET_LANG=target_lang,
        TARGET_CODE=target_code
    )
    
    user_prompt = USER_PROMPT_TEMPLATE.format(
        SOURCE_LANG=SOURCE_LANG,
        SOURCE_CODE=SOURCE_CODE,
        TARGET_LANG=target_lang,
        TARGET_CODE=target_code,
        HTML_TEXT=text
    )
    
    headers = {'Content-Type': 'application/json'}
    
    if api_type == 'openai':
        api_url = f"{url.rstrip('/')}/v1/chat/completions"
        if api_key:
            headers['Authorization'] = f"Bearer {api_key}"
        data = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "temperature": 0.3
        }
    else:
        # Default a Ollama
        api_url = f"{url.rstrip('/')}/api/generate"
        data = {
            "model": model,
            "system": system_prompt,
            "prompt": user_prompt,
            "stream": False
        }
    
    req = urllib.request.Request(api_url, data=json.dumps(data).encode('utf-8'), headers=headers)
    
    try:
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode('utf-8'))
            
            if api_type == 'openai':
                translated_text = result.get('choices', [{}])[0].get('message', {}).get('content', '').strip()
            else:
                translated_text = result.get('response', '').strip()
            
            # Detectar y extraer si el texto está envuelto en marcas de markdown ```
            match = re.search(r"```(?:html)?\s*(.*?)\s*```", translated_text, re.DOTALL | re.IGNORECASE)
            if match:
                translated_text = match.group(1).strip()
                
            # Modificar la etiqueta lang del HTML
            translated_text = re.sub(r'(<html[^>]*?lang=["\'])([^"\']*)(["\'][^>]*>)', rf'\g<1>{target_code}\g<3>', translated_text, flags=re.IGNORECASE)
                
            return translated_text
    except Exception as e:
        print(f"Error durante la traducción a {target_code}: {e}")
        return None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lang", default=None, help="Idiomas a traducir separados por comas (ej. es,pt)")
    parser.add_argument("files", nargs="*", help="Archivos a traducir (o 'all')")
    args = parser.parse_args()

    input_dir = "tpls/master"
    
    if not os.path.isdir(input_dir):
        print(f"Error: El directorio '{input_dir}' no existe.")
        sys.exit(1)
        
    files_to_process = []
    
    if len(args.files) == 0:
        target_file = os.path.join(input_dir, "template.html")
        if os.path.isfile(target_file):
            files_to_process.append(target_file)
        else:
            print(f"Aviso: El archivo '{target_file}' no existe.")
    elif len(args.files) == 1 and args.files[0] == "all":
        for f in os.listdir(input_dir):
            if f.endswith('.html') and f != "template.html":
                files_to_process.append(os.path.join(input_dir, f))
    else:
        for f in args.files:
            target_file = os.path.join(input_dir, f)
            if os.path.isfile(target_file):
                files_to_process.append(target_file)
            else:
                print(f"Aviso: El archivo '{target_file}' no existe. Se continuará con la tarea.")

    if not files_to_process:
        print("No se encontraron archivos válidos para procesar.")
        sys.exit(0)
        
    out_dir = "tpls"
    os.makedirs(out_dir, exist_ok=True)
    
    target_langs = {}
    if args.lang:
        langs_requested = [l.strip() for l in args.lang.split(',')]
        for l in langs_requested:
            if l in SUPPORTED_LANGS:
                target_langs[l] = SUPPORTED_LANGS[l]
            else:
                print(f"Aviso: El idioma '{l}' no está soportado. Se ignorará.")
        if not target_langs:
            print("No se indicaron idiomas válidos para traducir.")
            sys.exit(1)
    else:
        target_langs = SUPPORTED_LANGS
    
    for lang_code, lang_name in target_langs.items():
        lang_dir = os.path.join(out_dir, lang_code)
        os.makedirs(lang_dir, exist_ok=True)
        
        for file_path in files_to_process:
            filename = os.path.basename(file_path)
            out_file_path = os.path.join(lang_dir, filename)
            
            # Si el idioma destino es el mismo que el origen, simplemente copiamos el archivo
            if lang_code == SOURCE_CODE:
                print(f"Copiando {filename} a {lang_name} ({lang_code})...")
                shutil.copy2(file_path, out_file_path)
                continue
                
            print(f"Traduciendo {filename} a {lang_name} ({lang_code})...")
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                
            translated = translate_content(content, lang_code, lang_name)
            
            if translated:
                with open(out_file_path, 'w', encoding='utf-8') as f:
                    f.write(translated)
                print(f"  -> Guardado en {out_file_path}")
            else:
                print(f"  -> Falló la traducción de {filename} a {lang_code}.")

if __name__ == "__main__":
    main()
