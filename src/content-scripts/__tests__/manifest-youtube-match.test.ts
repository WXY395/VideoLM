import { describe, expect, it } from 'vitest';
import manifest from '../../../manifest.json';

describe('YouTube content script manifest coverage', () => {
  it('loads on YouTube entry pages so SPA navigation into watch pages can inject immediately', () => {
    const youtubeContentScript = manifest.content_scripts.find((script) =>
      script.js.includes('src/content-scripts/youtube.ts'),
    );

    expect(youtubeContentScript?.matches).toContain('https://www.youtube.com/*');
  });
});
