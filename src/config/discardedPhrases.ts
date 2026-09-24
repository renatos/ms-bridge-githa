import { env } from './index.js';

export const DEFAULT_DISCARDED_PHRASES: string[] = [
  '[Mensagem recebida]',
  '[Mensagem]',
];

/**
 * Checks if a message text is in the list of phrases that should be discarded
 * and NOT forwarded to the githa-backend lead incoming endpoint.
 * Comparison is case-insensitive and trims whitespace.
 */
export function isMessageDiscarded(message: string | null | undefined): boolean {
  if (!message) return true;
  const trimmed = message.trim().toLowerCase();
  if (!trimmed) return true;

  const inDefault = DEFAULT_DISCARDED_PHRASES.some(
    phrase => phrase.trim().toLowerCase() === trimmed
  );
  if (inDefault) return true;

  if (env.DISCARDED_LEAD_PHRASES) {
    const customList = env.DISCARDED_LEAD_PHRASES.split(',')
      .map(p => p.trim().toLowerCase())
      .filter(p => p.length > 0);
    if (customList.includes(trimmed)) {
      return true;
    }
  }

  return false;
}
