import urllib.request
import urllib.parse
import json
import ssl
from typing import Dict, Any, Optional

def http_request(url: str, method: str = 'GET', headers: Optional[Dict[str, str]] = None, body: Any = None, timeout: int = 30) -> Dict[str, Any]:
    if headers is None:
        headers = {}

    if body is not None and not isinstance(body, bytes):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode('utf-8')
            headers.setdefault('Content-Type', 'application/json')
        else:
            body = str(body).encode('utf-8')

    req = urllib.request.Request(url, data=body, headers=headers, method=method)

    # Create unverified context if needed, but better to use default
    context = ssl.create_default_context()

    try:
        with urllib.request.urlopen(req, timeout=timeout, context=context) as response:
            resp_body = response.read()
            resp_headers = dict(response.info())
            status = response.getcode()

            try:
                content = json.loads(resp_body.decode('utf-8'))
            except:
                content = resp_body.decode('utf-8', errors='ignore')

            return {
                "status": status,
                "headers": resp_headers,
                "body": content
            }
    except urllib.error.HTTPError as e:
        resp_body = e.read()
        try:
            content = json.loads(resp_body.decode('utf-8'))
        except:
            content = resp_body.decode('utf-8', errors='ignore')
        return {
            "status": e.code,
            "headers": dict(e.headers),
            "body": content,
            "error": str(e)
        }
    except Exception as e:
        return {
            "status": 0,
            "headers": {},
            "body": None,
            "error": str(e)
        }

if __name__ == "__main__":
    # Test
    res = http_request("https://httpbin.org/get")
    print(json.dumps(res, indent=2))
