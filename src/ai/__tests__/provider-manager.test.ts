import { describe, it, expect } from 'vitest';
import { resolveProvider } from '../provider-manager';
import type { UserSettings } from '@/types';

function makeSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    tier: 'free',
    defaultMode: 'structured',
    monthlyUsage: { imports: 0, aiCalls: 0, resetDate: '2026-04-01' },
    ...overrides,
  };
}

describe('resolveProvider', () => {
  it('returns NoAI when free tier and no BYOK', () => {
    const provider = resolveProvider(makeSettings());
    expect(provider.name).toBe('no-ai');
  });

  it('returns OpenAI when BYOK with openai key', () => {
    const provider = resolveProvider(
      makeSettings({
        byok: { provider: 'openai', apiKey: 'sk-test-key' },
      }),
    );
    expect(provider.name).toBe('openai-direct');
  });

  it('returns Anthropic when BYOK with anthropic key', () => {
    const provider = resolveProvider(
      makeSettings({
        byok: { provider: 'anthropic', apiKey: 'sk-ant-test-key' },
      }),
    );
    expect(provider.name).toBe('anthropic-direct');
  });

  it('returns builtin for pro tier with auth token', () => {
    const provider = resolveProvider(makeSettings({ tier: 'pro' }), 'auth-token-123');
    expect(provider.name).toBe('builtin');
  });

  it('prefers BYOK over builtin even for pro', () => {
    const provider = resolveProvider(
      makeSettings({
        tier: 'pro',
        byok: { provider: 'openai', apiKey: 'sk-test-key' },
      }),
      'auth-token-123',
    );
    expect(provider.name).toBe('openai-direct');
  });

  it('returns NoAI for pro tier without auth token and no BYOK', () => {
    const provider = resolveProvider(makeSettings({ tier: 'pro' }));
    expect(provider.name).toBe('no-ai');
  });
});
