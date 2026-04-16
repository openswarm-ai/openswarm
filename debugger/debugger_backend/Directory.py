import os
import json
import colorsys
from pathlib import Path
from debugger_backend.DebugFile import DebugFile
from debugger_backend.DEFAULTS import DEFAULT_COLOR, DEFAULT_TOGGLED, DEFAULT_SET_MANUALLY, DEFAULT_EMOJI
from debugger_backend.path_mngr import get_abspath, get_root_rel_path

class Directory:
    def __init__(self, path, color=DEFAULT_COLOR, is_toggled=DEFAULT_TOGGLED, 
                 set_manually=DEFAULT_SET_MANUALLY, emoji=DEFAULT_EMOJI):
        self.path = path
        # print(f"Directory init: {self.path}")
        self.children = []  # Can contain DebugFile or other Directory objects
        self.color = color
        self.is_toggled = is_toggled
        self.set_manually = set_manually
        self.emoji = emoji

    def __str__(self):
        return f"Directory: {self.path}\nNum Children: {len(self.children)}\nColor: {self.color}\nToggled: {self.is_toggled}\nSet Manually: {self.set_manually}"
    
    def get_abspath(self):
        return get_abspath(self.path)

    def add_child(self, child):
        """
        Adds a child to the directory (either a DebugFile or another Directory).
        """
        self.children.append(child)

    def get_ordered_abspaths_and_instances(self):
        # print("[get_ordered_abspaths]: START")
        curr_file_path = os.path.abspath(__file__)
        root_dir = os.path.dirname(os.path.dirname(os.path.dirname(curr_file_path)))
        # print(f"[get_ordered_abspaths]: Curr path: {curr_file_path}")
        # print(f"[get_ordered_abspaths]:  Dir path: {root_dir}")
        def construct_ordered_abspaths(dir: Directory, ordered_abspaths: list):
            dir_path = dir.path
            full_path = os.path.join(root_dir, dir_path)
            ordered_abspaths.append({"abspath": full_path, "instance": dir})
            # print(f"\t[construct_ordered_abspaths]: Full path: {full_path}")
            for child in dir.children:
                child_abspath = os.path.join(root_dir, child.path).lower()
                if os.path.isdir(child_abspath):
                    construct_ordered_abspaths(child, ordered_abspaths)
                elif os.path.isfile(child_abspath):
                    # print(f"\t[construct_ordered_abspaths]: Child is file: {child_abspath}")
                    ordered_abspaths.append({"abspath": child_abspath, "instance": child})
                else:
                    print(f"\033[38;5;120mEntry is non existent: {child_abspath}\033[0m")
                # print(f"\t[construct_ordered_abspaths]: Finished for dir: {full_path}")
            # print(f"\t[construct_ordered_abspaths]: RETURNING FROM DIR: {full_path}")
            return ordered_abspaths
        ordered_abspaths_and_instances = construct_ordered_abspaths(self, [])
        # print("[get_ordered_abspaths]: Finished getting ordered abspaths and instances")
        # for abspath_and_instance in ordered_abspaths_and_instances:
        #     abspath = abspath_and_instance["abspath"]
            # print(f"\t[get_ordered_abspaths]: Abspath: {abspath}")
        ordered_abspaths = [abspath_and_instance["abspath"] for abspath_and_instance in ordered_abspaths_and_instances]
        ordered_instances = [abspath_and_instance["instance"] for abspath_and_instance in ordered_abspaths_and_instances]
        return ordered_abspaths, ordered_instances
            

    def build_structure(self):
        print("[build_structure]: START")
        root_dir = self.get_abspath()
        # print(f"[build_structure]: Root dir: {root_dir}")
        excluded_dirs = [".venv", "debugger", "node_modules", ".git", "__pycache__"]
        project_structure = []

        def construct_project_structure(dir_path: str, parent_dir: Directory):
            # print(f"[build_structure]: Scanning dir: {dir_path}")
            with os.scandir(dir_path) as it:
                for entry in it:
                    # print(f"[build_structure]: Entry: {entry.path}")
                    if any(excluded_dir in entry.path for excluded_dir in excluded_dirs):
                        # print(f"[build_structure]: Excluding {entry.path}")
                        continue
                    root_rel_path = get_root_rel_path(entry.path)
                    if entry.is_dir():
                        subdir = Directory(root_rel_path)
                        construct_project_structure(entry.path, subdir)
                        parent_dir.add_child(subdir)
                    elif entry.is_file():
                        debug_file = DebugFile(filename=entry.name, path=root_rel_path)
                        if debug_file.calls_debug_function():
                            parent_dir.add_child(debug_file)
                    else:
                        continue
        
        construct_project_structure(root_dir, self)        
        # [print(f"[build_structure]: {file}") for file in project_structure]
        # print(f"[build_structure]: END")
        return

    def to_dict(self):
        """
        Converts the Directory object to a dictionary format, recursively.
        """
        return {
            "name": os.path.basename(self.path),
            "color": self.color,
            "is_toggled": self.is_toggled,
            "set_manually": self.set_manually,
            "emoji": self.emoji,
            "children": [child.to_dict() if isinstance(child, DebugFile) else child.to_dict() for child in self.children]
        }

    def prune_empty(self):
        # Recursively prune empty directories
            # Base case) if the current directory has no children, return
            # Recursive case) for each of the directories in the current directory, call prune_empty
            # then remove the directory from the children of the current directory if it has no children
        for child in self.children[:]:
            if isinstance(child, Directory):
                # Recursively prune empty subdirectories
                child.prune_empty()
                # If the subdirectory is empty after pruning, remove it
                if len(child.children) == 0:
                    self.children.remove(child)
        
    def propagate_toggled_state(self):
        """
        Propagates the toggled state down the hierarchy.
        """
        for child in self.children:
            if isinstance(child, DebugFile) and not child.set_manually:
                child.is_toggled = self.is_toggled
            elif isinstance(child, Directory) and not child.set_manually:
                child.is_toggled = self.is_toggled
                child.propagate_toggled_state()

    def propagate_color(self, parent_color=DEFAULT_COLOR):
        """
        Propagates the color from parent to children.
        """
        if self.color == DEFAULT_COLOR:
            self.color = lighten_color(parent_color)
        for child in self.children:
            if isinstance(child, DebugFile) and child.color == DEFAULT_COLOR:
                child.color = lighten_color(self.color)
            elif isinstance(child, Directory):
                child.propagate_color(self.color)

    def load_from_json(self, json_data):
        """
        Loads a directory structure from a JSON file into this Directory instance.
        """
        for item in json_data:
            if 'children' in item:
                subdir = Directory(
                    path=os.path.join(self.path, item['name']), 
                    color=item.get('color', DEFAULT_COLOR), 
                    is_toggled=item.get('is_toggled', DEFAULT_TOGGLED), 
                    set_manually=item.get('set_manually', DEFAULT_SET_MANUALLY),
                    emoji=item.get('emoji', DEFAULT_EMOJI)
                    )
                
                subdir.load_from_json(item['children'])
                self.add_child(subdir)
            else:
                # debug_file = DebugFile.from_dict(item, self)
                debug_file = DebugFile(
                    filename=item['name'],
                    path=os.path.join(self.path, item['name']),
                    color=item.get('color', DEFAULT_COLOR),
                    is_toggled=item.get('is_toggled', DEFAULT_TOGGLED),
                    set_manually=item.get('set_manually', DEFAULT_SET_MANUALLY),
                    emoji=item.get('emoji', DEFAULT_EMOJI),
                    directory=self
                )
                self.add_child(debug_file)

    def reset_colors(self):
        """
        Resets the color of all DebugFile and Directory objects in this directory structure to the default color.
        """
        self.color = DEFAULT_COLOR
        for child in self.children:
            if isinstance(child, DebugFile):
                child.color = DEFAULT_COLOR
            elif isinstance(child, Directory):
                child.reset_colors()


def lighten_color(color, amount=0.1):
    """
    Lightens the given color by the specified amount.
    """
    try:
        color = color.lstrip('#')
        r, g, b = int(color[:2], 16), int(color[2:4], 16), int(color[4:6], 16)
        h, l, s = colorsys.rgb_to_hls(r / 255.0, g / 255.0, b / 255.0)
        l = min(1, l + amount)
        r, g, b = colorsys.hls_to_rgb(h, l, s)
        return '#{:02x}{:02x}{:02x}'.format(int(r * 255), int(g * 255), int(b * 255))
    except Exception as e:
        print(f"Error lightening color {color}: {e}")
        return color
