"""The release story, in one place, for three surfaces: the in-app What's New card, the GitHub
release body, and the Help agent's context. One source means the agent can never answer from a
stale picture of the app, and a release can never ship with no story."""

from typing import Dict, List

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked


class ReleaseNote(BaseModel):
    model_config = ConfigDict(validate_assignment=True)
    version: str
    headline: str
    # User-facing lines only: what changed for the person using the app, not the diff.
    highlights: List[str]
    fixes: List[str]


P_RELEASES: List[ReleaseNote] = [
    # Only lines that are true of the built app belong here. This one file feeds the in-app card, the
    # GitHub body AND the Help agent's context, so a line written for a planned feature becomes the
    # agent confidently describing something that does not exist.
    ReleaseNote(
        version="1.7.10-exp.3",
        headline="Answers stream smoothly while you scroll, long chats stay alive, and Windows can stop antivirus breaking the app.",
        highlights=[
            "Scrolling a chat no longer stalls the answer being written into it. Reading along used to pause the text and then dump it all at once; it now streams straight through.",
            "Long chats stop filling up. Older tool output is cleared from what gets re-sent on each step while the most recent results stay word for word, so a hundred-step job keeps working instead of hitting the wall.",
            "Windows: a new Antivirus exclusion switch in Settings, then Advanced. If security software keeps removing part of OpenSwarm, this stops it, with Windows asking you to approve the change and turning it off undoing it.",
        ],
        fixes=[
            "A chat that starts while the app's model router is still waking up now recovers on its own instead of failing with an error card after a long run.",
            "Reconnecting a subscription really does restart the router again. A stale health check could report the restart as done while the router stayed down for twenty seconds, and every chat started in that window was set up to fail.",
            "When recovery genuinely runs out of road, the message says the router was restarting and that sending again picks up where you left off, instead of telling you to switch models.",
            "The antivirus message now offers to add the exclusion for you, which is the step people gave up on.",
            "Agents remember their own conclusions across long chats. The summary that carries a chat past a context cleanup now quotes exact names, numbers and decisions instead of describing them, and covers recent turns it used to skip.",
            "Browser and app agents doing genuinely long work are no longer cut off at five minutes; a frozen tool still is.",
            "A chat that has grown too large now says so and suggests a fresh chat, instead of blaming the model and suggesting a switch that cannot help.",
            "Agents answer in the language you wrote in, instead of occasionally drifting into another one.",
        ],
    ),
    ReleaseNote(
        version="1.7.10-exp.2",
        headline="Browser research follows links instead of guessing, and long runs finish what they start.",
        highlights=[
            "A browsing task that spans several pages now actually walks them. Asking an agent to start somewhere and follow links through to another page no longer answers from the first page alone.",
            "Long jobs hold together. A run that reads, edits and re-runs tests over a hundred steps keeps its place and finishes with the detail intact.",
            "Panning the canvas no longer snags when the pointer crosses Settings or the Marketplace, and scrolling a settings row scrolls the row instead of dragging the whole board.",
            "A board full of streaming agents stays responsive. Each card now watches only the line of text it paints instead of every character of the reply.",
        ],
        fixes=[
            "The dictation notice no longer claims the fn key is broken when you simply have not pressed a key yet. It only says so once there is real evidence the key is not getting through.",
            "Text boxes inside agent cards are readable in light mode again. The free text field on a question could previously render dark on dark.",
            "A blocked or refused request no longer leaves the chat unusable, and the provider's wording is never stored as if the agent had said it.",
            "If security software quarantines the bundled agent runtime, the app puts it back itself instead of leaving you to find the file.",
            "A message typed while an agent is still working now says it is waiting, and tells you that Stop sends it straight away, instead of sitting there looking ignored.",
        ],
    ),
    ReleaseNote(
        version="1.7.9",
        headline="Agents keep going when the connection does not, and the fn key finally works.",
        highlights=[
            "Press fn to dictate on any Mac. It asks for permission the first time you use it rather than at install, and it recovers without a relaunch if you grant it later.",
            "Drop files straight onto a chat. Anything the app cannot take now says so instead of silently doing nothing.",
            "The transcript follows a running agent until you scroll away, and re-pins itself the moment you scroll back.",
            "Agents can move, tile, collapse and close their own cards, so a busy canvas tidies itself.",
        ],
        fixes=[
            "A dropped connection no longer costs you the conversation. The agent reconnects and carries on from where it was.",
            "Pressing Stop stops it. A background watchdog can no longer restart a chat you just ended.",
            "Chats stopped disconnecting mid task. A slow web page was being mistaken for a jammed tool and shot, roughly ten times a week per install.",
            "An agent that runs out of things to say gets asked once for its answer instead of leaving you looking at a Done label with nothing under it.",
            "Signing in on a fresh install works. The hand off back from your browser was landing on the wrong port.",
            "An expired provider login renews itself mid run instead of stopping the turn and asking you to reconnect.",
            "A browser agent can no longer report a task complete when the page never changed.",
            "Turning a schedule on or off tells you the truth. A failed save used to leave the switch showing the wrong state.",
            "Card resizing ends when you let go, even over an embedded browser.",
            "Dictation goes to the chat you were typing in, not a brand new one.",
        ],
    ),
    ReleaseNote(
        version="1.7.8",
        headline="A stuck chat unsticks itself, and agents can finally upload files.",
        highlights=[
            "Agents can attach a file to an upload field on a website, including the hidden ones sites put behind a styled Choose File button.",
            "Closing a popped-out browser puts it back in the chat it came from instead of destroying it.",
            "Copying a chat brings its browser along, so a pasted copy is not missing half of itself.",
            "Your window keeps the size you gave it, even after the app recovers from a crash.",
        ],
        fixes=[
            "A browser agent can no longer tell you a job is done when it changed nothing on the page, and a report built out of made-up tool calls is refused instead of being passed on to you as fact.",
            "App cards resize from any tab. The handles were buried under the code and terminal panels, so only the preview tab could be dragged.",
            "Bringing back a minimized card keeps the spot you left it in when that spot is still free, and moves it somewhere sensible when something else has taken it.",
            "The first time you press dictate after opening the app, it starts recording straight away instead of swallowing the first couple of seconds.",
            "Web search falls back to better sources. The first fallback answered about a quarter of factual questions correctly, so it now runs last.",
            "Panning the canvas can no longer be interrupted by the view flying somewhere else at the same time.",
            "When an agent is driving a browser, your cursor stops being yanked away and handed back over and over; you get it back once, when the agent stops.",
            "Pressing Cmd+A inside a chat selects that conversation, including its tool output and images, instead of selecting every card on the board.",
            "An agent working in a folder is now told when that copy of the code is far behind, so it stops confidently diagnosing from a stale checkout.",
            "Deleting a published app now takes it off the internet. It used to remove the app from your machine while the public link kept serving it, and because the record was gone you could no longer take it down.",
            "Publishing warns you about a backend the published app cannot run, however the code happens to write the address. It only recognised one spelling before, so most such apps published clean and broke only once they were live.",
            "The app no longer crawls a 21,000-server directory in the background on every launch. It now loads that list the first time you open the connector browser, and not before.",
            "Installing an experimental build no longer quietly puts you back on the stable one the next time you quit.",
            "The model you pick is the model that runs. The retired free tier was quietly forcing every session onto Haiku no matter what the picker said; it is gone, and installs still carrying it are moved off.",
            "Renaming an app now writes the new name where agents read it, so asking about \"the X app\" stops confusing them.",
            "Deleting an app that can't be taken off the internet now says so instead of making the app vanish from the board and reappear on the next reload.",
            "An app that had been opened before could get stuck loading forever, and opening a second window of it was the only way through. It reports where to find itself again, so the first window works.",
            "Apps with their own backend can start it again. On packaged builds the bundled Python shipped without the piece that makes a virtual environment usable, so every new app's backend died on startup while three separate steps reported success.",
            "An app whose backend is switched on always boots a real server now, instead of being served as a prebuilt page wired to an API that was never started.",
            "Hard-reloading an app that had no running process now actually restarts it, instead of timing out and blaming a runtime that was fine.",
            "When the assistant's core tools freeze mid-task, they recover within about half a minute and the assistant redoes the step it lost, instead of leaving the chat running forever.",
            "A chat whose built-in tools fail to start now rebuilds itself instead of running the whole conversation without them and quietly hunting for tools it does not have.",
            "Card edges are grabbable again. Half of every resize strip was being cut off by the card itself, so the bottom and right edges could not be grabbed at all.",
            "The hover controls on a collapsed chat sit fully above it now, instead of peeking out from behind one corner and looking like a dent with a shadow.",
            "A question the assistant asks from a collapsed chat is wide enough to read, instead of being cut off at the right edge.",
            "Fable is no longer offered in the model picker. It never worked when selected.",
            "A chat that started failing on \"that request hit a snag\" now recovers on your next message instead of staying broken until you branch it.",
            "Apps no longer get stuck on \"Starting preview\" forever; one app serving a prebuilt bundle used to silently wedge every other app until a restart.",
            "Deleting an app now actually removes it from disk instead of leaving its full source tree behind invisibly.",
            "A workflow that drives a browser now shows up as a real chat card while it runs, its browser lives inside that card, and both are cleaned up when the run ends.",
            "A chat tiled to fill the screen now hides the canvas controls the same way fullscreen does, so tidy and zoom stop covering the composer.",
            "A momentary read error can no longer wipe a dashboard's layout permanently; the app now treats it as an error instead of an empty board.",
            "A new dashboard shows the starter screen again instead of an empty grid with nothing on it.",
            "The canvas can no longer break into a state where panning dies, cards vanish, and the zoom reads NaN; a bad camera value is refused instead of saved.",
            "A stray trackpad pinch outside the canvas no longer magnifies the whole app out of view; it snaps back within a second.",
            "Quitting while a window is leaving fullscreen no longer crashes the app, and no longer leaves an invisible copy running either.",
            "Fixed a fault that could make OpenSwarm write gigabytes of crash reports in the background and stop responding.",
            "The canvas no longer keeps following your cursor after you release the mouse outside the window.",
            "Browsers left behind by finished agents are cleaned up instead of piling up and eating memory.",
            "Google sign-in buttons inside the browser now open a window OpenSwarm can actually complete, including on sites like Pinterest.",
            "Starting dictation lights up the stop control only in the chat you are dictating into, not every chat at once.",
            "Dictation says where your words went instead of dropping them silently.",
            "Chat titles and tool-group labels can no longer hang a request for ten minutes when a provider is wedged; they fall back within 45 seconds.",
            "An agent working inside one of your apps can no longer take over your mouse pointer. A game or canvas app could capture the real cursor the moment the agent clicked it, and keep it for the rest of the run.",
            "Cmd+C copies in every window, not only the first one you opened.",
            "Unpublishing an app tells you the truth. If it could not be taken off the internet it now says why, instead of reporting success and leaving the link live with no way to try again.",
            "You can stop agents from changing your settings, in Settings. They can still read them, with your keys hidden, so they can answer questions without editing anything.",
            "The publish screen always says what a published app can and cannot do, including when it has security warnings to show you at the same time.",
            "If the \"OpenSwarm needs to reload\" prompt itself fails, the app now tries to reload instead of quitting and taking your session with it.",
            "Custom system prompts now actually shape the agent from its very first reply. They were being delivered but ignored: buried in the middle of a long prompt, so the model paid them no attention.",
            "Your conversation survives a backend crash. Chats used to be saved only when a turn finished cleanly, so a crash mid-answer could erase the whole conversation; now every message you send is saved the moment you send it.",
            "Parked apps now truly sleep. Closing an app froze only its outermost script while the real dev server kept burning CPU in the background; the whole process tree freezes now and wakes instantly when you reopen it.",
            "Clicking empty canvas clears a text selection, the way every other text surface does.",
            "Brand-new apps stop dying at birth on busy machines. The first boot installs dependencies, which can take minutes; a fixed 60-second limit was killing exactly those boots.",
            "An agent that sent work to a browser can no longer hang forever when the finished result gets lost on the way back; it notices, recovers, and redoes the step.",
            "The app opens seconds faster on machines with a crowded system temp folder. File uploads moved into OpenSwarm's own folder, so startup no longer pays a toll that grew with years of temp-file clutter.",
            "Clicking a chat in the sidebar or history now frames the whole card. The camera used to aim at the chat's collapsed footprint, so an opened chat could land with its bottom half off-screen and need a manual pan after every autofocus.",
            "Starting a new chat no longer makes another agent's revealed subagents disappear from the canvas. Their cards were being cleaned up as strays by the same pass that places the new one.",
            "Workflow run history shows each run's workflow name instead of the word \"Workflow\" on every row. The name now travels with the run, so it survives renames and deleted workflows.",
            "An expired provider login heals itself mid-chat: the first failure rebuilds the connection and retries your message with zero clicks, and only a second failure asks you to reconnect. It used to take six manual steps every time a token aged out.",
            "A newly connected ChatGPT or Gemini subscription works immediately. The routing layer restarts itself the moment a connect completes, so new subscriptions no longer sit dead behind rate-limit errors until you restart the app.",
            "Finished apps opened from the dock no longer sit on \"Starting preview\" forever. Apps served straight from their built files have no server process by design, and the preview was waiting for one that would never exist.",
            "A chat that was cut off mid-answer now says so right on the board with an amber \"Stopped mid-task, click to resume\" chip, instead of looking idle until you open it and hunt for the resume button.",
            "An app or browser card whose page process dies now reloads itself instead of sitting as a solid black rectangle. The crash fired no load event at all, so nothing ever repainted it.",
            "The mouse-wheel Zoom/Scroll setting works on real mice now. Accelerated wheels (Magic Mouse, Logitech smooth scrolling) report fractional scroll amounts that were being mistaken for a trackpad, so the wheel always panned no matter what the setting said.",
            "A browser helper that talks itself into refusing (\"I\u2019m a text-based AI\") no longer poisons its browser for every later task. Refused and fabricated runs are forgotten instead of remembered, and agents can ask for a completely fresh browser when one misbehaves.",
            "Agents no longer claim \"the user told me to stop\" when it was OpenSwarm\u2019s own housekeeping talking. Internal wrap-up and retry messages now identify themselves, so an agent\u2019s explanation of why it stopped reflects what actually happened.",
            "Workflows you describe in chat can no longer save as empty shells that fail every scheduled run, pressing Run now opens the actual working agent instead of a separate monitor panel, and an agent's browser tucks neatly under its chat pill instead of floating beside it.",
            "The amber resume chip now appears only on chats that were genuinely cut off mid-answer instead of every stopped chat, and agents can now see and operate the popup sign-in windows that sites open, instead of going blind at them.",
            "Double-clicking empty canvas reliably fits every card on screen again, and an app an agent builds or drives now docks as a small card beside the chat instead of covering it. When a website needs you to sign in, the agent now pauses, tells you, and continues by itself once you log in on its browser card.",
            "Agents no longer lose their tools partway through a run. Under heavy multi-agent load, a safety timer could mistake a queued browser or app task for a lost one and restart the agent's tool connection mid-task; it now checks the right task before acting.",
            "Heavy sessions no longer vanish without a trace. When memory climbs past the safe line the app now sheds weight itself: preview thumbnails pause and refetchable caches drop, instead of growing until the operating system kills it mid-task.",
            "A browser that fails to open a page now says so instead of confidently answering from the page it was already on, and a stuck browser card gets swapped for a fresh one automatically.",
            "Clicking Home, Calendar or New Workflow inside the workflow window no longer yanks the canvas to a fixed spot.",
            "Hovering a dock button no longer inflates the chat entry next to it, and hover previews near the bottom of the rail stop running off screen.",
            "Onboarding no longer shows squished frames from an outdated demo video; the old clips are gone and every install is 6MB lighter.",
            "Agents can tidy up after themselves on the canvas: move, shrink, tile or close their own cards after creating them. Closing is limited to cards they own.",
            "Settings gains a Tools tab where you can allow, ask, or block any built-in tool. The backend enforces it, so blocked means blocked everywhere.",
            "The app is ready sooner after launch: the backend now starts the instant the app opens instead of waiting behind window setup.",
            "Collapsed chat pills render clean everywhere: no shadow slabs, no doubled browser preview, no cropped ring corners, and opening a pill no longer flies the camera across the canvas.",
            "A browser task whose control link dropped used to keep driving the browser as a ghost; it now stops the moment its controller disappears, so a retry always gets a free browser.",
            "The app cleans up after itself: update downloads you have already installed are deleted (hundreds of megabytes back) and oversized browsing caches are trimmed every few hours; your logins are never touched.",
            "Dragging and panning stay smooth while agents are answering: streamed text now waits a beat during your gesture instead of stealing frames mid-drag, and collapsed pills lose their last visual glitches (ghost smudge at the corner, near-square miniature corners).",
        ],
    ),
    ReleaseNote(
        version="1.7.7",
        headline="Agents remember, apps get lighter, and fullscreen stays put.",
        highlights=[
            "Agents can now save facts you tell them and recall them in any later chat. You curate the list in Settings.",
            "Apps you built can use your connected tools after you approve each app once; nothing is granted by default.",
            "Apps nobody is editing serve a prebuilt copy instead of a full dev server, cutting hundreds of megabytes per open app.",
            "Agent questions and permission asks arrive as clean step-by-step cards instead of plain text forms.",
            "The model picker groups your subscriptions first, then API keys, then routers, so plans and pay-per-use never mix.",
            "Dictation starts faster: the microphone stays warm for a few minutes after each use.",
        ],
        fixes=[
            "Signing in with Google lands every time. The sign-in could previously finish in your browser and never reach the app, leaving you signed out after a reload.",
            "Experimental builds stop flipping back and forth with the stable version on every restart.",
            "If the app briefly loses its local connection it now retries and heals itself, and tells you plainly when it cannot, instead of spinning forever with no explanation.",
            "Buttons on the question cards agents show you always respond, including on a collapsed chat, and answered questions never leave a second dead copy behind.",
            "Images, posts and links agents show you open when you click them, and a click from fullscreen takes you there instead of doing nothing.",
            "Agents stop building a whole app when you only asked to track or plan something; they offer first.",
            "Creating a new app works again in the installed build; it previously hung on a blank preview forever.",
            "Nothing can be dragged while a window is fullscreen, and older profiles with stuck fullscreen state are healed on load.",
            "An agent that stops without answering now says so honestly instead of pretending it finished.",
            "When a provider is retrying behind the scenes you see a live status pill instead of a frozen card.",
            "App and browser icons in the sidebar are always real images, never letters or numbers.",
            "Usage now reports the time agents actually spent working, not time spent waiting.",
        ],
    ),
    ReleaseNote(
        version="1.7.5",
        headline="Off means off, and the canvas stops tearing.",
        highlights=[
            "Deleting a scheduled workflow makes it stay deleted. One that was mid-run could previously save itself back and keep firing.",
            "Switching a workflow off now stops everything: no queued catch-up runs, nothing waiting on the review card.",
            "Scrolling inside a panel, list, or window stays in that panel instead of dragging the canvas with it.",
            "Opening a busy dashboard no longer locks the window while its cards wake up.",
        ],
        fixes=[
            "The canvas background no longer tears into a hard-edged rectangle when lots of browsers are open.",
            "Editing a workflow step can no longer hang the editor when the naming service is slow.",
            "A crashed session no longer leaves a key watcher running, which made dictation start and immediately stop.",
            "The first message after opening a chat reuses the warmed-up connection, so it answers sooner.",
            "A provider hiccup that fixes itself no longer shows a scary reconnect card.",
        ],
    ),
    ReleaseNote(
        version="1.7.4",
        headline="Chats survive a hiccup instead of stopping.",
        highlights=[
            "A dropped local connection retries and resumes the same answer instead of failing the message.",
            "The spawn composer steps aside when a window is open.",
        ],
        fixes=[
            "App previews reconnect on their own after a backend restart.",
            "Dictation cue sounds default to a level you can actually hear.",
        ],
    ),
]


