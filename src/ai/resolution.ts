import { z } from 'zod';
import type { Config } from '../config.js';
import { buildResolutionPrompt } from './prompt.js';
import { parseStructured } from './client.js';
import { log } from '../logger.js';

const ResolutionSchema = z.object({
  resolved: z.boolean(),
  quote: z.string().nullable(),
  confidence: z.number(),
});

export interface ResolutionResult {
  resolved: boolean;
  quote: string;
  confidence: number;
}

const normalise = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function looksLikeResolution(cfg: Config, content: string): boolean {
  if (!cfg.resolution.prefilter) return true;
  const haystack = normalise(content);
  return cfg.resolution.prefilter_patterns.some((p) => haystack.includes(p.toLowerCase().trim()));
}

export async function detectResolution(
  cfg: Config,
  message: { content: string; threadTitle: string },
): Promise<ResolutionResult | null> {
  const parsed = await parseStructured(ResolutionSchema, {
    model: cfg.model,
    effort: cfg.effort,
    system: buildResolutionPrompt(cfg),
    input: [
      `Thread title: ${message.threadTitle}`,
      '',
      'Message from the person who opened the thread:',
      message.content,
    ].join('\n'),
    schemaName: 'resolution',
  });
  if (!parsed) return null;
  if (!parsed.resolved) return { resolved: false, quote: '', confidence: parsed.confidence };

  if (parsed.confidence < cfg.resolution.min_confidence) {
    log.info('resolution below confidence threshold; leaving thread open', {
      confidence: parsed.confidence,
      threshold: cfg.resolution.min_confidence,
    });
    return { resolved: false, quote: '', confidence: parsed.confidence };
  }

  const quote = (parsed.quote ?? '').trim();
  if (!quote) {
    log.warn('model called it resolved but quoted nothing; leaving thread open');
    return { resolved: false, quote: '', confidence: parsed.confidence };
  }

  if (!normalise(message.content).includes(normalise(quote))) {
    log.warn('model quote is not present in the message; discarding detection', {
      quote,
    });
    return { resolved: false, quote: '', confidence: parsed.confidence };
  }

  return { resolved: true, quote, confidence: parsed.confidence };
}
