import json
import urllib.request
import urllib.parse
import ssl
import logging
import asyncio
from typing import Dict, Any, List, Optional, AsyncIterator, Union

logger = logging.getLogger(__name__)

class HttpResponse:
    def __init__(self, status: int, headers: Dict[str, str], body: Any):
        self.status = status
        self.headers = headers
        self.body = body

class BaseProvider:
    def __init__(self, api_key: str, base_url: str):
        self.api_key = api_key
        self.base_url = base_url.rstrip('/')

    def _sync_http_request(self, url: str, method: str = 'GET', headers: Optional[Dict[str, str]] = None, body: Any = None) -> HttpResponse:
        if headers is None:
            headers = {}

        if body is not None and not isinstance(body, bytes):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode('utf-8')
                headers.setdefault('Content-Type', 'application/json')
            else:
                body = str(body).encode('utf-8')

        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        context = ssl.create_default_context()

        try:
            with urllib.request.urlopen(req, timeout=60, context=context) as response:
                resp_body = response.read()
                resp_headers = dict(response.info())
                status = response.getcode()
                try:
                    content = json.loads(resp_body.decode('utf-8'))
                except:
                    content = resp_body.decode('utf-8', errors='ignore')
                return HttpResponse(status, resp_headers, content)
        except urllib.error.HTTPError as e:
            resp_body = e.read()
            try:
                content = json.loads(resp_body.decode('utf-8'))
            except:
                content = resp_body.decode('utf-8', errors='ignore')
            return HttpResponse(e.code, dict(e.headers), content)
        except Exception as e:
            logger.error(f"HTTP Request failed: {e}")
            return HttpResponse(0, {}, {"error": str(e)})

    async def _http_request(self, url: str, method: str = 'GET', headers: Optional[Dict[str, str]] = None, body: Any = None) -> HttpResponse:
        return await asyncio.to_thread(self._sync_http_request, url, method, headers, body)

    async def chat(self, model: str, messages: List[Dict[str, Any]], **kwargs) -> HttpResponse:
        raise NotImplementedError

class OpenAICompatibleProvider(BaseProvider):
    def chat_endpoint(self) -> str:
        return f"{self.base_url}/chat/completions"

    async def chat(self, model: str, messages: List[Dict[str, Any]], **kwargs) -> HttpResponse:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        data = {
            "model": model,
            "messages": messages,
            **kwargs
        }
        return await self._http_request(self.chat_endpoint(), method='POST', headers=headers, body=data)

class AnthropicProvider(BaseProvider):
    async def chat(self, model: str, messages: List[Dict[str, Any]], **kwargs) -> HttpResponse:
        url = f"{self.base_url}/v1/messages"
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
        }

        system = kwargs.pop("system", None)
        if messages and messages[0]["role"] == "system":
            messages = messages.copy()
            system = messages.pop(0)["content"]

        data = {
            "model": model,
            "messages": messages,
            "max_tokens": kwargs.pop("max_tokens", 4096),
            **kwargs
        }
        if system:
            data["system"] = system

        return await self._http_request(url, method='POST', headers=headers, body=data)

class GeminiProvider(BaseProvider):
    async def chat(self, model: str, messages: List[Dict[str, Any]], **kwargs) -> HttpResponse:
        model_path = model if model.startswith("models/") else f"models/{model}"
        url = f"{self.base_url}/{model_path}:generateContent?key={self.api_key}"
        headers = {"Content-Type": "application/json"}

        contents = []
        system_instruction = None
        for msg in messages:
            if msg["role"] == "system":
                system_instruction = {"parts": [{"text": msg["content"]}]}
            else:
                role = "user" if msg["role"] == "user" else "model"
                contents.append({
                    "role": role,
                    "parts": [{"text": msg["content"]}]
                })

        data = {"contents": contents}
        if system_instruction:
            data["systemInstruction"] = system_instruction

        if "tools" in kwargs:
            data["tools"] = [{"functionDeclarations": kwargs.pop("tools")}]

        return await self._http_request(url, method='POST', headers=headers, body=data)

