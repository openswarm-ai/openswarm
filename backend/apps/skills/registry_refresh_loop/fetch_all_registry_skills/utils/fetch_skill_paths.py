
import httpx
from typeguard import typechecked

@typechecked
async def fetch_skill_paths(
        client: httpx.AsyncClient, 
        manifest_url: str
    ) -> list[tuple[str, str]]:

    """Fetch marketplace.json and return (folder, plugin_name) pairs."""
    resp = await client.get(manifest_url)
    resp.raise_for_status()
    manifest = resp.json()
    paths: list[tuple[str, str]] = []
    for plugin in manifest.get("plugins", []):
        plugin_name = plugin.get("name", "")
        for skill_ref in plugin.get("skills", []):
            paths.append((skill_ref.lstrip("./"), plugin_name))
    
    return paths
