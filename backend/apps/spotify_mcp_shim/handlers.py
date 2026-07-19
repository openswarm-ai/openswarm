from typing import Optional, Any, Dict
import json
import urllib.request
import asyncio
import os

# Bypass the OpenSwarm proxy for local Chrome CDP connections
os.environ["no_proxy"] = "*"


import subprocess
import time

def get_browser_executable() -> str:
    """Returns the path to a browser that is both CDP and Spotify compatibile."""
    browsers = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Opera.app/Contents/MacOS/Opera",
        "/Applications/Opera GX.app/Contents/MacOS/Opera GX",
    ]
    for b in browsers:
        if os.path.exists(b):
            return b
    raise FileNotFoundError("No CDP-compatible browser found (Chrome, Edge, Opera).")

def ensure_browser_cdp() -> bool:
    """Ensure a CDP-compatible browser is running with CDP on port 9223.
    If not, we launch a dedicated profile so we don't conflict with the user's main browser,
    and we leave it running in the background.
    """
    try:
        req = urllib.request.Request("http://127.0.0.1:9223/json/version")
        with urllib.request.urlopen(req, timeout=0.5) as response:
            if response.status == 200:
                return True
    except Exception:
        pass

    # CDP not responding. Let's auto-launch a dedicated profile!
    try:
        executable = get_browser_executable()
    except FileNotFoundError as e:
        print(f"Error: {e}")
        return False

    profile_dir = os.path.expanduser("~/.openswarm/spotify_chrome_profile")
    os.makedirs(profile_dir, exist_ok=True)
    
    subprocess.Popen([
        executable,
        "--remote-debugging-port=9223",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--restore-last-session",
        "--password-store=basic"
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    # Wait for it to spin up
    for _ in range(10):
        time.sleep(0.5)
        try:
            req = urllib.request.Request("http://127.0.0.1:9223/json/version")
            with urllib.request.urlopen(req, timeout=0.5) as response:
                if response.status == 200:
                    return True
        except Exception:
            continue
            
    return False

async def get_browser_page(p, target_url_substring: Optional[str] = None):
    """
    Connects to the CDP browser and returns a (browser, context, page) tuple.
    If target_url_substring is provided, it will try to find and return an existing tab
    that matches the substring. Otherwise, it will open a new tab.
    """
    if not ensure_browser_cdp():
        raise RuntimeError("Failed to auto-start browser with remote debugging on port 9223.")
        
    browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9223")
    context = browser.contexts[0]
    
    page = None
    if target_url_substring:
        for p_obj in context.pages:
            if target_url_substring in p_obj.url:
                page = p_obj
                break
                
    if not page:
        page = await context.new_page()
        
    return browser, context, page

async def play_media(query: str, media_type: str) -> Dict[str, Any]:
    """
    Shared helper for play_track, play_album, and play_playlist.
    """

    from playwright.async_api import async_playwright
    import urllib.parse
    import base64
    from io import BytesIO
    from PIL import Image
    
    from backend.apps.settings.settings import load_settings
    from backend.apps.settings.credentials import get_anthropic_client_for_model
    from backend.apps.agents.providers.registry import resolve_aux_model
    
    settings = load_settings()
    try:
        model_id, _ = await resolve_aux_model(settings, preferred_tier="haiku")
        client = get_anthropic_client_for_model(settings, model_id)
    except Exception as e:
        return {
            "is_error": True,
            "is_human_intervention": False,
            "message": f"Could not load AI client for screenshot analysis: {e}"
        }
    
    try:
        async with async_playwright() as p:
            try:
                browser, context, page = await get_browser_page(p, target_url_substring="spotify.com")
            except RuntimeError as e:
                return {
                    "is_error": True,
                    "is_human_intervention": False,
                    "message": str(e)
                }
                
            search_url = f"https://open.spotify.com/search/{urllib.parse.quote(query, safe='')}"
            await page.goto(search_url)
            
            try:
                await page.wait_for_load_state("networkidle", timeout=2000)
            except Exception:
                pass
                
            try:
                # Scientifically wait for the play buttons OR the login button to render in the DOM
                await page.wait_for_selector('button[data-testid="play-button"], [data-testid="login-button"]', timeout=4000)
            except Exception:
                pass
            
            action_history = []
            for attempt in range(4):
                screenshot_bytes = await page.screenshot()
                
                img = Image.open(BytesIO(screenshot_bytes))
                max_width = 1024
                if img.width > max_width:
                    ratio = max_width / img.width
                    img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
                buf = BytesIO()
                img.convert("RGB").save(buf, format="JPEG", quality=45)
                b64_img = base64.b64encode(buf.getvalue()).decode("utf-8")
                
                prompt = f"""
I want to play the {media_type} '{query}' on Spotify. Look at this screenshot of the Spotify web UI.
Determine the state and return ONLY a valid JSON object. Do not include markdown formatting or backticks, just the raw JSON.
You must choose one of the following exact JSON structures:

1. If a login prompt or overlay is blocking the UI:
{{
"action": "human_intervention",
"message": "User needs to log in"
}}

3. Otherwise, if the {media_type} is not currently playing, you must start it.
- Look at the screen. If you are currently on a search results page, find the best match for '{query}' that is explicitly labeled as a {media_type} (e.g. look for the subtitle 'Album', 'Playlist', 'Song', or 'Artist').
  - If the best match has a prominent green Play button (e.g., the Top Result card), return its coordinates.
  - If the best match does NOT have a visible Play button (e.g., it is a row in a list), return the coordinates of its text title to click on it. This will navigate to its dedicated page where a Play button will be visible on the next step.
- If you are ALREADY on a dedicated media page (e.g., you already clicked a title in a previous step), return the coordinates of the main green Play button on the page.
{{
"action": "click",
"x_percent": 50.5,
"y_percent": 25.0,
"message": "Clicking play button (or title to navigate)"
}}

CRITICAL: Return strictly valid JSON. Double check your quotes and commas.
""".strip()
                
                response = await client.messages.create(
                    model=model_id,
                    max_tokens=256,
                    messages=[{
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64_img}}
                        ]
                    }]
                )
                
                try:
                    # Parse JSON from response safely, handling both Anthropic and OpenAI wrapper formats
                    resp_text = ""
                    if getattr(response, "content", None):
                        content_block = response.content[0]
                        resp_text = getattr(content_block, "text", str(content_block)).strip()
                    else:
                        choices = getattr(response, "choices", None)
                        if not choices and hasattr(response, "model_dump"):
                            choices = response.model_dump().get("choices")
                        if not choices and hasattr(response, "dict"):
                            choices = response.dict().get("choices")
                        if choices and len(choices) > 0:
                            choice = choices[0]
                            if isinstance(choice, dict):
                                msg = choice.get("message", {})
                                if isinstance(msg, dict):
                                    resp_text = msg.get("content", "")
                                else:
                                    resp_text = getattr(msg, "content", "")
                            else:
                                msg = getattr(choice, "message", None)
                                resp_text = getattr(msg, "content", "")
                    
                    if not resp_text:
                        raise ValueError(f"AI returned empty content or unsupported format! Full response: {response}")
                    
                    if resp_text.startswith("```json"):
                        resp_text = resp_text[7:-3].strip()
                    elif resp_text.startswith("```"):
                        resp_text = resp_text[3:-3].strip()
                        
                    action_data = json.loads(resp_text)
                    action_history.append(action_data)
                    
                    if action_data["action"] == "human_intervention":
                        return {
                            "is_error": False,
                            "is_human_intervention": True,
                            "message": action_data.get("message", "Human intervention needed.")
                        }
                    elif action_data["action"] == "click":
                        vp_w = await page.evaluate("window.innerWidth")
                        vp_h = await page.evaluate("window.innerHeight")
                        
                        # Use exact image dimensions to calculate percentages, then map to CSS pixels
                        if "x_percent" in action_data and "y_percent" in action_data:
                            x_pct = float(action_data["x_percent"])
                            y_pct = float(action_data["y_percent"])
                            # If the AI accidentally returned pixels instead of percentages, cap them
                            if x_pct > 100: x_pct = (x_pct / img.width) * 100
                            if y_pct > 100: y_pct = (y_pct / img.height) * 100
                            
                            click_x = (x_pct / 100.0) * vp_w
                            click_y = (y_pct / 100.0) * vp_h
                        else:
                            # Fallback if AI returned raw pixels (x, y)
                            click_x = float(action_data["x"]) * (vp_w / img.width)
                            click_y = float(action_data["y"]) * (vp_h / img.height)
                            
                        await page.mouse.click(click_x, click_y, delay=100)
                        
                        # Deterministically wait for playback to start
                        success = False
                        for _ in range(10): # 5 seconds
                            try:
                                # Check React UI
                                pause_btn = await page.query_selector('button[data-testid="control-button-pause"]')
                                if pause_btn:
                                    success = True
                                    break
                                
                                # Check HTML5 Media
                                is_playing = await page.evaluate("() => Array.from(document.querySelectorAll('audio, video')).some(el => !el.paused && el.duration > 0)")
                                if is_playing:
                                    success = True
                                    break
                            except Exception:
                                pass
                                
                            await asyncio.sleep(0.5)
                            
                        if success:
                            return {
                                "is_error": False,
                                "is_human_intervention": False,
                                "message": "Task completed. Playback verified programmatically."
                            }
                        
                        # If not successful, the loop will just continue to the next attempt!
                except Exception as e:
                    raw_resp = getattr(response, 'content', 'No content attribute')
                    return {
                        "is_error": True,
                        "is_human_intervention": False,
                        "message": f"Failed to parse AI response: {e}\nRaw content was: {raw_resp}"
                    }
                    
            return {
                "is_error": True,
                "is_human_intervention": False,
                "message": f"AI failed to start playback after multiple attempts.\nAction history:\n{json.dumps(action_history, indent=2)}"
            }
            
    except Exception as e:
        import traceback
        return {
            "is_error": True,
            "is_human_intervention": False,
            "message": f"An error occurred: {str(e)}\n\nTraceback:\n{traceback.format_exc()}"
        }

async def play_track(track_name: str, artist: Optional[str] = None) -> Dict[str, Any]:
    query = track_name
    if artist:
        query += f" {artist}"
    return await play_media(query, "track")

async def play_album(album_name: str, artist: Optional[str] = None) -> Dict[str, Any]:
    query = album_name
    if artist:
        query += f" {artist}"
    return await play_media(query, "album")

async def play_playlist(playlist_name: str) -> Dict[str, Any]:
    query = playlist_name
    return await play_media(query, "playlist")

async def play_artist(artist_name: str) -> Dict[str, Any]:
    query = artist_name
    return await play_media(query, "artist")