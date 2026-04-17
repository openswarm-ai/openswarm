import os
from debugger_backend.File import File
from debugger_backend.DEFAULTS import DEFAULT_COLOR, DEFAULT_TOGGLED, DEFAULT_SET_MANUALLY, DEFAULT_EMOJI

class DebugFile(File):
    def __init__(self, filename, path, color=DEFAULT_COLOR, is_toggled=DEFAULT_TOGGLED, 
                 set_manually=DEFAULT_SET_MANUALLY, emoji=DEFAULT_EMOJI, directory=None):
        super().__init__(filename, path)
        self.color = color
        self.is_toggled = is_toggled
        self.set_manually = set_manually
        self.emoji = emoji
        self.directory = directory  # Reference to parent directory

    def to_dict(self):
        """
        Converts the DebugFile object to a dictionary format.
        """
        return {
            "name": os.path.basename(self.filename),
            "color": self.color,
            "is_toggled": self.is_toggled,
            "set_manually": self.set_manually,
            "emoji": self.emoji
        }

    @classmethod
    def from_dict(cls, file_dict, directory):
        """
        Creates a DebugFile object from a dictionary loaded from JSON.
        """
        filename = os.path.join(directory.path, file_dict["name"])
        return cls(
            filename=filename,
            color=file_dict.get("color", DEFAULT_COLOR),
            is_toggled=file_dict.get("is_toggled", DEFAULT_TOGGLED),
            set_manually=file_dict.get("set_manually", DEFAULT_SET_MANUALLY),
            directory=directory
        )
