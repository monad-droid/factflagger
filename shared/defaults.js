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
  // When alerts (pop-up, glow, ding, live list row) come: 'start' = as the
  // speaker begins saying the claim; 'end' = right after they finish it.
  alertTiming: 'start',
  // For each verdict, what happens right after the claim is said:
  // pop up = the claim and its verdict show for 10 s (one row);
  // glow = the edge of the video softly glows in the verdict's colour.
  // "True" includes "likely true" claims that weren't searched.
  popFalse: true,
  popMisleading: true,
  popTrue: true,
  popUnverifiable: true,
  glowFalse: false,
  glowMisleading: false,
  glowTrue: false,
  glowUnverifiable: false,
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
  alertTiming: { type: 'enum', values: ['start', 'end'], label: 'Alert at', about: "When pop-ups, glows and the ding come: 'end' = right after the speaker finishes the claim, 'start' = as they begin it." },
  popFalse: { type: 'boolean', label: 'Pop up FALSE', about: 'Pop up false claims (claim, verdict, source) for 10 seconds right after they are said.' },
  popMisleading: { type: 'boolean', label: 'Pop up MISLEADING', about: 'Pop up misleading claims.' },
  popTrue: { type: 'boolean', label: 'Pop up TRUE', about: 'Pop up true and likely-true claims.' },
  popUnverifiable: { type: 'boolean', label: "Pop up CAN'T TELL", about: 'Pop up claims that could not be verified.' },
  glowFalse: { type: 'boolean', label: 'Glow for FALSE', about: 'The edge of the video glows red for false claims.' },
  glowMisleading: { type: 'boolean', label: 'Glow for MISLEADING', about: 'Glow orange for misleading claims.' },
  glowTrue: { type: 'boolean', label: 'Glow for TRUE', about: 'Glow green for true and likely-true claims.' },
  glowUnverifiable: { type: 'boolean', label: "Glow for CAN'T TELL", about: 'Glow grey for claims that could not be verified.' },
  glowStrength: { type: 'number', min: 5, max: 100, label: 'Glow strength', about: 'How strong the glow is, 5 to 100 (default 40).' }
};
