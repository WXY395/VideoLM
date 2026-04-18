/**
 * Resolve the AI output language from user setting + video metadata.
 *
 * Returns a human-readable language name (e.g. "English", "Traditional Chinese",
 * "Cantonese") suitable for direct interpolation into an LLM prompt.
 *
 * Strategy:
 *   setting === 'auto'  → use videoContent.language (YouTube caption code)
 *   setting === 'en' / 'zh-TW' / ... → use that setting
 *   fallback: 'English' when code is 'unknown', empty, or unresolvable
 */
export function resolveOutputLanguage(
  setting: string,
  videoLanguage: string,
): string {
  const code = setting === 'auto' ? videoLanguage : setting;

  // Fallback early when we have nothing usable
  if (!code || code === 'unknown') {
    return 'English';
  }

  // Chinese variants: Intl.DisplayNames renders these as "Chinese (Taiwan)" /
  // "Chinese (China)", but "Traditional Chinese" / "Simplified Chinese" is
  // clearer for the LLM and matches how humans describe the script.
  const normalized = code.toLowerCase().replace(/_/g, '-');
  if (
    normalized === 'zh-tw' ||
    normalized === 'zh-hk' ||
    normalized === 'zh-mo' ||
    normalized.startsWith('zh-hant')
  ) {
    return 'Traditional Chinese';
  }
  if (
    normalized === 'zh-cn' ||
    normalized === 'zh-sg' ||
    normalized.startsWith('zh-hans')
  ) {
    return 'Simplified Chinese';
  }

  try {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
    const name = displayNames.of(code);
    // Intl.DisplayNames returns the input code itself when it can't resolve.
    // If that happens and the code looks like garbage, fall back.
    if (!name || name === code) {
      return 'English';
    }
    return name;
  } catch {
    // RangeError for invalid BCP 47 tags
    return 'English';
  }
}
