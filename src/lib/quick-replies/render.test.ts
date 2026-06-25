import { describe, expect, it } from 'vitest';
import { renderQuickReply, type QuickReplyVars } from './render';

const vars: QuickReplyVars = {
  contact: { name: 'Maria Silva', first_name: 'Maria', phone: '+5511999', email: null },
  agent: { name: 'Sérgio', first_name: 'Sérgio' },
};

describe('renderQuickReply', () => {
  it('substitutes contact and agent tokens', () => {
    expect(renderQuickReply('Olá {{contact.name}}, sou {{agent.name}}', vars)).toBe(
      'Olá Maria Silva, sou Sérgio',
    );
  });

  it('tolerates whitespace inside braces', () => {
    expect(renderQuickReply('Oi {{ contact.first_name }}', vars)).toBe('Oi Maria');
  });

  it('resolves a known-but-missing value to empty string', () => {
    expect(renderQuickReply('Email: {{contact.email}}!', vars)).toBe('Email: !');
  });

  it('leaves unknown tokens literal', () => {
    expect(renderQuickReply('{{contact.unknown}} {{order.id}}', vars)).toBe(
      '{{contact.unknown}} {{order.id}}',
    );
  });

  it('leaves content without tokens untouched', () => {
    expect(renderQuickReply('Como posso ajudar?', vars)).toBe('Como posso ajudar?');
  });

  it('handles absent var groups gracefully', () => {
    expect(renderQuickReply('Oi {{contact.name}}', {})).toBe('Oi ');
  });

  it('replaces repeated tokens', () => {
    expect(renderQuickReply('{{agent.name}} & {{agent.name}}', vars)).toBe('Sérgio & Sérgio');
  });
});
