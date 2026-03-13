import re
import inspect
import os
from debugger_backend.log_config import log_config
from debugger_backend.Debugleton import Debugleton
from debugger_backend.color_adjuster import rgb_to_ansi, bold_and_italicize_text, hex_to_rgb
from debugger_backend.debug_arg_parser import is_text, is_error

def debug(*args, mode:str='debug', override_max_chars:bool=False):
    frame = inspect.currentframe().f_back
    code = frame.f_code
    line_no = frame.f_lineno
    calling_function_name = frame.f_code.co_name
    calling_file_name = os.path.basename(code.co_filename)
    if calling_function_name == "<module>":
        calling_function_name = calling_file_name
    # Retrieve the file path of the calling function
    file_path = os.path.abspath(code.co_filename)
    # print(f"FILE PATH: {file_path}")
    t_color, t_is_on, t_emoji = Debugleton().find_file_info(file_path)
    # print(f"DEBUGGING: {t_color}, {t_is_on}")
    max_chars = 3000

    with open(code.co_filename, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    line = lines[line_no - 1]
    leading_spaces = len(line) - len(line.lstrip(' '))
    indent = leading_spaces // 4
    arg_names = re.findall(r'debug\((.*?)\)', line)[0].split(', ')
    for arg_name, arg_value in zip(arg_names, args):
        indent_str = ' |\t' * indent
        if indent > 0:
            indent_str = indent_str[:-3] + ' |-- '
        arg_is_error = is_error(arg_value, arg_name)
        arg_is_text = is_text(arg_value, arg_name)
        if arg_is_error:
            t_color = "#FE3F3F"
            t_emoji = "❌"
            t_is_on = True
        
        arg_len = len(str(arg_value))
        if arg_len > max_chars and not override_max_chars:
            if not arg_is_text: arg_value = str(arg_value)
            arg_value = arg_value[:int(max_chars/2)] + "...\n..." + arg_value[arg_len-int(max_chars/2):]
                
        function_print_str = calling_function_name if 'self' not in frame.f_locals else f'{frame.f_locals["self"].__class__.__name__}.{calling_function_name}'
        # color = COLORS.get(function_print_str, white)
        color = hex_to_rgb(t_color)
        if arg_is_text:
            print_str = f"{t_emoji}{rgb_to_ansi(color)}{indent_str}[{function_print_str}] : {bold_and_italicize_text(arg_value)}\033[0m"
        else:
            print_str = f"{t_emoji}{rgb_to_ansi(color)}{indent_str}[{function_print_str}] : {arg_name} = {arg_value}\033[0m"
        if t_is_on: log_config.debug_custom(print_str, mode)

# Assign the function to the module's __call__ attribute
import sys
sys.modules[__name__] = debug
