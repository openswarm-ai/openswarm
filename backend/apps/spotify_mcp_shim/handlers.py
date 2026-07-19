from typing import Optional, Any, Dict
import asyncio
import json
import urllib.request
import os

# Bypass the OpenSwarm proxy for local Chrome CDP connections
os.environ["no_proxy"] = "*"


import subprocess
import time

def p_ensure_chrome_cdp():
    """Ensure Chrome is running with CDP on port 9223.
    If not, we launch a dedicated profile so we don't conflict with the user's main Chrome,
    and we leave it running in the background so music keeps playing after the script exits!
    """
    try:
        req = urllib.request.Request("http://127.0.0.1:9223/json/version")
        with urllib.request.urlopen(req, timeout=0.5) as response:
            if response.status == 200:
                return True
    except Exception:
        pass

    # CDP not responding. Let's auto-launch a dedicated Chrome instance!
    profile_dir = os.path.expanduser("~/.openswarm/spotify_chrome_profile")
    os.makedirs(profile_dir, exist_ok=True)
    
    subprocess.Popen([
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
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

async def play_track(track_name: str, artist: Optional[str]) -> Dict[str, Any]:
    """
    Using the Playwright MCP, we'll:

    1. Auto-launch a dedicated Chrome instance (with CDP) if it's not already running.
    2. Navigate to Spotify. If this is the user's first time on this dedicated profile, they will need to log in.
    3. Search for the song name.
    4. Play the song!
    """

    if not p_ensure_chrome_cdp():
        return {
            "is_error": True,
            "is_human_intervention": False,
            "message": "Failed to auto-start Chrome with remote debugging on port 9223."
        }

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
            browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9223")
            context = browser.contexts[0]
            
            page = None
            for p_obj in context.pages:
                if "spotify.com" in p_obj.url:
                    page = p_obj
                    break
            
            if not page:
                page = await context.new_page()
            
            query = track_name
            if artist:
                query += f" {artist}"
                
            search_url = f"https://open.spotify.com/search/{urllib.parse.quote(query)}"
            await page.goto(search_url)
            await page.wait_for_load_state("networkidle")
            await asyncio.sleep(4) # Give elements time to render
            
            prompt = f"""
I want to play the track '{query}' on Spotify. Look at this screenshot of the Spotify web UI.
Determine the state and return ONLY a valid JSON object. Do not include markdown formatting or backticks, just the raw JSON.
You must choose one of the following exact JSON structures:

1. If a login prompt or overlay is blocking the UI:
{{
"action": "human_intervention",
"message": "User needs to log in"
}}

2. If the track '{query}' is already playing (a pause button is visible, or the now-playing bar at the bottom shows the track playing):
{{
"action": "done",
"message": "Successfully started playback"
}}

3. Otherwise, find the Play button for the top search result and return its exact center coordinates as percentages (0 to 100) of the image width and height:
{{
"action": "click",
"x_percent": 50.5,
"y_percent": 25.0,
"message": "Clicking play button"
}}

CRITICAL: Return strictly valid JSON. Double check your quotes and commas.
""".strip()

            for attempt in range(4):
                if attempt > 0:
                    # Wait a bit longer between clicks/checks to let the stream start
                    await asyncio.sleep(4)
                    
                screenshot_bytes = await page.screenshot()
                
                img = Image.open(BytesIO(screenshot_bytes))
                max_width = 1024
                if img.width > max_width:
                    ratio = max_width / img.width
                    img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
                buf = BytesIO()
                img.convert("RGB").save(buf, format="JPEG", quality=45)
                b64_img = base64.b64encode(buf.getvalue()).decode("utf-8")
                
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
                    
                    if action_data["action"] == "human_intervention":
                        return {
                            "is_error": False,
                            "is_human_intervention": True,
                            "message": action_data.get("message", "Human intervention needed.")
                        }
                    elif action_data["action"] == "done":
                        return {
                            "is_error": False,
                            "is_human_intervention": False,
                            "message": action_data.get("message", "Task completed.")
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
                            
                        await page.mouse.click(click_x, click_y)
                        # sleep is now handled at the start of the next loop iteration
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
                "message": "AI failed to start playback after multiple attempts."
            }
            
    except Exception as e:
        import traceback
        return {
            "is_error": True,
            "is_human_intervention": False,
            "message": f"An error occurred: {str(e)}\n\nTraceback:\n{traceback.format_exc()}"
        }