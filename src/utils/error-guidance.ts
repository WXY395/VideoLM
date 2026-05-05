const GUIDANCE_MARKER = 'Next step:';

export function formatImportError(error?: string): string {
  const message = (error || 'Import failed.').trim();
  if (message.includes(GUIDANCE_MARKER)) return message;

  const lower = message.toLowerCase();
  let guidance = '';

  if (lower.includes('quota')) {
    guidance = 'Open Settings to check your plan and remaining quota.';
  } else if (lower.includes('no notebook') || lower.includes('notebook found')) {
    guidance = 'open a NotebookLM notebook, make sure you are signed in, then retry.';
  } else if (lower.includes('connect') || lower.includes('login') || lower.includes('sign in')) {
    guidance = 'Open NotebookLM, sign in with the same Google account, then retry.';
  } else if (lower.includes('extension context') || lower.includes('updated')) {
    guidance = 'Refresh the YouTube or NotebookLM page, then retry.';
  }

  return guidance ? `${message} ${GUIDANCE_MARKER} ${guidance}` : message;
}
