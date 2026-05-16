import logging
from typing import Dict, Any, List, Optional
from backend.providers.base import get_provider, BaseProvider

logger = logging.getLogger(__name__)

class ProviderManager:
    def __init__(self, configs: List[Dict[str, Any]]):
        """
        configs: List of { 'name': 'my-openai', 'provider': 'openai', 'api_key': '...', 'base_url': '...' }
        """
        self.providers: Dict[str, BaseProvider] = {}
        self.config_map: Dict[str, Dict[str, Any]] = {}

        for cfg in configs:
            name = cfg.get('name', cfg.get('provider'))
            self.config_map[name] = cfg
            self.providers[name] = get_provider(
                cfg['provider'],
                cfg['api_key'],
                cfg.get('base_url')
            )

    def get_provider(self, name: str) -> Optional[BaseProvider]:
        return self.providers.get(name)

    def list_available_models(self) -> List[Dict[str, str]]:
        models = []
        for name, cfg in self.config_map.items():
            models.append({
                "config_name": name,
                "provider": cfg['provider'],
                "model_hint": cfg.get('default_model', 'unknown')
            })
        return models

class Router:
    def __init__(self, provider_manager: ProviderManager):
        self.pm = provider_manager

    async def route_chat(self, model_alias: str, messages: List[Dict[str, Any]], **kwargs):
        """
        model_alias could be a config name or a provider name.
        """
        provider = self.pm.get_provider(model_alias)
        if not provider:
            # Try default if exists
            provider = next(iter(self.pm.providers.values()), None)

        if not provider:
            raise ValueError(f"No provider found for alias {model_alias}")

        # Actual model name to use from kwargs or config
        model = kwargs.pop('model', self.pm.config_map.get(model_alias, {}).get('default_model', 'gpt-4o'))

        return await provider.chat(model, messages, **kwargs)
