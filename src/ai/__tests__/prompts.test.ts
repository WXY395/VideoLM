import { describe, it, expect } from 'vitest';
import {
  buildStructuredPrompt,
  buildSummaryPrompt,
  buildChapterSplitPrompt,
  buildTranslatePrompt,
} from '../prompts';

describe('buildStructuredPrompt', () => {
  const transcript = 'Hello world, this is a sample transcript about machine learning.';
  const title = 'Intro to ML';
  const author = 'Dr. Smith';
  const duration = 3600;
  const language = 'en';

  it('includes video metadata', () => {
    const prompt = buildStructuredPrompt(transcript, title, author, duration, language);
    expect(prompt).toContain('Intro to ML');
    expect(prompt).toContain('Dr. Smith');
    expect(prompt).toContain(language);
  });

  it('includes RAG optimization instructions', () => {
    const prompt = buildStructuredPrompt(transcript, title, author, duration, language);
    expect(prompt).toContain('NotebookLM');
    expect(prompt).toContain('self-contained knowledge unit');
    expect(prompt).toContain('first 50 words');
  });

  it('instructs for timestamp citations', () => {
    const prompt = buildStructuredPrompt(transcript, title, author, duration, language);
    expect(prompt).toContain('[MM:SS]');
  });

  it('instructs to mark facts vs opinions', () => {
    const prompt = buildStructuredPrompt(transcript, title, author, duration, language);
    expect(prompt.toLowerCase()).toMatch(/fact.*opinion|opinion.*fact/);
  });

  it('instructs for H2/H3 outline structure', () => {
    const prompt = buildStructuredPrompt(transcript, title, author, duration, language);
    expect(prompt).toContain('H2');
    expect(prompt).toContain('H3');
  });

  it('includes the transcript in the prompt', () => {
    const prompt = buildStructuredPrompt(transcript, title, author, duration, language);
    expect(prompt).toContain(transcript);
  });
});

describe('buildSummaryPrompt', () => {
  it('includes title and author', () => {
    const prompt = buildSummaryPrompt('transcript text', 'Video Title', 'Author Name', 'en');
    expect(prompt).toContain('Video Title');
    expect(prompt).toContain('Author Name');
  });

  it('mentions word limit', () => {
    const prompt = buildSummaryPrompt('transcript text', 'Title', 'Author', 'en');
    expect(prompt).toContain('800');
  });
});

describe('buildChapterSplitPrompt', () => {
  it('includes JSON format instructions', () => {
    const prompt = buildChapterSplitPrompt('some transcript', 'en');
    expect(prompt).toContain('chapterTitle');
    expect(prompt).toContain('startTime');
    expect(prompt).toContain('endTime');
    expect(prompt).toContain('JSON');
  });

  it('specifies chapter count range', () => {
    const prompt = buildChapterSplitPrompt('some transcript', 'en');
    expect(prompt).toMatch(/3.*8/);
  });

  it('specifies word count range per chapter', () => {
    const prompt = buildChapterSplitPrompt('some transcript', 'en');
    expect(prompt).toContain('300');
    expect(prompt).toContain('2000');
  });

  it('includes the transcript', () => {
    const prompt = buildChapterSplitPrompt('unique transcript content here', 'en');
    expect(prompt).toContain('unique transcript content here');
  });

  it('instructs the AI to write chapters in the target language', () => {
    const prompt = buildChapterSplitPrompt('some transcript', 'Traditional Chinese');
    expect(prompt).toContain('Traditional Chinese');
  });
});

describe('buildTranslatePrompt', () => {
  it('preserves Markdown instruction', () => {
    const prompt = buildTranslatePrompt('# Hello\nSome content', 'Spanish');
    expect(prompt).toMatch(/[Mm]arkdown/);
    expect(prompt).toContain('Spanish');
  });

  it('includes the content to translate', () => {
    const prompt = buildTranslatePrompt('Content to translate here', 'French');
    expect(prompt).toContain('Content to translate here');
  });
});
