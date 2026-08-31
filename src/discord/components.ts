import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';

export const V2_FLAGS = MessageFlags.IsComponentsV2 as const;

export const MAX_COMPONENTS = 40;
export const MAX_TEXT_CHARS = 4000;

export const colourToInt = (hex: string): number => parseInt(hex.replace('#', ''), 16);

export const text = (content: string): TextDisplayBuilder =>
  new TextDisplayBuilder().setContent(content);

export const separator = (large = false): SeparatorBuilder =>
  new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);

export function container(accent: string | null, ...parts: (TextDisplayBuilder | SeparatorBuilder)[]): ContainerBuilder {
  const c = new ContainerBuilder();
  if (accent) c.setAccentColor(colourToInt(accent));
  for (const p of parts) {
    if (p instanceof TextDisplayBuilder) c.addTextDisplayComponents(p);
    else c.addSeparatorComponents(p);
  }
  return c;
}

export const linkButton = (label: string, url: string): ButtonBuilder =>
  new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label.slice(0, 80)).setURL(url);

export const button = (
  id: string,
  label: string,
  style: ButtonStyle = ButtonStyle.Secondary,
): ButtonBuilder =>
  new ButtonBuilder().setCustomId(id).setLabel(label.slice(0, 80)).setStyle(style);

export const row = (...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

export const relative = (d: Date): string => `<t:${Math.floor(d.getTime() / 1000)}:R>`;

export function age(since: Date, now = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - since.getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + '…';
}

export const escapeLinkText = (s: string): string => s.replace(/([[\]()\\])/g, '\\$1');
