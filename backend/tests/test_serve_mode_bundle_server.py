"""Serve mode hands a built bundle out from the root of its own loopback server, the same URL shape
vite gives the app. It used to serve index.html at a deep path under the backend's authenticated
serve route, and a React Router app matched no route there and rendered nothing (Haik's users,
2026-09-03: frontend-only apps went white after a reload; apps with a backend never enter serve mode)."""

import os
import urllib.error
import urllib.request

from backend.apps.outputs.static_serve import BundleServer


def p_dist(tmp_path):
    dist = tmp_path / "frontend" / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text('<!doctype html><div id="root"></div><script type="module" src="./assets/app.js"></script>')
    (dist / "assets" / "app.js").write_text("console.log('hi')")
    return str(dist)


def p_get(url: str):
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.status, r.headers.get("content-type", ""), r.read().decode()


def test_the_app_lives_at_the_root_and_its_assets_resolve(tmp_path):
    server = BundleServer(p_dist(tmp_path))
    port = server.start()
    try:
        assert server.url == f"http://127.0.0.1:{port}/"
        status, ctype, body = p_get(server.url + "?_d=e30%3D&token=x")
        assert status == 200 and 'id="root"' in body
        status, ctype, body = p_get(server.url + "assets/app.js")
        assert status == 200 and "javascript" in ctype and "console.log" in body
    finally:
        server.stop()


def test_a_router_path_with_no_file_gets_index_not_a_404(tmp_path):
    server = BundleServer(p_dist(tmp_path))
    server.start()
    try:
        status, _ctype, body = p_get(server.url + "settings/profile")
        assert status == 200 and 'id="root"' in body
        try:
            p_get(server.url + "assets/missing.js")
        except urllib.error.HTTPError as e:
            assert e.code == 404
        else:
            raise AssertionError("a missing asset must 404, not become index.html")
    finally:
        server.stop()


def test_stop_frees_the_port(tmp_path):
    server = BundleServer(p_dist(tmp_path))
    server.start()
    url = server.url
    server.stop()
    try:
        urllib.request.urlopen(url, timeout=2)
    except urllib.error.URLError:
        pass
    else:
        raise AssertionError("the bundle server kept serving after stop()")


def test_the_runtime_owns_the_server_and_every_exit_from_serve_mode_stops_it():
    src = open(os.path.join(os.path.dirname(__file__), "..", "apps", "outputs", "runtime.py")).read()
    assert "self.p_bundle_server = p_server" in src and "self.serve_static = True" in src
    stop_i = src.index("    async def stop(self) -> None:")
    assert "self.p_stop_bundle_server()" in src[stop_i: stop_i + 400], "stop() must drop the server before its no-process early return"
    start_i = src.index("self.serve_static = False\n            self.p_stop_bundle_server()")
    assert start_i > 0, "start() must drop a previous server before re-deciding serve mode"
    assert "/serve/frontend/dist/index.html?token=" not in src, "the deep serve-route URL must not come back"
