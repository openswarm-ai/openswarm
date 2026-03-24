"""Voice Wake Word Detection — scaffolded interface.

Matches OpenClaw's current state: the interface is defined but full
implementation is deferred. Supports future integration with Vosk
(offline) or Porcupine wake word engines.

Usage:
    This module defines the configuration and interface. Actual wake word
    detection runs on the client device (macOS/iOS/Android) and sends
    a "wake" event to the gateway when triggered.
"""
import logging
from typing import Optional
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class WakeWordConfig(BaseModel):
    """Configuration for wake word detection."""
    enabled: bool = False
    wake_words: list[str] = Field(default_factory=lambda: ["hey swarm", "open swarm"])
    sensitivity: float = 0.5  # 0.0 - 1.0
    engine: str = "vosk"  # "vosk" | "porcupine"


class WakeWordManager:
    """Manages wake word detection state.

    In the current scaffolded implementation, this stores configuration
    and handles wake events from client devices. The actual audio
    processing runs on the client side.
    """

    def __init__(self):
        self.config = WakeWordConfig()
        self._active_devices: dict[str, bool] = {}

    def update_config(self, **kwargs):
        for k, v in kwargs.items():
            if hasattr(self.config, k):
                setattr(self.config, k, v)

    def register_device(self, device_id: str):
        self._active_devices[device_id] = True
        logger.info("Wake word device registered: %s", device_id)

    def unregister_device(self, device_id: str):
        self._active_devices.pop(device_id, None)

    def handle_wake_event(self, device_id: str, wake_word: str) -> bool:
        """Called when a client device detects a wake word.

        Returns True if the wake event should trigger a talk session.
        """
        if not self.config.enabled:
            return False
        if device_id not in self._active_devices:
            return False
        if wake_word.lower() not in [w.lower() for w in self.config.wake_words]:
            return False

        logger.info("Wake word detected: '%s' from device %s", wake_word, device_id)
        return True


# Singleton
wake_word_manager = WakeWordManager()
