// Default settings, shared by the settings page, content script and background worker.
// API keys are never given defaults — the user enters them on the settings page.
self.FACTFLAG_DEFAULTS = {
  enabled: true,
  groqApiKey: '',
  tavilyApiKey: '',
  // Fast model: finds checkable claims in transcript chunks.
  detectionModel: 'openai/gpt-oss-20b',
  // Stronger model: decides TRUE / FALSE / MISLEADING / UNVERIFIABLE from search results.
  verdictModel: 'openai/gpt-oss-120b'
};
