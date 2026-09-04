"""A connector's auth state change reaches every open window as `tools:updated`, and the connected
page names the tool it connected. The Tools page used to read the status once when the OAuth popup
closed, usually before the claim had landed, then never again until an app reload (Haik, 2026-09-03);
its postMessage listener compared tool ids against a message that carried none."""

import inspect

from backend.apps.tools_lib import tools_lib


def test_the_connected_page_names_its_tool_and_a_hostile_id_is_stripped():
    body = tools_lib.p_connected_html("google-workspace").body.decode()
    assert "tool_id: 'google-workspace'" in body
    hostile = tools_lib.p_connected_html("x'});alert(1);//").body.decode()
    assert "alert(" not in hostile and "'});" not in hostile and "tool_id: 'xalert1'" in hostile


def test_the_claim_and_the_disconnect_broadcast_after_saving():
    claim = inspect.getsource(tools_lib.oauth_cloud_claim)
    assert claim.index("save(tool)") < claim.index("await p_broadcast_tool_updated(tool)") < claim.index("return p_connected_html(tool.id)")
    disconnect = inspect.getsource(tools_lib.oauth_disconnect)
    assert disconnect.index("save(tool)") < disconnect.index("await p_broadcast_tool_updated(tool)")
    assert '"tools:updated"' in inspect.getsource(tools_lib.p_broadcast_tool_updated)
