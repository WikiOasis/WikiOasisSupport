import { z } from 'zod';
import type { Config } from '../config.js';
import type { KnownIssue } from '../db/knownIssues.js';
import { buildKnownIssuesSection, buildRescanSection, buildTriagePrompt } from './prompt.js';
import { parseStructured } from './client.js';
import { log } from '../logger.js';

export interface TriageInput {
  title: string;
  body: string;
  authorTag: string;
  attachments: string[];
  conversation?: { author: string; staff: boolean; content: string }[];
  current?: { categories: string[]; teams: string[]; priority: string | null };
}

export interface TriageResult {
  categories: string[];
  teams: string[];
  priority: string;
  summary: string;
  reasoning: string;
  needsUserResponse: boolean;
  confidence: number;
  knownIssueId: number | null;
}

function schemaFor(cfg: Config, issues: KnownIssue[]) {
  const categoryKeys = cfg.categories.map((c) => c.key) as [string, ...string[]];
  const teamKeys = cfg.teams.filter((t) => !t.hidden).map((t) => t.key) as [string, ...string[]];
  const priorityKeys = cfg.priorities.map((p) => p.key) as [string, ...string[]];

  const base = {
    categories: z.array(z.enum(categoryKeys)),
    teams: z.array(z.enum(teamKeys)),
    priority: z.enum(priorityKeys),
    summary: z.string(),
    reasoning: z.string(),
    needs_user_response: z.boolean(),
    confidence: z.number(),
  };

  if (issues.length === 0) return z.object(base);

  const issueKeys = ['none', ...issues.map((i) => String(i.id))] as [string, ...string[]];
  return z.object({
    ...base,
    known_issue: z.enum(issueKeys),
    known_issue_confidence: z.number(),
  });
}

interface ParsedTriage {
  categories: string[];
  teams: string[];
  priority: string;
  summary: string;
  reasoning: string;
  needs_user_response: boolean;
  confidence: number;
  known_issue?: string;
  known_issue_confidence?: number;
}

function renderInput(input: TriageInput): string {
  const parts = [
    `Thread title: ${input.title}`,
    `Opened by: ${input.authorTag}`,
    '',
    'Opening post:',
    input.body.trim() || '(the reporter posted no text)',
  ];
  if (input.attachments.length) {
    parts.push('', `Attachments: ${input.attachments.join(', ')}`);
  }
  if (input.conversation?.length) {
    parts.push('', 'Conversation since:');
    for (const m of input.conversation) {
      parts.push(`[${m.staff ? 'support' : m.author}] ${m.content}`);
    }
  }
  return parts.join('\n');
}

export async function triageThread(
  cfg: Config,
  input: TriageInput,
  issues: KnownIssue[] = [],
): Promise<TriageResult | null> {
  const sections = [buildTriagePrompt(cfg)];
  if (issues.length) sections.push(buildKnownIssuesSection(issues));
  if (input.current) sections.push(buildRescanSection(input.current));

  const parsed = (await parseStructured(schemaFor(cfg, issues), {
    model: cfg.model,
    effort: cfg.effort,
    system: sections.join('\n\n'),
    input: renderInput(input),
    schemaName: 'triage',
  })) as ParsedTriage | null;
  if (!parsed) return null;

  const categories = dedupe(parsed.categories).slice(0, cfg.max_categories);
  let teams = dedupe(parsed.teams);

  if (teams.length === 0) {
    const routed = new Set<string>();
    for (const key of categories) {
      const cat = cfg.categories.find((c) => c.key === key);
      for (const t of cat?.teams ?? []) routed.add(t);
    }
    teams = routed.size > 0 ? [...routed] : [cfg.teams[0]!.key];
    log.info('model returned no team; routed by category', { categories, teams });
  }

  let knownIssueId: number | null = null;
  if (parsed.known_issue && parsed.known_issue !== 'none') {
    const confidence = Math.min(1, Math.max(0, parsed.known_issue_confidence ?? 0));
    if (confidence >= cfg.known_issues.min_confidence) {
      const id = Number(parsed.known_issue);
      knownIssueId = issues.some((i) => i.id === id) ? id : null;
      if (knownIssueId === null) {
        log.warn('model returned an unknown known-issue id', { returned: parsed.known_issue });
      }
    } else {
      log.info('known-issue match below confidence threshold; ignoring', {
        confidence,
        threshold: cfg.known_issues.min_confidence,
      });
    }
  }

  return {
    categories: categories.length ? categories : [cfg.categories[0]!.key],
    teams,
    priority: parsed.priority,
    summary: parsed.summary.slice(0, 200).trim(),
    reasoning: parsed.reasoning.slice(0, 500).trim(),
    needsUserResponse: parsed.needs_user_response,
    confidence: Math.min(1, Math.max(0, parsed.confidence)),
    knownIssueId,
  };
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];
