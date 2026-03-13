import logging
from debugger_backend.log_mode import get_log_mode, set_log_mode

class LogConfig:
    _instance = None
    MODES = {
        "all": 1,
        "debug": 10,
        "test": 20,
    }

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(LogConfig, cls).__new__(cls)
            cls._instance._initialize_logger()
        return cls._instance

    def _initialize_logger(self):
        for name, level in self.MODES.items():
            logging.addLevelName(level, name.upper())
        self.logger = logging.getLogger('custom_logger')
        self.logger.propagate = False  # Prevent log propagation
        handler = logging.StreamHandler()
        formatter = logging.Formatter('%(message)s')
        handler.setFormatter(formatter)

        # Remove existing handlers to prevent duplicate logging
        if self.logger.hasHandlers():
            self.logger.handlers.clear()

        self.logger.addHandler(handler)
        self.set_debug_mode(get_log_mode())

    def debug_custom(self, message, mode = None, *args, **kwargs):
        if mode is None:
            mode = get_log_mode()
        if self.logger.isEnabledFor(self.MODES[mode]):
            self.logger._log(self.MODES[mode], message, args, **kwargs)

    def set_debug_mode(self, mode):
        current_mode = get_log_mode()
        # print(f"Setting debug mode from {current_mode} -> to {mode}")
        if mode not in self.MODES: raise ValueError(f"Invalid mode: {mode}")
        set_log_mode(mode)
        self.logger.setLevel(self.MODES[mode])

    def get_debug_mode(self):
        return get_log_mode()

log_config = LogConfig()
