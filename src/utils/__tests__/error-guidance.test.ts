import { describe, expect, it } from 'vitest';
import { formatImportError } from '../error-guidance';

describe('formatImportError', () => {
  it('adds a NotebookLM login hint when connection fails', () => {
    expect(formatImportError('Cannot connect to NotebookLM. Please check your login.')).toContain('sign in');
  });

  it('adds a notebook-open hint when no notebook is available', () => {
    expect(formatImportError('No notebook found. Please open NotebookLM or try again.')).toContain('open a NotebookLM notebook');
  });

  it('adds a quota hint when quota is exceeded', () => {
    expect(formatImportError('Monthly import quota exceeded.')).toContain('Settings');
  });

  it('does not duplicate guidance if the message already includes a next step', () => {
    const message = 'No notebook found. Next step: open a NotebookLM notebook.';
    expect(formatImportError(message)).toBe(message);
  });
});
