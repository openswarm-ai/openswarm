import asyncio
import base64
import hashlib
import json
import logging
import re
import socket
from typing import Callable, Dict, Any, List, Optional
from urllib.parse import urlparse, parse_qs

logger = logging.getLogger(__name__)

class HttpRequest:
    def __init__(self, method: str, path: str, headers: Dict[str, str], query_params: Dict[str, List[str]], body: bytes):
        self.method = method
        self.path = path
        self.headers = headers
        self.query_params = query_params
        self.body = body

    def json(self):
        return json.loads(self.body.decode('utf-8'))

class HttpResponse:
    def __init__(self, status_code: int, headers: Dict[str, str], body: bytes):
        self.status_code = status_code
        self.headers = headers
        self.body = body

class WebSocket:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, headers: Dict[str, str], path: str):
        self.reader = reader
        self.writer = writer
        self.headers = headers
        self.path = path
        self.closed = False
        self.query_params = parse_qs(urlparse(path).query)

    async def accept(self):
        key = self.headers.get('sec-websocket-key')
        if not key:
            raise ValueError("Missing Sec-WebSocket-Key")

        accept_key = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()

        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept_key}\r\n\r\n"
        )
        self.writer.write(response.encode())
        await self.writer.drain()

    async def send_text(self, text: str):
        data = text.encode('utf-8')
        header = bytearray([0x81]) # Final fragment, text frame
        if len(data) <= 125:
            header.append(len(data))
        elif len(data) <= 65535:
            header.append(126)
            header.extend(len(data).to_bytes(2, 'big'))
        else:
            header.append(127)
            header.extend(len(data).to_bytes(8, 'big'))

        self.writer.write(header + data)
        await self.writer.drain()

    async def receive_text(self) -> str:
        # Very basic WS frame parsing (no support for multi-fragment or continuation frames yet)
        header = await self.reader.readexactly(2)
        b1, b2 = header[0], header[1]

        opcode = b1 & 0x0F
        masked = b2 & 0x80
        length = b2 & 0x7F

        if opcode == 0x8: # Close frame
            self.closed = True
            return ""

        if length == 126:
            length_data = await self.reader.readexactly(2)
            length = int.from_bytes(length_data, 'big')
        elif length == 127:
            length_data = await self.reader.readexactly(8)
            length = int.from_bytes(length_data, 'big')

        mask = None
        if masked:
            mask = await self.reader.readexactly(4)

        payload = await self.reader.readexactly(length)
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

        return payload.decode('utf-8')

    async def close(self, code: int = 1000):
        if self.closed: return
        header = bytearray([0x88, 0x02]) # Final fragment, close frame, length 2
        self.writer.write(header + code.to_bytes(2, 'big'))
        await self.writer.drain()
        self.writer.close()
        self.closed = True

class BuiltinServer:
    def __init__(self, host: str = '127.0.0.1', port: int = 8324):
        self.host = host
        self.port = port
        self.routes: Dict[str, Dict[str, Callable]] = {} # method -> path -> handler
        self.ws_routes: Dict[str, Callable] = {} # pattern -> handler
        self.middlewares: List[Callable] = []

    def add_route(self, method: str, path: str, handler: Callable):
        if method not in self.routes:
            self.routes[method] = {}
        self.routes[method][path] = handler

    def add_ws_route(self, pattern: str, handler: Callable):
        self.ws_routes[pattern] = handler

    def add_middleware(self, middleware: Callable):
        self.middlewares.append(middleware)

    async def handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            request_line = await reader.readline()
            if not request_line:
                writer.close()
                return

            method, full_path, _ = request_line.decode().split()
            parsed_url = urlparse(full_path)
            path = parsed_url.path
            query_params = parse_qs(parsed_url.query)

            headers = {}
            while True:
                line = await reader.readline()
                if line == b'\r\n' or not line:
                    break
                k, v = line.decode().split(':', 1)
                headers[k.lower().strip()] = v.strip()

            if headers.get('upgrade') == 'websocket':
                # Handle WebSocket
                handler = None
                for pattern, h in self.ws_routes.items():
                    if re.match(pattern, path):
                        handler = h
                        break

                if handler:
                    ws = WebSocket(reader, writer, headers, full_path)
                    await handler(ws)
                else:
                    writer.write(b"HTTP/1.1 404 Not Found\r\n\r\n")
                    await writer.drain()
                    writer.close()
                return

            # Handle HTTP
            content_length = int(headers.get('content-length', 0))
            body = await reader.readexactly(content_length) if content_length > 0 else b''

            request = HttpRequest(method, path, headers, query_params, body)

            # Apply middlewares (simplified)
            for mw in self.middlewares:
                # Middleware can return a response to short-circuit
                resp = await mw(request)
                if resp:
                    await self.send_response(writer, resp)
                    return

            handler = self.routes.get(method, {}).get(path)
            if not handler:
                # Try regex matching for path parameters if needed, but for now exact match
                response = HttpResponse(404, {"Content-Type": "application/json"}, json.dumps({"error": "Not Found"}).encode())
            else:
                try:
                    response = await handler(request)
                except Exception as e:
                    logger.exception("Error in handler")
                    response = HttpResponse(500, {"Content-Type": "application/json"}, json.dumps({"error": str(e)}).encode())

            await self.send_response(writer, response)

        except Exception:
            logger.exception("Error handling client")
        finally:
            if not writer.is_closing():
                writer.close()

    async def send_response(self, writer: asyncio.StreamWriter, response: HttpResponse):
        status_text = {200: "OK", 401: "Unauthorized", 404: "Not Found", 500: "Internal Server Error"}.get(response.status_code, "Unknown")
        writer.write(f"HTTP/1.1 {response.status_code} {status_text}\r\n".encode())
        for k, v in response.headers.items():
            writer.write(f"{k}: {v}\r\n".encode())
        writer.write(f"Content-Length: {len(response.body)}\r\n".encode())
        writer.write(b"\r\n")
        writer.write(response.body)
        await writer.drain()

    async def start(self):
        server = await asyncio.start_server(self.handle_client, self.host, self.port)
        async with server:
            await server.serve_forever()

if __name__ == "__main__":
    # Test server
    async def hello(req):
        return HttpResponse(200, {"Content-Type": "text/plain"}, b"Hello World")

    server = BuiltinServer(port=8325)
    server.add_route("GET", "/", hello)
    asyncio.run(server.start())
