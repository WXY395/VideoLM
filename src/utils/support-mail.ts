interface SupportMailInput {
  to: string;
  extensionVersion: string;
  diagnosticsText: string;
}

export function buildSupportMailtoUrl(input: SupportMailInput): string {
  const subject = `VideoLM Support Request v${input.extensionVersion}`;
  const body = [
    'What happened?',
    '',
    '',
    'Steps to reproduce',
    '1. ',
    '2. ',
    '3. ',
    '',
    'Expected result',
    '',
    '',
    'Actual result',
    '',
    '',
    'Diagnostics',
    '```json',
    input.diagnosticsText,
    '```',
  ].join('\n');

  return `mailto:${input.to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
