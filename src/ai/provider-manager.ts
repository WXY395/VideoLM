import type { AIProvider, UserSettings } from '@/types';
import { OpenAIDirectProvider } from './providers/openai-direct';
import { AnthropicDirectProvider } from './providers/anthropic-direct';
import { BuiltinProvider } from './providers/builtin';
import { NoAIProvider } from './providers/no-ai';

/**
 * Resolve the active AI provider based on user settings and auth state.
 *
 * Priority:
 *   1. BYOK (if API key is configured) -- available for both free and pro users
 *   2. Builtin backend (if pro tier + valid auth token)
 *   3. NoAI fallback
 */
export function resolveProvider(settings: UserSettings, authToken?: string): AIProvider {
  // 1. BYOK takes highest priority
  if (settings.byok?.apiKey) {
    const { provider, apiKey, model } = settings.byok;

    if (provider === 'openai') {
      return new OpenAIDirectProvider(apiKey, model);
    }

    if (provider === 'anthropic') {
      return new AnthropicDirectProvider(apiKey, model);
    }
  }

  // 2. Pro users with a valid auth token get the builtin backend
  if (settings.tier === 'pro' && authToken) {
    return new BuiltinProvider(authToken);
  }

  // 3. Fallback
  return new NoAIProvider();
}
