/**
 * Strip wrapping markdown code fence from AI output.
 *
 * Some LLMs (notably GPT-4o-mini) wrap their output in ```markdown ... ```
 * fences despite prompts saying "Output ONLY the document".
 * This breaks downstream processing that uses code fences for transport
 * (e.g. Notion export's VIDEO_CITATION_BLOCK fence).
 *
 * Strips:
 *   ```markdown\n[content]\n```
 *   ```md\n[content]\n```
 *   ```\n[content]\n```  (bare fence)
 *   \n```md\n[content]\n```\n (with surrounding whitespace)
 *
 * Leaves other content untouched.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  // Only strip when the ENTIRE response is wrapped in a fence
  // Match: ```<optional-lang>\n<content>\n```
  const match = trimmed.match(
    /^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i,
  );
  if (match) {
    return match[1];
  }
  return text;
}