class CohereProvider(BaseProvider):
    def __init__(self, api_key: str):
        super().__init__(api_key, "https://api.cohere.ai/v1")

    async def chat(self, model: str, messages: List[Dict[str, Any]], **kwargs) -> HttpResponse:
        url = f"{self.base_url}/chat"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }

        chat_history = []
        message = ""
        if messages:
            message = messages[-1]["content"]
            for msg in messages[:-1]:
                role = "USER" if msg["role"] == "user" else "CHATBOT"
                chat_history.append({"role": role, "message": msg["content"]})

        data = {
            "model": model,
            "message": message,
            "chat_history": chat_history,
            **kwargs
        }
        return await self._http_request(url, method='POST', headers=headers, body=data)

# Factory function for all providers
def get_provider(name: str, api_key: str, base_url: Optional[str] = None) -> BaseProvider:
    name = name.lower()
    # Explicitly supported or OpenAI-compatible
    providers = {
        "anthropic": (AnthropicProvider, "https://api.anthropic.com"),
        "openai": (OpenAICompatibleProvider, "https://api.openai.com/v1"),
        "gemini": (GeminiProvider, "https://generativelanguage.googleapis.com/v1beta"),
        "mistral": (OpenAICompatibleProvider, "https://api.mistral.ai/v1"),
        "cohere": (CohereProvider, ""), # BaseURL in constructor
        "groq": (OpenAICompatibleProvider, "https://api.groq.com/openai/v1"),
        "deepseek": (OpenAICompatibleProvider, "https://api.deepseek.com"),
        "perplexity": (OpenAICompatibleProvider, "https://api.perplexity.ai"),
        "openrouter": (OpenAICompatibleProvider, "https://openrouter.ai/api/v1"),
        "together": (OpenAICompatibleProvider, "https://api.together.xyz/v1"),
        "replicate": (OpenAICompatibleProvider, "https://api.replicate.com/v1"),
        "fireworks": (OpenAICompatibleProvider, "https://api.fireworks.ai/inference/v1"),
        "octoai": (OpenAICompatibleProvider, "https://octoai.cloud/v1"),
        "lepton": (OpenAICompatibleProvider, "https://lepton.ai/api/v1"),
        "novita": (OpenAICompatibleProvider, "https://api.novita.ai/v3/openai"),
        "grok": (OpenAICompatibleProvider, "https://api.x.ai/v1"),
        "huggingface": (OpenAICompatibleProvider, "https://api-inference.huggingface.co/v1"),
        "voyage": (OpenAICompatibleProvider, "https://api.voyageai.com/v1"),
        "jina": (OpenAICompatibleProvider, "https://api.jina.ai/v1"),
        "upstage": (OpenAICompatibleProvider, "https://api.upstage.ai/v1/solar"),
        "friendli": (OpenAICompatibleProvider, "https://api.friendli.ai/v1"),
        "cerebras": (OpenAICompatibleProvider, "https://api.cerebras.ai/v1"),
        "sambanova": (OpenAICompatibleProvider, "https://api.sambanova.ai/v1"),
        "minimax": (OpenAICompatibleProvider, "https://api.minimax.ai/v1"),
        "moonshot": (OpenAICompatibleProvider, "https://api.moonshot.cn/v1"),
        "bytedance": (OpenAICompatibleProvider, "https://ark.cn-beijing.volces.com/api/v3"),
        "alibaba": (OpenAICompatibleProvider, "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        "baidu": (OpenAICompatibleProvider, "https://qianfan.baidubce.com/v2"),
        "zhipu": (OpenAICompatibleProvider, "https://open.bigmodel.cn/api/paas/v4"),
        "01ai": (OpenAICompatibleProvider, "https://api.lingyiwanwu.com/v1"),
        "aws": (OpenAICompatibleProvider, ""), # Placeholder for custom AWS handler if needed
        "azure": (OpenAICompatibleProvider, ""), # Placeholder for Azure
    }

    if name in providers:
        cls, default_url = providers[name]
        return cls(api_key, base_url or default_url)
    else:
        return OpenAICompatibleProvider(api_key, base_url or "")
