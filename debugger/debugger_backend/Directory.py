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
        self.children = []
        self.color = color
        self.is_toggled = is_toggled
        self.set_manually = set_manually
        self.emoji = emoji

    def __str__(self):
        return f"Directory: {self.path}\nNum Children: {len(self.children)}\nColor: {self.color}\nToggled: {self.is_toggled}\nSet Manually: {self.set_manually}"
    
    def get_abspath(self):
        return get_abspath(self.path)

    def add_child(self, child):
        """Append a child DebugFile/Directory."""
        self.children.append(child)

    def get_ordered_abspaths_and_instances(self):
        curr_file_path = os.path.abspath(__file__)
        root_dir = os.path.dirname(os.path.dirname(os.path.dirname(curr_file_path)))
        def construct_ordered_abspaths(dir: Directory, ordered_abspaths: list):
            dir_path = dir.path
            full_path = os.path.join(root_dir, dir_path)
            ordered_abspaths.append({"abspath": full_path, "instance": dir})
            for child in dir.children:
                child_abspath = os.path.join(root_dir, child.path).lower()
                if os.path.isdir(child_abspath):
                    construct_ordered_abspaths(child, ordered_abspaths)
                elif os.path.isfile(child_abspath):
                    ordered_abspaths.append({"abspath": child_abspath, "instance": child})
                else:
                    print(f"\033[38;5;120mEntry is non existent: {child_abspath}\033[0m")
            return ordered_abspaths
        ordered_abspaths_and_instances = construct_ordered_abspaths(self, [])
        ordered_abspaths = [abspath_and_instance["abspath"] for abspath_and_instance in ordered_abspaths_and_instances]
        ordered_instances = [abspath_and_instance["instance"] for abspath_and_instance in ordered_abspaths_and_instances]
        return ordered_abspaths, ordered_instances
            

    def build_structure(self):
        print("[build_structure]: START")
        root_dir = self.get_abspath()
        excluded_dirs = [".venv", "debugger", "node_modules", ".git", "__pycache__"]

        def construct_project_structure(dir_path: str, parent_dir: Directory):
            with os.scandir(dir_path) as it:
                for entry in it:
                    if any(excluded_dir in entry.path for excluded_dir in excluded_dirs):
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
        return

    def to_dict(self):
        """Recursively convert the Directory to a dict."""
        return {
            "name": os.path.basename(self.path),
            "color": self.color,
            "is_toggled": self.is_toggled,
            "set_manually": self.set_manually,
            "emoji": self.emoji,
            "children": [child.to_dict() if isinstance(child, DebugFile) else child.to_dict() for child in self.children]
        }

    def prune_empty(self):
        for child in self.children[:]:
            if isinstance(child, Directory):
                child.prune_empty()
                if len(child.children) == 0:
                    self.children.remove(child)

    def propagate_toggled_state(self):
        """Propagate the toggled state down the hierarchy."""
        for child in self.children:
            if isinstance(child, DebugFile) and not child.set_manually:
                child.is_toggled = self.is_toggled
            elif isinstance(child, Directory) and not child.set_manually:
                child.is_toggled = self.is_toggled
                child.propagate_toggled_state()

    def propagate_color(self, parent_color=DEFAULT_COLOR):
        """Propagate color from parent to children."""
        if self.color == DEFAULT_COLOR:
            self.color = lighten_color(parent_color)
        for child in self.children:
            if isinstance(child, DebugFile) and child.color == DEFAULT_COLOR:
                child.color = lighten_color(self.color)
            elif isinstance(child, Directory):
                child.propagate_color(self.color)

    def load_from_json(self, json_data):
        """Load a directory structure from JSON into this Directory."""
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
        """Reset every nested color to the default."""
        self.color = DEFAULT_COLOR
        for child in self.children:
            if isinstance(child, DebugFile):
                child.color = DEFAULT_COLOR
            elif isinstance(child, Directory):
                child.reset_colors()


def lighten_color(color, amount=0.1):
    """Lighten the given color by amount."""
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
