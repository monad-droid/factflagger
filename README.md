# FactFlag

A Brave/Chrome extension (Manifest V3) that fact-checks YouTube videos and flags false claims at the moment they're said. Personal use, loaded unpacked — no server, no Web Store.

**Status: Phase 3+** — finds checkable claims, screens them, web-searches the ones that might be wrong (Tavily), and asks the verdict model for a verdict using only the search results. **Only FALSE claims are shown.** Right after the speaker finishes saying one, an alert card pops up in the top-right of the video (claim, speaker's words, what the source says, clickable source, and a **Copy** button for double-checking it yourself) and closes by itself after 7 seconds (hovering keeps it open). FALSE claims also get red triangles on the progress bar; clicking one jumps there and reopens its card.

**Saving the free tiers:**
- *Just in time:* FactFlag only works on the ~75 seconds ahead of where you're listening (`checkAheadSeconds` in `prompts.js`; more at faster playback, and it widens itself if a verdict nearly arrives late). Pausing costs nothing; abandoning a video costs only what you heard.
- *Triage:* before searching, the verdict model screens each claim; ones it is highly confident are true aren't searched. Turn off with `triageEnabled: false` in `prompts.js`.
- *Budget meter:* the toolbar badge shows Tavily searches left this month; the settings page shows Tavily and Groq usage.

Every verdict is printed in the YouTube console (filter by `FactFlag`) as it arrives.

## Tweaking the AI prompts

All prompts live in **`prompts.js`**. Edit it in any text editor, then reload the extension (see below). It also holds two easy knobs: the most claims kept per 2-minute chunk, and how hard the model "thinks".

## Install in Brave (one time)

1. Download this folder to your computer (e.g. `git clone`, or GitHub → Code → Download ZIP, then unzip).
2. In Brave, type `brave://extensions` in the address bar and press Enter.
3. Turn on **Developer mode** (toggle, top-right).
4. Click **Load unpacked** and pick the `factflagger` folder (the one that contains `manifest.json`).
5. The FactFlag settings page opens automatically. Click the puzzle-piece icon in the toolbar and pin FactFlag if you want quick access — clicking it opens settings.

**After you get new code** (e.g. after each phase): go to `brave://extensions` and click the circular **reload** arrow on the FactFlag card, then **reload any open YouTube tabs**. YouTube tabs that were open before the reload won't have the new code.

## Settings

- **Groq API key** — from https://console.groq.com/keys
- **Claim-detection model** (fast) — default `openai/gpt-oss-20b`
- **Verdict model** (stronger) — default `openai/gpt-oss-120b`
- **Tavily API key** — from https://app.tavily.com
- **On/off toggle**

Click **Test Groq key & models** to check that your key works and both model IDs exist on your account. If a model is missing, the page lists the ones that are available. **Test Tavily key** checks the Tavily key and shows credits used this month (it doesn't spend any).

Keys are stored only in `chrome.storage.local` in your browser and are never logged.

## How captions are read

YouTube now returns empty caption files unless the request carries a token its own player generates. FactFlag:

1. Reads the video's caption track list from the player (prefers manual English, then auto-generated English).
2. Tries to download the track directly. If that comes back empty, it briefly toggles the player's **CC** button so the player makes its own caption request, borrows the token from it, and downloads the full track. CC is put back the way you had it. You may see captions flash for a moment.
3. If that fails, it opens YouTube's **Show transcript** panel, reads it, and closes it.
4. If the video has no captions, it prints `No captions available`.

Everything happens inside your YouTube tab; no outside service is used for captions.
