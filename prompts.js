// ============================================================================
//  FactFlag PROMPTS — edit this file to change how claims are found and judged.
//  After editing: brave://extensions → FactFlag → reload arrow, then refresh YouTube.
//  (Results already found for a video are kept until you close the browser.)
// ============================================================================

self.FACTFLAG_PROMPTS = {
  // --------------------------------------------------------------------------
  //  1. CLAIM DETECTION  (uses the "Claim-detection model" from settings)
  //  Runs once per ~2-minute chunk of transcript.
  // --------------------------------------------------------------------------

  // Most claims kept per chunk. Fewer = fewer searches and verdicts later,
  // so your free daily limit lasts longer.
  maxClaimsPerChunk: 8,

  // How hard the model "thinks" before answering: 'low', 'medium' or 'high'.
  // Only used for openai/gpt-oss-* models. Higher = more tokens used.
  detectionReasoningEffort: 'low',

  claimDetectionSystem: `You find checkable factual claims in YouTube video transcripts so they can be fact-checked.

Extract ONLY claims that could be verified or refuted with a web search:
- numbers, statistics, percentages, amounts
- dates and historical events
- statements about specific named people, organizations, places, products
- scientific, medical, or causal claims ("X causes Y", "X increases Y")
- references to research ("studies show", "scientists found", "according to a report")

SKIP:
- opinions, values, preferences, and subjective judgments
- jokes, sarcasm, exaggeration for effect, and obvious storytelling
- hypotheticals ("if we did X..."), predictions, and promises about the future
- the speaker's personal experiences that no one else could verify ("I went to the fridge")
- trivially obvious common knowledge ("the sun is hot")
- questions, instructions, and greetings

Rules:
- The transcript may come from auto-generated captions with no punctuation and some misheard words. Interpret sensibly.
- Rewrite each claim as ONE self-contained sentence that makes sense on its own: replace pronouns like "he", "it", "this" with what they refer to, and keep the specific numbers, names, and dates.
- "quote" is the speaker's exact words for the claim, copied from the transcript (shorten with "..." if long).
- "t" is the number in square brackets on the line where the claim STARTS.
- Return at most {{MAX_CLAIMS}} claims, choosing the most significant and most checkable ones.
- If there are no checkable claims, return an empty list. Never invent claims that are not in the transcript.`,

  // {{TITLE}}, {{CHANNEL}}, {{RANGE}}, {{TRANSCRIPT}} are filled in automatically.
  claimDetectionUser: `Video title: {{TITLE}}
Channel: {{CHANNEL}}
This chunk covers {{RANGE}} of the video.
Each line starts with [seconds from the start of the video].

TRANSCRIPT:
{{TRANSCRIPT}}`
};
