# Haik: sorry bout the filename

import threading
from debugger_backend.project_scanner import update_debug_toggles
from debugger_backend.Directory import Directory
from debugger_backend.DebugFile import DebugFile
from debugger_backend.DEFAULTS import DEFAULT_COLOR, DEFAULT_TOGGLED, DEFAULT_EMOJI
import os
import time

NEEDS_RESYNC_FILE = os.path.join(os.path.dirname(__file__), 'needs_resync.txt')

class Debugleton:
    _instance = None
    _lock = threading.Lock()  # Lock for thread-safe singleton creation
    sync_lock: threading.Lock

    def __new__(cls, *args, **kwargs):
        # Double-checked locking for thread-safe singleton creation
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super(Debugleton, cls).__new__(cls)
                    print("\033[38;5;120m\n---------------------------------\033[0m")
                    print("\033[38;5;120m|\tDEBUGLETON INIT \t|\033[0m")
                    cls._instance.dir = None
                    print("\033[38;5;120m|\tScanning Project...\t|\033[0m")
                    cls._instance.sync_lock = threading.Lock()
                    cls._instance.sync_lock.acquire(blocking=False)
                    cls._instance.sync_to_saved(is_first_sync=True)
                    cls._instance.sync_lock.release()
                    print("\033[38;5;120m|\t...Project Scanned\t|\033[0m")
                    print("\033[38;5;120m|\tDEBUGLETON INIT DONE\t|\033[0m")
                    print("\033[38;5;120m---------------------------------\n\033[0m")
        #         else: print("DEBUGLETON Already initialized INNER")
        # else: print("DEBUGLETON Already initialized OUTER")
        return cls._instance
    

    def sync_to_saved(self, is_first_sync=False):
        # print(f"[sync_to_saved]: START")
        if not is_first_sync: self.sync_lock.acquire()
        # print(f"[sync_to_saved]: Acquired sync lock")
        self.dir = update_debug_toggles(save_to_file=False)
        # print(f"Synced to saved dir: {self.dir}")
        self.abspaths, self.instances = self.dir.get_ordered_abspaths_and_instances()
        # print(f"Synced to abspaths: {self.abspaths}")
        with open(NEEDS_RESYNC_FILE, 'w') as f:
            f.write('0')
        if not is_first_sync: self.sync_lock.release()
        # print(f"[sync_to_saved]: Released sync lock")
        # print(f"[sync_to_saved]: END")

    def needs_resync(self):
        # print(f"[needs_resync]: START")
        num_tries = 0
        while self.is_syncing():
            print(f"Waiting for Debugleton to sync... ({num_tries})")
            time.sleep(5)
            num_tries += 1
            if num_tries > 10:
                print(f"""
                      NOTE: Debugleton is taking a long time, there's one scenario where it breaks:
                      \n\t- If running in docker, and you deleted one of the root dirs in the volumes of docker compose,
                      \n\t  then the debugger will not be able to find the project and will get stuck in an infinite loop.
                      \n\t- In this case, you can restart the docker container and delete the volume in the docker compose file and it will resync.
                      """)
        with open(NEEDS_RESYNC_FILE, 'r') as f:
                does_need_resync = True if f.read().strip() == '1' else False
        # if does_need_resync: print("Resyncing Debugleton...")
        # print(f"[needs_resync]: END")
        return does_need_resync
    
    def is_syncing(self):
        return self.sync_lock.locked()

    def find_file_info(self, filepath: str):
        filepath = filepath.lower()
        # print(f"Finding file info for {filepath}")
        if self.needs_resync():
            self.sync_to_saved()
        try:
            filepath_id = self.abspaths.index(filepath)
            match = self.instances[filepath_id]
            return match.color, match.is_toggled, match.emoji
        except ValueError:
            print(f"Filepath not found: {filepath}")
            return DEFAULT_COLOR, DEFAULT_TOGGLED, DEFAULT_EMOJI