import {
  MessageCircle,
  Camera,
  MessagesSquare,
  type LucideIcon,
} from 'lucide-react';
import type { ChannelType } from '@/types';

/**
 * UI-side channel registry — the single source that drives the inbox
 * settings: the "new inbox" channel picker, per-channel icons/labels, and
 * which channels can actually be created today.
 *
 * Mirrors Chatwoot's `INBOX_TYPES` + `inboxMixin`: adding a channel is a new
 * entry here (+ its connect form / connection panel). `status: 'coming_soon'`
 * renders a disabled card so the roadmap is visible without the API
 * accepting it yet (see IMPLEMENTED_CHANNELS in /api/inboxes).
 */

export type ChannelStatus = 'available' | 'coming_soon';

export interface ChannelDef {
  type: ChannelType;
  label: string;
  icon: LucideIcon;
  status: ChannelStatus;
  /** Short blurb shown under the channel name in the picker. */
  description: string;
  /** Tailwind classes for the channel's accent (icon chip). */
  accent: string;
}

export const CHANNELS: Record<ChannelType, ChannelDef> = {
  whatsapp: {
    type: 'whatsapp',
    label: 'WhatsApp',
    icon: MessageCircle,
    status: 'available',
    description: 'Conecte um número do WhatsApp Cloud API (Meta).',
    accent: 'bg-emerald-500/10 text-emerald-600',
  },
  instagram: {
    type: 'instagram',
    label: 'Instagram',
    icon: Camera,
    status: 'coming_soon',
    description: 'Receba DMs do Instagram. Em breve.',
    accent: 'bg-pink-500/10 text-pink-600',
  },
  messenger: {
    type: 'messenger',
    label: 'Messenger',
    icon: MessagesSquare,
    status: 'coming_soon',
    description: 'Converse pelo Facebook Messenger. Em breve.',
    accent: 'bg-blue-500/10 text-blue-600',
  },
};

/** Ordered list for the picker (available first, then coming soon). */
export const CHANNEL_LIST: ChannelDef[] = Object.values(CHANNELS).sort((a, b) =>
  a.status === b.status ? 0 : a.status === 'available' ? -1 : 1,
);

export function channelDef(type: ChannelType | string): ChannelDef | undefined {
  return CHANNELS[type as ChannelType];
}