@typechecked
def release_notes(version: str) -> ReleaseNote | None:
    # An experimental build (1.7.6-exp1) tells the same story as its base release.
    base = version.split("-", 1)[0]
    for note in P_RELEASES:
        if note.version == version or note.version == base:
            return note
    return None


@typechecked
def latest_release() -> ReleaseNote:
    return P_RELEASES[0]


@typechecked
def as_markdown(note: ReleaseNote) -> str:
    """The GitHub release body; identical words to the in-app card, so nobody reads two stories."""
    lines = [f"## {note.version}: {note.headline}", ""]
    if note.highlights:
        lines.append("### New")
        lines += [f"- {h}" for h in note.highlights]
        lines.append("")
    if note.fixes:
        lines.append("### Fixed")
        lines += [f"- {f}" for f in note.fixes]
    return "\n".join(lines).strip()


@typechecked
def help_context_block(app_version: str) -> str:
    """What the Help agent must know about what just changed, so "what's new" is never stale."""
    note = release_notes(app_version) or latest_release()
    # The Help agent names the RUNNING version even on an experimental build riding its base release's story.
    shown = app_version if release_notes(app_version) is note and app_version else note.version
    body = [f"Version {shown}: {note.headline}"]
    body += [f"- new: {h}" for h in note.highlights]
    # The Help agent's context rides a token budget; the full list stays in the changelog UI.
    p_shown_fixes = note.fixes[:30]
    body += [f"- fixed: {f}" for f in p_shown_fixes]
    if len(note.fixes) > len(p_shown_fixes):
        body.append(f"- ...plus {len(note.fixes) - len(p_shown_fixes)} more fixes in this release.")
    return "\n".join(body)


@typechecked
def all_versions() -> Dict[str, str]:
    return {n.version: n.headline for n in P_RELEASES}
