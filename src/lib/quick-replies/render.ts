/**
 * Variable substitution for quick replies ("mensagens prontas").
 *
 * Content may carry `{{contact.name}}` / `{{agent.first_name}}` tokens that
 * are resolved at insert time (when the agent picks the reply in the
 * composer), not at save time. Surrounding whitespace inside the braces is
 * tolerated (`{{ contact.name }}`); keys are case-sensitive.
 *
 * Unknown tokens are left literal so authors notice typos rather than
 * silently shipping a blank. A known token whose value is missing/empty
 * resolves to an empty string.
 */

export interface QuickReplyVars {
  contact?: {
    name?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
    email?: string | null;
  };
  agent?: {
    name?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
  };
}

/** Tokens we recognise. Anything outside this set is left untouched. */
const KNOWN_KEYS = new Set([
  'contact.name',
  'contact.first_name',
  'contact.last_name',
  'contact.phone',
  'contact.email',
  'agent.name',
  'agent.first_name',
  'agent.last_name',
  'agent.email',
]);

const TOKEN_RE = /\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g;

export function renderQuickReply(content: string, vars: QuickReplyVars): string {
  return content.replace(TOKEN_RE, (match, key: string) => {
    if (!KNOWN_KEYS.has(key)) return match; // unknown → leave literal
    const [group, field] = key.split('.') as ['contact' | 'agent', string];
    const source = vars[group] as Record<string, string | null | undefined> | undefined;
    const value = source?.[field];
    return value ?? ''; // known but missing → empty
  });
}
