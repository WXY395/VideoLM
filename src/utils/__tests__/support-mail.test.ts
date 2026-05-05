import { describe, expect, it } from 'vitest';
import { buildSupportMailtoUrl } from '../support-mail';

describe('buildSupportMailtoUrl', () => {
  it('builds an editable support email with diagnostics in the body', () => {
    const url = buildSupportMailtoUrl({
      to: 'studiotest187@gmail.com',
      extensionVersion: '0.4.1',
      diagnosticsText: '{"extensionVersion":"0.4.1","hasApiKey":true}',
    });

    expect(url.startsWith('mailto:studiotest187@gmail.com?')).toBe(true);
    expect(decodeURIComponent(url)).toContain('VideoLM Support Request');
    expect(decodeURIComponent(url)).toContain('What happened?');
    expect(decodeURIComponent(url)).toContain('Steps to reproduce');
    expect(decodeURIComponent(url)).toContain('Diagnostics');
    expect(decodeURIComponent(url)).toContain('"hasApiKey":true');
  });
});
