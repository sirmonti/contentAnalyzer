import sys
import os

def set_debug_mode(enable):
    folders = [
        "content-analyzer-ext-chrome",
        "content-analyzer-ext-firefox",
        "content-analyzer-ext-android"
    ]
    files_to_patch = ["background.js", "options.js", "result.js"]
    
    target_str = "const DEBUG_MODE = true;" if enable else "const DEBUG_MODE = false;"
    search_str = "const DEBUG_MODE = false;" if enable else "const DEBUG_MODE = true;"

    changed_count = 0

    for folder in folders:
        if not os.path.isdir(folder):
            print(f"Warning: Directory {folder} not found.")
            continue
            
        for file_name in files_to_patch:
            file_path = os.path.join(folder, file_name)
            if not os.path.isfile(file_path):
                print(f"Warning: File {file_path} not found.")
                continue
                
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
                
            if search_str in content:
                content = content.replace(search_str, target_str)
                with open(file_path, "w", encoding="utf-8") as f:
                    f.write(content)
                changed_count += 1
                print(f"Updated {file_path} -> {target_str}")
            elif target_str in content:
                print(f"Skipped {file_path} (already in target state)")
            else:
                print(f"Warning: No se encontró la constante DEBUG_MODE en {file_path}")

    mode_str = "activado" if enable else "desactivado"
    print(f"\nModo debug {mode_str}. Archivos modificados: {changed_count}")

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1].lower() not in ['on', 'off']:
        print("Uso: python toggle_debug.py [on|off]")
        print("Ejemplo para activarlo: python toggle_debug.py on")
        print("Ejemplo para desactivarlo: python toggle_debug.py off")
        sys.exit(1)
        
    enable = sys.argv[1].lower() == 'on'
    set_debug_mode(enable)
