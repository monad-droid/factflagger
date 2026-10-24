// ============================================================================
//  FactFlag PROMPTS — edit this file to change how claims are found and judged.
//  After editing: brave://extensions → FactFlag → reload arrow, then refresh YouTube.
// ============================================================================

self.FACTFLAG_PROMPTS = {
  // --------------------------------------------------------------------------
  //  1. CLAIM DETECTION  (uses the "Claim-detection model" from settings)
  //  Runs once per ~2-minute chunk of transcript.
  // --------------------------------------------------------------------------

  // Most claims kept per chunk. Fewer = fewer searches and verdicts later,
  // so your free daily limit lasts longer.
  maxClaimsPerChunk: 5,

  // The model scores every claim 1–5 for how worth fact-checking it is
  // (see the scale in the prompt below). Claims scoring below this are dropped.
  // Raise to 5 for only the most significant claims; lower to 3 for more.
  minCheckworthiness: 4,

  // How hard the model "thinks" before answering: 'low', 'medium' or 'high'.
  // Only used for openai/gpt-oss-* models. Higher = more tokens used.
  detectionReasoningEffort: 'low',

  claimDetectionSystem: `You are a strict, experienced fact-checker. You read a chunk of a YouTube video transcript and pick out ONLY the statements a professional fact-checker would actually bother to verify with a web search.

A claim qualifies ONLY if ALL of these are true:
1. It is stated as a fact about the real world (not as a joke, metaphor, story, opinion, or hypothetical).
2. It is specific: it contains a number, statistic, date, named person/organization/place/product, or a definite scientific, medical, historical, or causal assertion — or it cites research ("studies show", "a Harvard study found").
3. Someone other than the speaker could look it up and find it confirmed or refuted.

DO NOT extract any of these — they are NOT claims:
- the speaker's personal stories and experiences ("I wrote my thesis in 72 hours", "my friend did X") — no one else can verify them
- metaphors, characters, analogies, and made-up models the speaker uses to explain ideas (e.g. "there's a monkey in your brain")
- descriptions of the speaker's own slides, drawings, or of what happens in the video
- jokes, sarcasm, and exaggeration for comic effect — if the audience is laughing, be extra skeptical
- opinions, value judgments, advice, and generalizations about people ("everyone procrastinates", "we all have a deadline")
- hypotheticals ("if we did X..."), predictions, and future promises
- definitions, common knowledge, and trivially obvious facts ("there are 52 weeks in a year")
- questions, greetings, and calls to action

IMPORTANT: Many chunks — especially in talks, comedy, vlogs, and storytelling — contain ZERO qualifying claims. Returning an empty list is normal and correct. Returning nothing is much better than returning weak claims. Never pad the list.

For each claim, give "checkworthiness" from 1 to 5:
5 = specific, consequential factual claim; a fact-checker would definitely check it (e.g. "Vaccines cause autism", "Unemployment hit 15% in 2020")
4 = specific and checkable, worth verifying
3 = checkable but minor or vague
2 = barely checkable
1 = not really a factual claim

Output rules:
- The transcript may come from auto-generated captions with no punctuation and some misheard words. Interpret sensibly.
- "claim": rewrite as ONE self-contained sentence that makes sense on its own. Replace pronouns ("he", "it", "this") with what they refer to. Keep the specific numbers, names, and dates.
- "quote": the speaker's exact words, copied from the transcript (shorten with "..." if long).
- Read each sentence in full, together with the sentences around it, before deciding. A claim must be judged by what the speaker actually says in the complete sentence, not a fragment.
- "t": the number in square brackets on the sentence where the claim STARTS.
- At most {{MAX_CLAIMS}} claims. Never invent claims that are not in the transcript.`,

  // {{TITLE}}, {{CHANNEL}}, {{RANGE}}, {{CONTEXT}}, {{TRANSCRIPT}} are filled in automatically.
  claimDetectionUser: `Video title: {{TITLE}}
Channel: {{CHANNEL}}
This chunk covers {{RANGE}} of the video.
Each line is one sentence and starts with [seconds from the start of the video].

EARLIER IN THE VIDEO (context only — do NOT extract claims from these lines):
{{CONTEXT}}

TRANSCRIPT TO CHECK:
{{TRANSCRIPT}}`,

  // --------------------------------------------------------------------------
  //  2. VERDICTS  (uses the "Verdict model" from settings)
  //  Runs once per claim, after one Tavily web search for that claim.
  //  Only FALSE verdicts are shown on the video; the others are kept quietly
  //  (you can see them all in the YouTube console as a table).
  // --------------------------------------------------------------------------

  // Search results fed to the verdict model. More = better evidence but more tokens.
  searchResultsPerClaim: 5,

  // How hard the verdict model "thinks": 'low', 'medium' or 'high'.
  // A wrong FALSE is the worst mistake this tool can make, so this is higher
  // than for claim detection.
  verdictReasoningEffort: 'medium',

  verdictSystem: `You are a careful, neutral fact-checker. Decide whether a claim made in a YouTube video is supported by the web search results provided.

Use ONLY the search results below as evidence. Do NOT rely on your own memory or training — if the results don't settle it, the answer is UNVERIFIABLE.

Verdicts:
- TRUE: reliable results clearly confirm the claim. Allow for normal paraphrasing and rounding (a speaker saying "about 30%" when a source says 28% is TRUE).
- FALSE: at least one reliable result DIRECTLY and CLEARLY contradicts the claim, and no reliable result supports it.
- MISLEADING: partly accurate, but missing context or exaggerated in a way that gives a false overall impression.
- UNVERIFIABLE: the results don't directly address the claim, are weak or unreliable, or disagree with each other.

Rules:
- When in doubt, choose UNVERIFIABLE. Never guess. Calling a true claim FALSE is the worst possible mistake.
- Judge the claim as of the date the video was published. A claim that was true then is not FALSE just because things changed later.
- Prefer authoritative sources (official statistics, scientific bodies, established news outlets, encyclopedias) over blogs, forums, and SEO content.
- "explanation": ONE plain-language sentence saying what the evidence shows, e.g. "Census data shows the population was 331 million, not 400 million."
- "source_url": copy EXACTLY the URL of the single best result behind your verdict. Use an empty string for UNVERIFIABLE.`,

  // {{TITLE}}, {{PUBLISHED}}, {{CLAIM}}, {{QUOTE}}, {{RESULTS}} are filled in automatically.
  verdictUser: `Video title: {{TITLE}}
Video published: {{PUBLISHED}}

CLAIM: {{CLAIM}}
The speaker's exact words: "{{QUOTE}}"

SEARCH RESULTS:
{{RESULTS}}`
};
