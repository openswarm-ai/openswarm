from typing import Optional, Any, Dict
import json
import os

def set_default_engine(engine: str) -> Dict[str, Any]:
    config_path = os.path.expanduser("~/.openswarm/spotify_engine.json")
    os.makedirs(os.path.dirname(config_path), exist_ok=True)
    with open(config_path, "w") as f:
        json.dump({"engine": engine}, f)
    return {"message": f"Successfully set default engine to {engine}"}

def get_default_engine() -> str:
    config_path = os.path.expanduser("~/.openswarm/spotify_engine.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                return json.load(f).get("engine", "safari_applescript")
        except:
            pass
    return "safari_applescript"

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

_playwright_mgr = None
_playwright = None
_webkit_context = None

async def get_playwright():
    global _playwright_mgr, _playwright
    if _playwright is None:
        from playwright.async_api import async_playwright
        _playwright_mgr = async_playwright()
        _playwright = await _playwright_mgr.start()
    return _playwright

async def get_browser_page(target_url_substring: Optional[str] = None, engine: Optional[str] = None):
    """
    Connects to the CDP browser (Chromium) or persistent context (WebKit) and returns a (browser, context, page) tuple.
    If target_url_substring is provided, it will try to find and return an existing tab
    that matches the substring. Otherwise, it will open a new tab.
    """
    p = await get_playwright()
    
    if engine == "webkit":
        global _webkit_context
        if _webkit_context is None:
            profile_dir = os.path.expanduser("~/.openswarm/spotify_webkit_profile")
            os.makedirs(profile_dir, exist_ok=True)
            _webkit_context = await p.webkit.launch_persistent_context(
                user_data_dir=profile_dir,
                headless=False
            )
            
        page = None
        if target_url_substring:
            for p_obj in _webkit_context.pages:
                if target_url_substring in p_obj.url:
                    page = p_obj
                    break
                    
        if not page:
            if len(_webkit_context.pages) == 1 and _webkit_context.pages[0].url == "about:blank":
                page = _webkit_context.pages[0]
            else:
                page = await _webkit_context.new_page()
            
        return None, _webkit_context, page
        
    else:
        if not ensure_browser_cdp():
            raise RuntimeError("Failed to auto-start Chromium browser with remote debugging on port 9223.")
            
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9223")
        context = browser.contexts[0]
        
        page = None
        if target_url_substring:
            for p_obj in context.pages:
                if target_url_substring in p_obj.url:
                    page = p_obj
                    break
                    
        if not page:
            if len(context.pages) == 1 and context.pages[0].url == "about:blank":
                page = context.pages[0]
            else:
                page = await context.new_page()
            
        return browser, context, page

async def play_media(query: str, media_type: str, engine: Optional[str] = None) -> Dict[str, Any]:
    """
    Shared helper for play_track, play_album, and play_playlist.
    """
    if not engine:
        engine = get_default_engine()

    import urllib.parse
    import asyncio
    import subprocess
    import json
    
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
            "message": f"Could not load AI client: {e}"
        }
    
    if engine == "safari_applescript":
        search_url = f"https://open.spotify.com/search/{urllib.parse.quote(query, safe='')}"
        
        # JS extraction script for Set-of-Mark
        js_payload = f'''
        (function() {{
            let container = document.querySelector('.main-view-container') || document.querySelector('main') || document.body;
            let interactables = container.querySelectorAll('button, a');
            
            if (interactables.length === 0) {{
                return JSON.stringify({{action: "wait"}});
            }}
            
            let elements = [];
            let metadata = {{}};
            let counter = 1;
            
            for (let i = 0; i < interactables.length; i++) {{
                let el = interactables[i];
                if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
                
                let id = counter++;
                
                let ariaLabel = el.getAttribute('aria-label') || '';
                let testId = el.getAttribute('data-testid') || '';
                let text = el.innerText.substring(0, 50).trim().replace(/\n/g, ' ');
                let tagName = el.tagName.toLowerCase();
                
                let tagStr = `<${{tagName}} id="${{id}}"`;
                if (ariaLabel) tagStr += ` aria-label="${{ariaLabel}}"`;
                if (testId) tagStr += ` data-testid="${{testId}}"`;
                tagStr += `>${{text}}</${{tagName}}>`;
                
                elements.push(tagStr);
                metadata[id] = {{tagName: tagName, testId: testId, ariaLabel: ariaLabel, text: text}};
            }}
            
            return JSON.stringify({{action: "dom_extracted", html: elements.join('\n'), meta: metadata}});
        }})()
        '''
        
        apple_script_nav = f'''
        tell application "Safari"
            activate
            if (count of windows) = 0 then
                make new document with properties {{URL:"{search_url}"}}
            else
                set foundTab to false
                repeat with w in windows
                    repeat with t in tabs of w
                        if URL of t contains "spotify.com" then
                            set current tab of w to t
                            set index of w to 1
                            set URL of t to "{search_url}"
                            set foundTab to true
                            exit repeat
                        end if
                    end repeat
                    if foundTab then exit repeat
                end repeat
                
                if not foundTab then
                    tell window 1
                        make new tab with properties {{URL:"{search_url}"}}
                        set current tab to result
                    end tell
                end if
            end if
            delay 3
        end tell
        '''
        
        try:
            # Step 1: Navigate to page
            res_nav = subprocess.run(["osascript", "-e", apple_script_nav], capture_output=True, text=True)
            if res_nav.returncode != 0 and "-29004" in res_nav.stderr:
                return {
                    "is_error": False,
                    "is_human_intervention": True,
                    "message": "To allow me to play music for you, I need permission to interact with Safari.\n\n1. Open Safari and press `Command-,` (or go to **Safari > Settings > Advanced**).\n2. Check the box at the bottom for **Show features for web developers**.\n3. In the menu bar at the top of your screen, click **Develop > Allow JavaScript from Apple Events**.\n\n(You might see a scary Apple warning about malicious programs. Don't worry, this is just a standard warning because you are giving an AI permission to click buttons on web pages on your behalf!)\n\nIf you'd prefer not to do this, you can just ask me to use **Google Chrome** instead!"
                }
                
            action_history = []
            success = False
            
            # Action loop (extract DOM -> AI -> click -> repeat)
            for attempt in range(4):
                apple_script_extract = f'''
                tell application "Safari"
                    set jsStr to "{js_payload.replace('"', '\\"').replace('\n', ' ')}"
                    set resultJSON to do JavaScript jsStr in current tab of front window
                    return resultJSON
                end tell
                '''
                res_extract = subprocess.run(["osascript", "-e", apple_script_extract], capture_output=True, text=True)
                if res_extract.returncode != 0:
                    break
                    
                out = res_extract.stdout.strip()
                try:
                    payload = json.loads(out)
                except:
                    continue
                    
                if payload.get("action") == "human_intervention":
                    return {
                        "is_error": False,
                        "is_human_intervention": True,
                        "message": "User needs to log in to Spotify in Safari."
                    }
                elif payload.get("action") == "wait":
                    await asyncio.sleep(2)
                    continue
                    
                dom_snippet = payload.get("html", "")
                if not dom_snippet:
                    await asyncio.sleep(2)
                    continue
                    
                dom_meta = payload.get("meta", {})
                
                # Send to AI
                prompt = f"""
I want to play the {media_type} '{query}' on Spotify. Look at this extracted HTML of interactive elements from the screen.
Determine the state and return ONLY a valid JSON object. Do not include markdown formatting or backticks, just the raw JSON.

If you see a login/signup modal popup overlaying the content, a "Log in to Spotify" wall, or a large "Sign up free" button, you MUST return:
{{
"action": "human_intervention",
"message": "User needs to log in"
}}

Otherwise, if the {media_type} is not currently playing, you must start it.
- Find the best match for '{query}' that is explicitly labeled as a {media_type} (or similar).
- If the best match has a Play button, return its ID.
- If the best match does NOT have a visible Play button (e.g. it is a list item), return the ID of its text title link to click on it. This will navigate to its dedicated page where a Play button will be visible on the next step.
- If you are ALREADY on a dedicated media page, return the ID of the main Play button on the page.

Return this JSON if clicking is required:
{{
"action": "click",
"id": "<the_integer_id>"
}}

HTML SNIPPET:
{dom_snippet}
"""
                response = await client.messages.create(
                    model=model_id,
                    max_tokens=300,
                    system="You are an autonomous browser automation agent. Return ONLY raw JSON without backticks.",
                    messages=[
                        {
                            "role": "user",
                            "content": [{"type": "text", "text": prompt}]
                        }
                    ]
                )
                
                try:
                    content = response.content[0].text.strip()
                    if content.startswith("```json"):
                        content = content[7:]
                    if content.startswith("```"):
                        content = content[3:]
                    if content.endswith("```"):
                        content = content[:-3]
                        
                    action_data = json.loads(content)
                    action_history.append(action_data)
                    
                    if action_data["action"] == "human_intervention":
                        return {
                            "is_error": False,
                            "is_human_intervention": True,
                            "message": action_data.get("message", "Human intervention needed.")
                        }
                    elif action_data["action"] == "click":
                        target_id = str(action_data["id"])
                        meta = dom_meta.get(target_id, {})
                        
                        t_id = meta.get("testId", "")
                        a_lbl = meta.get("ariaLabel", "").replace("'", "\'")
                        tag = meta.get("tagName", "button")
                        
                        js_click = f"""
                        let el = null;
                        let t = '{t_id}';
                        let a = '{a_lbl}';
                        let tag = '{tag}';
                        
                        let query = tag;
                        if (t) query += `[data-testid="${{t}}"]`;
                        if (a) query += `[aria-label="${{a}}"]`;
                        
                        if (query !== tag) {{
                            el = document.querySelector('.main-view-container ' + query) || document.querySelector(query);
                        }}
                        
                        if (!el) {{
                            let container = document.querySelector('.main-view-container') || document.querySelector('main') || document.body;
                            let interactables = container.querySelectorAll('button, a');
                            let interactablesArray = [];
                            for (let i = 0; i < interactables.length; i++) {{
                                if (interactables[i].offsetWidth > 0 && interactables[i].offsetHeight > 0) {{
                                    interactablesArray.push(interactables[i]);
                                }}
                            }}
                            let idx = parseInt('{target_id}') - 1;
                            if (idx >= 0 && idx < interactablesArray.length) {{
                                el = interactablesArray[idx];
                            }}
                        }}
                        
                        if (el) {{
                            el.dispatchEvent(new PointerEvent('pointerdown', {{bubbles: true}}));
                            el.dispatchEvent(new MouseEvent('mousedown', {{bubbles: true}}));
                            el.dispatchEvent(new PointerEvent('pointerup', {{bubbles: true}}));
                            el.dispatchEvent(new MouseEvent('mouseup', {{bubbles: true}}));
                            el.click();
                        }}
                        """
                        click_script = f'''
                        tell application "Safari"
                            do JavaScript "{js_click.replace('"', '\\"').replace('\n', ' ')}" in current tab of front window
                        end tell
                        '''
                        subprocess.run(["osascript", "-e", click_script], capture_output=True, text=True)
                        
                        # Verification
                        for _ in range(10): # 5 seconds
                            state_script = '''
                            tell application "Safari"
                                do JavaScript "navigator.mediaSession.playbackState" in current tab of front window
                            end tell
                            '''
                            res_state = subprocess.run(["osascript", "-e", state_script], capture_output=True, text=True)
                            if res_state.returncode == 0 and "playing" in res_state.stdout:
                                success = True
                                break
                            await asyncio.sleep(0.5)
                            
                        if success:
                            return {
                                "is_error": False,
                                "is_human_intervention": False,
                                "message": "Task completed. Safari playback verified programmatically via DOM interpretation."
                            }
                except Exception as e:
                    pass # Continue loop if AI failed to parse
                    
                await asyncio.sleep(2)
                
            return {
                "is_error": True,
                "is_human_intervention": False,
                "message": f"AI failed to start playback in Safari after multiple attempts.\nAction history:\n{json.dumps(action_history, indent=2)}"
            }
            
        except Exception as e:
            return {
                "is_error": True,
                "is_human_intervention": False,
                "message": f"Error executing Safari workflow: {e}"
            }

    # --- CHROMIUM LOGIC ---
    from playwright.async_api import async_playwright
    import base64
    from io import BytesIO
    from PIL import Image
    
    try:
        try:
            browser, context, page = await get_browser_page(target_url_substring="spotify.com", engine=engine)
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

