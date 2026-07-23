import os
import shutil

def main():
    # Base directories
    base_dir = os.path.dirname(os.path.abspath(__file__))
    tpls_dir = os.path.join(base_dir, 'tpls')
    docs_dir = os.path.join(base_dir, 'docs')

    if not os.path.exists(tpls_dir):
        print(f"Error: Templates directory '{tpls_dir}' not found.")
        return

    # Iterate through all items in tpls directory
    for lang_folder in os.listdir(tpls_dir):
        lang_path = os.path.join(tpls_dir, lang_folder)
        
        # Only process directories (language folders)
        if not os.path.isdir(lang_path):
            continue

        template_path = os.path.join(lang_path, 'template.html')
        
        # Check if template.html exists in this language folder
        if not os.path.exists(template_path):
            print(f"Warning: 'template.html' not found in '{lang_folder}'. Skipping.")
            continue
            
        # Read the template content
        with open(template_path, 'r', encoding='utf-8') as f:
            template_content = f.read()

        # Define docs language directory and create it if it doesn't exist
        target_lang = 'en' if lang_folder == 'master' else lang_folder
        docs_lang_path = os.path.join(docs_dir, target_lang)
        os.makedirs(docs_lang_path, exist_ok=True)

        # Process all other html files in the language directory
        for filename in os.listdir(lang_path):
            if filename.endswith('.html') and filename != 'template.html':
                file_path = os.path.join(lang_path, filename)
                
                # Read the inner content file
                with open(file_path, 'r', encoding='utf-8') as f:
                    inner_content = f.read()
                
                # Replace the placeholder with the inner content
                final_content = template_content.replace('{{{}}}', inner_content)
                
                # Replace the language URL placeholder with the current filename
                final_content = final_content.replace('{[{}]}', filename)
                
                # Write the final content to the docs directory
                output_path = os.path.join(docs_lang_path, filename)
                with open(output_path, 'w', encoding='utf-8') as f:
                    f.write(final_content)
                    
                print(f"Generated: docs/{target_lang}/{filename}")

    print("Documentation generation complete.")

if __name__ == "__main__":
    main()
