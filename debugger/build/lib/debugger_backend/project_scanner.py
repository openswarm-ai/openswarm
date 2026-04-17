import os
import json
import colorsys
from typing import Union
from debugger_backend.Directory import Directory
from debugger_backend.DEFAULTS import DEFAULT_COLOR, DEFAULT_TOGGLED, DEFAULT_SET_MANUALLY, TOGGLE_FILE, DEFAULT_EMOJI, ROOT_DIR
from debugger_backend.DebugFile import DebugFile
from collections import OrderedDict

def merge_directories(json_dir: Directory, scanned_dir: Directory):
    """
    Merges two Directory instances: one loaded from JSON (json_dir) and one built from scanning (scanned_dir).
    The values from json_dir take precedence where attributes overlap.
    It matches based on full directory and file structure, not just file names.
    """
    # print(f"Merging JSON_DIR: {json_dir.path}\n with SCAN_DIR: {scanned_dir.path}")
    json_abspaths, json_instances = json_dir.get_ordered_abspaths_and_instances()
    # print(f"json_abspaths: {json_abspaths}")
    scanned_abspaths, scanned_instances = scanned_dir.get_ordered_abspaths_and_instances()
    # print(f"scanned_abspaths: {scanned_abspaths}")

    def find_matching_in_structure(scanned_child: Union[DebugFile, Directory], json_dir: Directory):
        assert json_dir in json_instances, f"JSON_DIR: {json_dir.path} not in json_instances"
        assert scanned_child in scanned_instances, f"SCANNED_CHILD: {scanned_child.path} not in scanned_instances"
        scanned_id = scanned_instances.index(scanned_child)
        scanned_abspath = scanned_abspaths[scanned_id]
        json_instance = None
        try:
            json_id = json_abspaths.index(scanned_abspath)
            json_instance = json_instances[json_id]
            # print(f"Match found: {scanned_child.path} == {json_instance.path}")
        except ValueError:
            # print(f"SCANNED_ABSPATH: {scanned_abspath} not in JSON_ABSPATHS")
            pass
        return json_instance

    def construct_merged_dir(json_dir: Directory, scanned_dir: Directory):
        for scanned_child in scanned_dir.children:
            # Use the new recursive function to find the corresponding child in the JSON directory structure
            matching_json_child = find_matching_in_structure(scanned_child, json_dir)
            
            if isinstance(scanned_child, DebugFile) and matching_json_child:
                # Merge attributes from the JSON-loaded structure
                scanned_child.color = matching_json_child.color
                scanned_child.is_toggled = matching_json_child.is_toggled
                scanned_child.set_manually = matching_json_child.set_manually
                scanned_child.emoji = matching_json_child.emoji

            elif isinstance(scanned_child, Directory) and matching_json_child:
                # Merge directory attributes
                scanned_child.color = matching_json_child.color
                scanned_child.is_toggled = matching_json_child.is_toggled
                scanned_child.set_manually = matching_json_child.set_manually
                scanned_child.emoji = matching_json_child.emoji

                # Recursively merge the subdirectories
                construct_merged_dir(matching_json_child, scanned_child)
            else:
                scanned_child.color = DEFAULT_COLOR
                scanned_child.is_toggled = DEFAULT_TOGGLED
                scanned_child.set_manually = DEFAULT_SET_MANUALLY
                scanned_child.emoji = DEFAULT_EMOJI
    
    construct_merged_dir(json_dir, scanned_dir)


def update_debug_toggles(save_to_file=True) -> Directory:
    # print(f"[update_debug_toggles]: START")
    json_loaded_dir = None
    if os.path.exists(TOGGLE_FILE):
        with open(TOGGLE_FILE, 'r', encoding='utf-8') as file:
            try:
                json_data = json.load(file)
                json_loaded_dir = Directory("")
                json_loaded_dir = Directory(path="",
                                            color=json_data[0].get('color', DEFAULT_COLOR),
                                            is_toggled=json_data[0].get('is_toggled', DEFAULT_TOGGLED),
                                            set_manually=json_data[0].get('set_manually', DEFAULT_SET_MANUALLY),
                                            emoji=json_data[0].get('emoji', DEFAULT_EMOJI)
                                            )
                # print(f"Root: {json_loaded_dir}")
                # print("Json Children 1:")
                # [print(child.path) for child in json_loaded_dir.children]

                json_loaded_dir.load_from_json(json_data[0]['children'])  # Assuming the root is in json_data[0]
                # print("Json Children 2:")
                # [print(child.path) for child in json_loaded_dir.children]

            except json.JSONDecodeError:
                ValueError("Error: JSON file could not be decoded.")
    else:
        print("No JSON file found")
    # 1. Create a directory structure from the filesystem scan
    # print("Scanning directory...")
    scanned_dir = Directory(path="", 
                            color=json_loaded_dir.color if json_loaded_dir else DEFAULT_COLOR, 
                            is_toggled=json_loaded_dir.is_toggled if json_loaded_dir else DEFAULT_TOGGLED, 
                            set_manually=json_loaded_dir.set_manually if json_loaded_dir else DEFAULT_SET_MANUALLY,
                            emoji=json_loaded_dir.emoji if json_loaded_dir else DEFAULT_EMOJI
                            )
    # print(f"\n\nNum Children 1: {len(scanned_dir.children)}")
    # [print(child.path) for child in scanned_dir.children]
    scanned_dir.build_structure()
    # print(f"\n\nNum Children 2: {len(scanned_dir.children)}")
    # [print(child.path) for child in scanned_dir.children]
    scanned_dir.prune_empty()
    # print(f"\n\nNum Children 3: {len(scanned_dir.children)}")
    # [print(child.path) for child in scanned_dir.children]

    # print("1.1 Merged Dir First Child: ", scanned_dir.children[0])
    # 4. Propagate the toggled state and color through the merged structure
    scanned_dir.propagate_toggled_state()
    # print(f"\n\nNum Children 4: {len(scanned_dir.children)}")
    # [print(child.path) for child in scanned_dir.children]

    # 3. Merge the two directory structures
    if json_loaded_dir:
        merge_directories(json_loaded_dir, scanned_dir)
    
    # print(f"\n\nNum Children 5: {len(scanned_dir.children)}")
    scanned_dir.propagate_color()
    output = dir_to_output_format(scanned_dir)
    # print(f"\n\nNum Children 6: {len(scanned_dir.children)}")
    

    # 5. Write the updated structure back to the JSON file
    if save_to_file:
        with open(TOGGLE_FILE, 'w', encoding='utf-8') as file:
             json.dump(output, file, ensure_ascii=False, indent=4)
    # print(f"[update_debug_toggles]: END")
    return scanned_dir

def dir_to_output_format(input_dir):
    root_node = {
        "name": "root",
        "color": input_dir.color,  # Use input_dir's color
        "is_toggled": input_dir.is_toggled,  # Use input_dir's toggled state
        "set_manually": input_dir.set_manually,  # Use input_dir's set_manually
        "emoji": input_dir.emoji,  # Use input_dir's emoji
        "children": input_dir.to_dict()["children"]
    }
    return [ordered(root_node)]

def ordered(obj):
    if isinstance(obj, dict):
        return OrderedDict((k, ordered(v)) for k, v in obj.items())
    if isinstance(obj, list):
        return [ordered(x) for x in obj]
    return obj
