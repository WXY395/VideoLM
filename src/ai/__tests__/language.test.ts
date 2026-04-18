import { describe, it, expect } from 'vitest';
import { resolveOutputLanguage } from '../language';

describe('resolveOutputLanguage', () => {
  describe('auto mode', () => {
    it('converts zh-TW caption code to Traditional Chinese', () => {
      expect(resolveOutputLanguage('auto', 'zh-TW')).toBe('Traditional Chinese');
    });

    it('converts zh-CN to Simplified Chinese', () => {
      expect(resolveOutputLanguage('auto', 'zh-CN')).toBe('Simplified Chinese');
    });

    it('converts yue to Cantonese', () => {
      expect(resolveOutputLanguage('auto', 'yue')).toBe('Cantonese');
    });

    it('converts en to English', () => {
      expect(resolveOutputLanguage('auto', 'en')).toBe('English');
    });

    it('converts ja to Japanese', () => {
      expect(resolveOutputLanguage('auto', 'ja')).toBe('Japanese');
    });

    it('falls back to English when video language is "unknown"', () => {
      expect(resolveOutputLanguage('auto', 'unknown')).toBe('English');
    });

    it('falls back to English when video language is empty string', () => {
      expect(resolveOutputLanguage('auto', '')).toBe('English');
    });
  });

  describe('override mode', () => {
    it('ignores video language when user sets en', () => {
      expect(resolveOutputLanguage('en', 'yue')).toBe('English');
    });

    it('ignores video language when user sets zh-TW', () => {
      expect(resolveOutputLanguage('zh-TW', 'en')).toBe('Traditional Chinese');
    });

    it('handles ja override', () => {
      expect(resolveOutputLanguage('ja', 'en')).toBe('Japanese');
    });
  });

  describe('edge cases', () => {
    it('falls back to English for malformed ISO code in auto mode', () => {
      // Intl.DisplayNames may return undefined for garbage input
      expect(resolveOutputLanguage('auto', 'xyz-invalid-999')).toBe('English');
    });

    it('resolves zh-Hant-HK to Traditional Chinese via normalization layer', () => {
      // zh-Hant-HK has script subtag "Hant" which should normalize to Traditional
      // regardless of region, not pass through to Intl.DisplayNames (which would
      // return the more verbose "Chinese (Traditional, Hong Kong SAR China)")
      expect(resolveOutputLanguage('auto', 'zh-Hant-HK')).toBe('Traditional Chinese');
    });
  });
});
