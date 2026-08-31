import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import type { Env } from '../config.js';
import { log } from '../logger.js';

let client: OpenAI | undefined;

export function initOpenAI(env: Env): OpenAI {
  client = new OpenAI({
    apiKey: env.openaiApiKey,
    ...(env.openaiBaseUrl ? { baseURL: env.openaiBaseUrl } : {}),
    maxRetries: 3,
    timeout: 120_000,
  });
  return client;
}

export function openai(): OpenAI {
  if (!client) throw new Error('OpenAI client used before initOpenAI()');
  return client;
}

export interface ParseOptions {
  model: string;
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  system: string;
  input: string;
  schemaName: string;
}

export async function parseStructured<T extends z.ZodType>(
  schema: T,
  opts: ParseOptions,
): Promise<z.infer<T> | null> {
  try {
    const res = await openai().responses.parse({
      model: opts.model,
      reasoning: { effort: opts.effort },
      input: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.input },
      ],
      text: { format: zodTextFormat(schema, opts.schemaName) },
    });

    if (res.status === 'incomplete') {
      log.warn('model response incomplete', {
        schema: opts.schemaName,
        reason: res.incomplete_details?.reason,
      });
      return null;
    }
    if (res.output_parsed == null) {
      log.warn('model returned no parseable output', {
        schema: opts.schemaName,
        status: res.status,
      });
      return null;
    }
    log.debug('model call complete', {
      schema: opts.schemaName,
      model: opts.model,
      inputTokens: res.usage?.input_tokens,
      outputTokens: res.usage?.output_tokens,
    });
    return res.output_parsed as z.infer<T>;
  } catch (err) {
    if (err instanceof OpenAI.AuthenticationError) {
      log.error('OpenAI rejected the API key', { err });
    } else if (err instanceof OpenAI.NotFoundError) {
      log.error('OpenAI model not found — check `model` in the triage config', {
        model: opts.model,
        err,
      });
    } else if (err instanceof OpenAI.RateLimitError) {
      log.warn('OpenAI rate limited', { schema: opts.schemaName });
    } else if (err instanceof OpenAI.APIConnectionError) {
      log.warn('could not reach OpenAI', { schema: opts.schemaName, err });
    } else if (err instanceof OpenAI.APIError) {
      log.error('OpenAI API error', { schema: opts.schemaName, status: err.status, err });
    } else {
      log.error('unexpected error calling OpenAI', { schema: opts.schemaName, err });
    }
    return null;
  }
}
