# FactFlag

A Brave/Chrome extension (Manifest V3) that fact-checks YouTube videos and flags false claims at the moment they're said. Personal use, loaded unpacked — no server, no Web Store.

**Status: Phase 1** — extension loads, settings page saves keys, captions are pulled and printed to the console.

## Install in Brave (one time)

1. Download this folder to your computer (e.g. `git clone`, or GitHub → Code → Download ZIP, then unzip).
2. In Brave, type `brave://extensions` in the address bar and press Enter.
3. Turn on **Developer mode** (toggle, top-right).
4. Click **Load unpacked** and pick the `factflagger` folder (the one that contains `manifest.json`).
5. The FactFlag settings page opens automatically. Click the puzzle-piece icon in the toolbar and pin FactFlag if you want quick access — clicking it opens settings for now.

**After you get new code** (e.g. after each phase): go to `brave://extensions` and click the circular **reload** arrow on the FactFlag card, then **reload any open YouTube tabs**. YouTube tabs that were open before the reload won't have the new code.

## Settings

- **Groq API key** — from https://console.groq.com/keys
- **Claim-detection model** (fast) — default `openai/gpt-oss-20b`
- **Verdict model** (stronger) — default `openai/gpt-oss-120b`
- **Tavily API key** — from https://app.tavily.com
- **On/off toggle**

Click **Test Groq key & models** to check that your key works and both model IDs exist on your account. If a model is missing, the page lists the ones that are available.

Keys are stored only in `chrome.storage.local` in your browser and are never logged.

## How captions are read

YouTube now returns empty caption files unless the request carries a token its own player generates. FactFlag:

1. Reads the video's caption track list from the player (prefers manual English, then auto-generated English).
2. Tries to download the track directly. If that comes back empty, it briefly toggles the player's **CC** button so the player makes its own caption request, borrows the token from it, and downloads the full track. CC is put back the way you had it. You may see captions flash for a moment.
3. If that fails, it opens YouTube's **Show transcript** panel, reads it, and closes it.
4. If the video has no captions, it prints `No captions available`.

Everything happens inside your YouTube tab; no outside service is used for captions.
