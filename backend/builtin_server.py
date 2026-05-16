import asyncio
import base64
import hashlib
import json
import logging
import re
import socket
import struct
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
        await self._send_frame(0x1, text.encode('utf-8'))

    async def _send_frame(self, opcode: int, data: bytes):
        header = bytearray([0x80 | opcode])
        if len(data) <= 125:
            header.append(len(data))
        elif len(data) <= 65535:
            header.append(126)
            header.extend(struct.pack("!H", len(data)))
        else:
            header.append(127)
            header.extend(struct.pack("!Q", len(data)))

        self.writer.write(header + data)
        await self.writer.drain()

    async def receive_text(self) -> str:
        try:
            while True:
                opcode, payload = await self._read_frame()
                if opcode == 0x8: # Close
                    self.closed = True
                    return ""
                if opcode == 0x1: # Text
                    return payload.decode('utf-8')
                if opcode == 0x9: # Ping
                    await self._send_frame(0xA, payload) # Pong
                # Ignore others for now
        except Exception as e:
            logger.error(f"WS receive error: {e}")
            self.closed = True
            return ""

    async def _read_frame(self) -> tuple[int, bytes]:
        header = await self.reader.readexactly(2)
        b1, b2 = header[0], header[1]

        fin = b1 & 0x80
        opcode = b1 & 0x0F
        masked = b2 & 0x80
        length = b2 & 0x7F

        if length == 126:
            length_data = await self.reader.readexactly(2)
            length = struct.unpack("!H", length_data)[0]
        elif length == 127:
            length_data = await self.reader.readexactly(8)
            length = struct.unpack("!Q", length_data)[0]

        mask = None
        if masked:
            mask = await self.reader.readexactly(4)

        payload = await self.reader.readexactly(length)
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

        return opcode, payload

    async def close(self, code: int = 1000):
        if self.closed: return
        try:
            await self._send_frame(0x8, struct.pack("!H", code))
        except:
            pass
        self.writer.close()
        self.closed = True

class BuiltinServer:
    def __init__(self, host: str = '127.0.0.1', port: int = 8324):
        self.host = host
        self.port = port
        self.routes: Dict[str, Dict[str, Callable]] = {}
        self.ws_routes: Dict[str, Callable] = {}
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
                return

            parts = request_line.decode().split()
            if len(parts) < 2: return
            method, full_path = parts[0], parts[1]

            parsed_url = urlparse(full_path)
            path = parsed_url.path
            query_params = parse_qs(parsed_url.query)

            headers = {}
            while True:
                line = await reader.readline()
                if line == b'\r\n' or not line:
                    break
                if b':' in line:
                    k, v = line.decode().split(':', 1)
                    headers[k.lower().strip()] = v.strip()

            if headers.get('upgrade', '').lower() == 'websocket':
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
                return

            # Handle Chunked or Normal body
            body = b''
            if headers.get('transfer-encoding', '').lower() == 'chunked':
                while True:
                    line = await reader.readline()
                    size = int(line.strip(), 16)
                    if size == 0:
                        await reader.readline() # blank line
                        break
                    chunk = await reader.readexactly(size)
                    body += chunk
                    await reader.readline() # blank line
            else:
                content_length = int(headers.get('content-length', 0))
                body = await reader.readexactly(content_length) if content_length > 0 else b''

            request = HttpRequest(method, path, headers, query_params, body)

            for mw in self.middlewares:
                resp = await mw(request)
                if resp:
                    await self.send_response(writer, resp)
                    return

            handler = self.routes.get(method, {}).get(path)
            if not handler:
                response = HttpResponse(404, {"Content-Type": "application/json"}, json.dumps({"error": "Not Found"}).encode())
            else:
                try:
                    response = await handler(request)
                except Exception as e:
                    logger.exception("Error in handler")
                    response = HttpResponse(500, {"Content-Type": "application/json"}, json.dumps({"error": str(e)}).encode())

            await self.send_response(writer, response)

        except asyncio.IncompleteReadError:
            pass
        except Exception:
            logger.exception("Error handling client")
        finally:
            if not writer.is_closing():
                writer.close()

    async def send_response(self, writer: asyncio.StreamWriter, response: HttpResponse):
        status_text = {
            200: "OK", 201: "Created", 204: "No Content",
            400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
            404: "Not Found", 500: "Internal Server Error"
        }.get(response.status_code, "Unknown")

        header_lines = [f"HTTP/1.1 {response.status_code} {status_text}"]
        for k, v in response.headers.items():
            header_lines.append(f"{k}: {v}")
        header_lines.append(f"Content-Length: {len(response.body)}")
        header_lines.append("\r\n")

        writer.write("\r\n".join(header_lines).encode() + response.body)
        await writer.drain()

    async def start(self):
        server = await asyncio.start_server(self.handle_client, self.host, self.port)
        async with server:
            await server.serve_forever()

if __name__ == "__main__":
    async def hello(req):
        return HttpResponse(200, {"Content-Type": "text/plain"}, b"Hello World")
    server = BuiltinServer(port=8325)
    server.add_route("GET", "/", hello)
    asyncio.run(server.start())
