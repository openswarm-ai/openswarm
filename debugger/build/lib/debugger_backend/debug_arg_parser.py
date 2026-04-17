
def is_fstring(arg_name):
    if not isinstance(arg_name, str):
        return False
    # print(f"arg_name: {arg_name}")
    fstring_start_values = ["f'", "f\""]
    num_start_matches = sum(arg_name.startswith(start_value) for start_value in fstring_start_values)
    conditions = [num_start_matches == 1]
    return all(conditions)

def is_text(arg_value, arg_name):
    arg_is_text = isinstance(arg_value, str) and len(arg_name) > 2 and arg_name[1:len(arg_name)-1] == arg_value and not arg_name.endswith(")")
    if not arg_is_text:
        arg_is_text = is_fstring(arg_name)
    # print(f"is_text: {arg_is_text}")
    return arg_is_text

def is_error(arg_value, arg_name):
    arg_is_error = isinstance(arg_value, Exception) or "error" in str(arg_value).lower() or "error" in str(arg_name).lower()
    return arg_is_error