1. If you see a login/signup modal popup overlaying the content, a "Log in to Spotify" wall, or a large "Sign up free" button, the main UI is not visible because you need to log in. You MUST return:
{{
"action": "human_intervention",
"message": "User needs to log in"
}}

3. Otherwise, if the {media_type} is not currently playing, you must start it.
- Look at the screen. If you are currently on a search results page, find the best match for '{query}' that is explicitly labeled as a {media_type} (e.g. look for the subtitle 'Album', 'Playlist', 'Song', or 'Artist').
  - If the best match has a prominent green Play button (e.g., the Top Result card), return its coordinates.
  - If the best match does NOT have a visible Play button (e.g., it is a row in a list), return the coordinates of its text title to click on it. This will navigate to its dedicated page where a Play button will be visible on the next step.
- If you are ALREADY on a dedicated media page (e.g., you already clicked a title in a previous step), return the coordinates of the main green Play button on the page.

Return this JSON if clicking is required:
{{
"action": "click",
"x_percent": <x_coordinate_percentage_from_0_to_100>,
"y_percent": <y_coordinate_percentage_from_0_to_100>
}}
"""
            
            response = await client.messages.create(
                model=model_id,
                max_tokens=300,
                system="You are an autonomous browser automation agent. Return ONLY raw JSON without backticks.",
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64_img}}
                        ]
                    }
                ]
            )
            
            try:
                content = response.content[0].text.strip()
                if content.startswith("```json"):
                    content = content[7:]
                if content.startswith("```"):
                    content = content[3:]
                if content.endswith("```"):
                    content = content[:-3]
                    
                action_data = json.loads(content)
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
                    
                    if "x_percent" in action_data and "y_percent" in action_data:
                        x_pct = float(action_data["x_percent"])
                        y_pct = float(action_data["y_percent"])
                        if x_pct > 100: x_pct = (x_pct / img.width) * 100
                        if y_pct > 100: y_pct = (y_pct / img.height) * 100
                        
                        click_x = (x_pct / 100.0) * vp_w
                        click_y = (y_pct / 100.0) * vp_h
                    else:
                        click_x = float(action_data["x"]) * (vp_w / img.width)
                        click_y = float(action_data["y"]) * (vp_h / img.height)
                        
                    await page.mouse.click(click_x, click_y, delay=100)
                    
                    success = False
                    for _ in range(10): # 5 seconds
                        try:
                            pause_btn = await page.query_selector('button[data-testid="control-button-pause"], button[aria-label^="Pause"]')
                            if pause_btn:
                                success = True
                                break
                            
                            # Use the official MediaSession API to check if the browser is actually playing media
                            # This ignores silent Canvas animations and background videos natively!
                            playback_state = await page.evaluate("() => navigator.mediaSession.playbackState")
                            if playback_state == "playing":
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

async def play_track(track_name: str, artist: Optional[str] = None, engine: Optional[str] = None) -> Dict[str, Any]:
    query = track_name
    if artist:
        query += f" {artist}"
    return await play_media(query, "track", engine=engine)

async def play_album(album_name: str, artist: Optional[str] = None, engine: Optional[str] = None) -> Dict[str, Any]:
    query = album_name
    if artist:
        query += f" {artist}"
    return await play_media(query, "album", engine=engine)

async def play_playlist(playlist_name: str, engine: Optional[str] = None) -> Dict[str, Any]:
    query = playlist_name
    return await play_media(query, "playlist", engine=engine)

async def play_artist(artist_name: str, engine: Optional[str] = None) -> Dict[str, Any]:
    query = artist_name
    return await play_media(query, "artist", engine=engine)