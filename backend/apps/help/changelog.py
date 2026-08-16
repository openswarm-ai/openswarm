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
    body += [f"- fixed: {f}" for f in note.fixes]
    return "\n".join(body)


@typechecked
def all_versions() -> Dict[str, str]:
    return {n.version: n.headline for n in P_RELEASES}
