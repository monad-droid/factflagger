// Default settings, shared by the settings page, content script and background worker.
// API keys are never given defaults — the user enters them on the settings page.
self.FACTFLAG_DEFAULTS = {
  enabled: true,
  // 'chatgpt' = use the viewer's ChatGPT plan for everything (no keys needed);
  // 'groq' = Groq + Tavily API keys.
  provider: 'chatgpt',
  // Play a short sound when a FALSE-claim card pops up.
  soundEnabled: true,
  // Claims list fills in live (each claim appears right after it's said);
  // off = show every claim found so far, including ones ahead.
  liveList: true,
  // Pop up each claim (one row, 10 s) right after it's said, once it has its
  // result. Off = only FALSE claims pop up.
  autoOpenList: true,
  // Glow mode: instead of opening the list, a soft glow around the video's
  // edge fades in and out in the verdict's colour. No words until you open
  // the list yourself.
  glowMode: false,
  // Which verdicts glow in glow mode (fewer = less distraction).
  glowFalse: true,
  glowMisleading: true,
  glowTrue: false,          // includes "likely true" claims that weren't searched
  glowUnverifiable: false,
  groqApiKey: '',
  tavilyApiKey: '',
  // Fast model: finds checkable claims in transcript chunks.
  detectionModel: 'openai/gpt-oss-20b',
  // Stronger model: decides TRUE / FALSE / MISLEADING / UNVERIFIABLE from search results.
  verdictModel: 'openai/gpt-oss-120b'
};
