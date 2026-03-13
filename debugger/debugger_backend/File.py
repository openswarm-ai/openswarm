import os
from debugger_backend.path_mngr import get_abspath

class File:
    def __init__(self, filename, path):
        self.filename = filename
        self.path = path
    
    def get_abspath(self):
        return get_abspath(self.path)

    def calls_debug_function(self):
        """
        Checks if the file calls the debug function.
        """
        full_path = self.get_abspath()

        if not full_path.endswith('.py') or full_path.endswith('.pyc'):
            result = False
        else:
            try:
                with open(full_path, 'r', encoding='utf-8') as file:
                    content = file.read()
                result = 'debug(' in content
            except (UnicodeDecodeError, FileNotFoundError) as e:
                print(f"Error reading file {full_path}")
                result = False
        # print(f"??calls_debug_function?? {result}")
        return result