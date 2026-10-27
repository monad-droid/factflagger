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
  // When alerts (pop-up, glow, ding, live list row) come: 'start' = as the
  // speaker begins saying the claim; 'end' = right after they finish it.
  alertTiming: 'start',
  // Which verdicts glow in glow mode (fewer = less distraction).
  glowFalse: true,
  glowMisleading: true,
  glowTrue: false,          // includes "likely true" claims that weren't searched
  glowUnverifiable: false,
  // In glow mode, which verdicts still pop up (with the words) as well as glowing.
  glowPopFalse: true,
  glowPopMisleading: false,
  glowPopTrue: false,
  glowPopUnverifiable: false,
  // How strong the glow is, 5–100.
  glowStrength: 40,
  groqApiKey: '',
  tavilyApiKey: '',
  // Fast model: finds checkable claims in transcript chunks.
  detectionModel: 'openai/gpt-oss-20b',
  // Stronger model: decides TRUE / FALSE / MISLEADING / UNVERIFIABLE from search results.
  verdictModel: 'openai/gpt-oss-120b'
};

// Glow strength 5–100 → how opaque and how wide the glow is (40 = default).
// Shared by the on-video glow and the preview on the settings page.
self.factflagApplyGlowStrength = (el, strength) => {
  const s = Math.min(100, Math.max(5, Number(strength) || 40));
  el.style.setProperty('--glow-alpha', (0.007 * s).toFixed(3));
  el.style.setProperty('--glow-blur', `${Math.round(20 + 0.4 * s)}px`);
};

// Settings the "Ask to change a setting" box may change, with what each one
// means. API keys, the provider and models are deliberately left out.
self.FACTFLAG_SETTINGS_INFO = {
  enabled: { type: 'boolean', label: 'FactFlag on/off', about: 'Turns all checking on or off.' },
  soundEnabled: { type: 'boolean', label: 'Sound', about: 'Play a ding when a FALSE claim is flagged.' },
  liveList: { type: 'boolean', label: 'Live claims list', about: 'Claims appear in the list only once they have been said (off = show every claim found so far).' },
  autoOpenList: { type: 'boolean', label: 'Pop up every claim', about: 'Each claim pops up for 10 seconds right after it is said. Off = only FALSE claims pop up. Ignored in glow mode.' },
  alertTiming: { type: 'enum', values: ['start', 'end'], label: 'Alert at', about: "When pop-ups, glows and the ding come: 'end' = right after the speaker finishes the claim, 'start' = as they begin it." },
  glowMode: { type: 'boolean', label: 'Glow mode', about: 'Instead of pop-ups, the edge of the video softly glows in the verdict colour (red false, orange misleading, green true, grey cannot tell).' },
  glowFalse: { type: 'boolean', label: 'Glow for FALSE', about: 'In glow mode, glow red for false claims.' },
  glowMisleading: { type: 'boolean', label: 'Glow for MISLEADING', about: 'In glow mode, glow orange for misleading claims.' },
  glowTrue: { type: 'boolean', label: 'Glow for TRUE', about: 'In glow mode, glow green for true and likely-true claims.' },
  glowUnverifiable: { type: 'boolean', label: "Glow for CAN'T TELL", about: 'In glow mode, glow grey for claims that could not be verified.' },
  glowPopFalse: { type: 'boolean', label: 'Pop up FALSE in glow mode', about: 'In glow mode, also pop up false claims with the words.' },
  glowPopMisleading: { type: 'boolean', label: 'Pop up MISLEADING in glow mode', about: 'In glow mode, also pop up misleading claims with the words.' },
  glowPopTrue: { type: 'boolean', label: 'Pop up TRUE in glow mode', about: 'In glow mode, also pop up true claims with the words.' },
  glowPopUnverifiable: { type: 'boolean', label: "Pop up CAN'T TELL in glow mode", about: 'In glow mode, also pop up unverifiable claims with the words.' },
  glowStrength: { type: 'number', min: 5, max: 100, label: 'Glow strength', about: 'How strong the glow is, 5 to 100 (default 40).' }
};
