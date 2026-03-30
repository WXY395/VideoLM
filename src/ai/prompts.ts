/**
 * RAG-optimized prompt templates for VideoLM.
 *
 * Every prompt is designed so that the AI output can be directly ingested
 * into Google NotebookLM as a Source document. This means:
 *   - Each H2 section is a self-contained knowledge unit (RAG retrieves chunks).
 *   - Key terms appear naturally within the first 50 words of each section.
 *   - Timestamp citations use [MM:SS] format so NotebookLM can ground answers.
 *   - Facts and opinions are explicitly marked for reliability evaluation.
 */

/** Format seconds to MM:SS */
function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Build a structured, RAG-optimized summary prompt.
 *
 * Output format: metadata block, H2/H3 outline with timestamps,
 * key arguments with citations, and a glossary.
 */
export function buildStructuredPrompt(
  transcript: string,
  title: string,
  author: string,
  duration: number,
  language: string,
): string {
  return `You are a research-document writer. Your output will be ingested into NotebookLM as a Source, so it must be optimized for RAG (Retrieval-Augmented Generation) retrieval.

## Instructions

Produce a structured Markdown document from the video transcript below. Follow these rules precisely:

### Document structure

1. **Metadata block** (at the top):
   - Title: ${title}
   - Author/Creator: ${author}
   - Duration: ${formatDuration(duration)}
   - Language: ${language}
   - Source type: Video transcript

2. **H2/H3 outline with timestamps**:
   - Use H2 (##) for major topics and H3 (###) for sub-topics.
   - Each H2 section must be a self-contained knowledge unit that can be understood without reading other sections. This is critical because RAG retrieves individual chunks.
   - Begin each H2 section with a 1-2 sentence overview. Key terms should appear naturally within the first 50 words of each section so the retrieval engine can match queries to the right chunk.
   - Include [MM:SS] timestamp references at the start of each section and inline for key claims.

3. **Key arguments with citations**:
   - Under each H2, list the main arguments or points as bullet points.
   - Each bullet should include a [MM:SS] timestamp citation.
   - Explicitly mark factual claims as [FACT] and opinions/interpretations as [OPINION].

4. **Glossary** (at the end):
   - Define any technical or domain-specific terms used in the transcript.
   - Each glossary entry should be a single concise sentence.

### Content quality rules

- Remove filler words (um, uh, like, you know, basically) and merge sentence fragments into coherent prose.
- Preserve the speaker's meaning accurately; do not inject your own opinions.
- Mark facts vs opinions: prefix factual claims with [FACT] and subjective statements with [OPINION].
- If the speaker cites a source, study, or statistic, note it explicitly.

### Output format

Output ONLY the Markdown document. Do not include any preamble, explanation, or commentary outside the document itself.

---

## Video transcript

${transcript}`;
}

/**
 * Build a concise research-brief prompt (under 800 words).
 */
export function buildSummaryPrompt(
  transcript: string,
  title: string,
  author: string,
  language: string,
): string {
  return `You are a research assistant. Your output will be ingested into NotebookLM as a Source.

Produce a concise research brief (under 800 words) from the following video transcript. The brief should be in ${language}.

**Video**: "${title}" by ${author}

### Requirements

- Start with a 2-3 sentence executive summary.
- List 3-7 key takeaways as bullet points.
- Note any sources, data, or statistics cited by the speaker.
- Mark factual claims as [FACT] and opinions as [OPINION].
- Use Markdown formatting (headings, bold, bullets).
- Remove filler words and merge fragments into clear prose.

Output ONLY the research brief.

---

## Transcript

${transcript}`;
}

/**
 * Build a prompt that splits the transcript into 3-8 chapters in JSON format.
 *
 * The chapter sizes target the 300-2000 word RAG sweet spot.
 * Includes different splitting strategies based on video type.
 */
export function buildChapterSplitPrompt(transcript: string): string {
  return `You are a content structuring engine. Split the following video transcript into logical chapters.

### Output format

Return ONLY a JSON array (no code fences, no commentary). Each element must have this shape:

[
  {
    "chapterTitle": "Descriptive chapter title",
    "startTime": 0,
    "endTime": 342,
    "summary": "1-2 sentence summary of the chapter",
    "keyTerms": ["term1", "term2"],
    "content": "Full cleaned-up text of the chapter..."
  }
]

### Rules

1. Produce between 3 and 8 chapters total.
2. Each chapter's \`content\` field must be between 300 and 2000 words (the RAG ingestion sweet spot).
3. Identify the video style and apply the appropriate splitting strategy:
   - **Tutorial/how-to**: split by step or concept taught.
   - **Interview/conversation**: split by topic shift or question.
   - **News/analysis**: split by story or argument.
   - **Short video (< 5 min)**: split into 3 chapters: intro, body, conclusion.
4. \`startTime\` and \`endTime\` are in seconds.
5. \`keyTerms\` should list 2-5 important terms or concepts from the chapter.
6. Clean up filler words, merge fragments, and produce coherent prose in the \`content\` field.
7. Chapter boundaries should occur at natural topic transitions, not mid-sentence.

---

## Transcript

${transcript}`;
}

/**
 * Build a translation prompt that preserves Markdown structure.
 */
export function buildTranslatePrompt(content: string, targetLang: string): string {
  return `Translate the following document into ${targetLang}.

### Rules

- Preserve all Markdown formatting exactly (headings, bold, italic, bullet points, code blocks).
- Preserve all [MM:SS] timestamp references as-is (do not translate timestamps).
- Preserve [FACT] and [OPINION] markers as-is.
- Translate technical terms accurately; if a term is commonly used in English in the target language, keep it in English with a parenthetical translation on first use.
- Do not add, remove, or reorder any content.
- Output ONLY the translated document.

---

${content}`;
}
