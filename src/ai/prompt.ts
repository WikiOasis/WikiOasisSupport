import type { Config } from '../config.js';

function describe(
  heading: string,
  items: { key: string; name: string; prompt: string }[],
  note?: string,
): string {
  const lines = [`## ${heading}`];
  if (note) lines.push(note);
  for (const it of items) {
    const desc = it.prompt.trim();
    lines.push(desc ? `- \`${it.key}\` (${it.name}): ${desc}` : `- \`${it.key}\` (${it.name})`);
  }
  return lines.join('\n');
}

export function buildTriagePrompt(cfg: Config): string {
  const parts: string[] = [];

  const preamble = cfg.prompt.preamble.trim();
  parts.push(
    preamble ||
      'You triage incoming threads in a community support forum. You are precise, ' +
        'conservative, and you never invent detail the reporter did not give you.',
  );

  parts.push(
    describe(
      'Categories',
      cfg.categories,
      `Pick every category that genuinely applies, most relevant first. Pick at most ` +
        `${cfg.max_categories}. If none fit well, pick the single closest one rather than ` +
        `guessing at several.`,
    ),
  );

  parts.push(
    describe(
      'Teams',
      cfg.teams.filter((t) => !t.hidden),
      'Pick every team that needs to act on this thread. Most threads need exactly one. ' +
        'Pick a second only when the work genuinely splits across teams — routing a thread ' +
        'to everyone is the same as routing it to no one.',
    ),
  );

  const byOrder = [...cfg.priorities].sort((a, b) => a.order - b.order);
  parts.push(
    describe(
      'Priorities',
      byOrder,
      'Pick exactly one, using the criteria below. When a thread sits between two levels, ' +
        'choose the lower one unless it clearly meets the higher level\'s criteria — an ' +
        'inbox where everything is urgent has no priorities at all.',
    ),
  );

  parts.push(
    [
      '## Also decide',
      '- `needs_user_response`: true when the report is missing something the team must have ' +
        'before it can start (no wiki name, no URL, no error text, no steps). False when the ' +
        'team can act on what is already written.',
      '- `summary`: one line, at most 140 characters, describing the problem — not the ' +
        'reporter\'s tone and not a restatement of the title. This is what the triage board ' +
        'shows, so write it for someone scanning thirty of them.',
      '- `reasoning`: one or two sentences on why this priority, quoting what in the thread ' +
        'drove it. Shown to staff, not to the reporter.',
      '- `confidence`: 0 to 1, your confidence in the category and priority together. Be ' +
        'honest — a low score routes the thread for human triage instead of hiding a bad guess.',
    ].join('\n'),
  );

  const extra = cfg.prompt.extra.trim();
  if (extra) parts.push(`## House rules\n${extra}`);

  return parts.join('\n\n');
}

export function buildKnownIssuesSection(
  issues: { id: number; title: string; description: string }[],
): string {
  return [
    '## Known issues',
    'These are problems the team already knows about and is working on. If — and only',
    'if — this thread is reporting the SAME problem as one of them, return its id as',
    '`known_issue`. Otherwise return `none`.',
    '',
    'Judge by the symptom the reporter describes, not by the area it touches. Two',
    'different faults in the same extension are not the same issue. A thread that is',
    'merely adjacent to a known issue, or that mentions it while asking about',
    'something else, is `none`. When you are unsure, `none` is the right answer.',
    '',
    ...issues.map((i) => `- \`${i.id}\` (${i.title}): ${i.description.trim()}`),
    '',
    'Set `known_issue_confidence` between 0 and 1 for that call. Use 0 when you',
    'returned `none`.',
  ].join('\n');
}

export function buildRescanSection(current: {
  categories: string[];
  teams: string[];
  priority: string | null;
}): string {
  return [
    '## This thread has already been classified',
    `It currently has categories \`${current.categories.join('`, `') || 'none'}\`, teams`,
    `\`${current.teams.join('`, `') || 'none'}\` and priority \`${current.priority ?? 'none'}\`.`,
    '',
    'You are re-reading it because the conversation has moved on. Classify it as it',
    'stands NOW, based on the whole conversation rather than the opening post — what',
    'someone first reports and what the problem turns out to be are often different.',
    'If the existing labels still fit, return them unchanged; changing a label that',
    'was already right just churns the board.',
  ].join('\n');
}

export function buildResolutionPrompt(cfg: Config): string {
  const extra = cfg.prompt.extra.trim();
  return [
    'You read one message from the person who opened a support thread and decide whether ' +
      'they have said their issue is resolved.',
    '',
    'Say resolved ONLY when the reporter states it themselves. The bar is what they wrote, ' +
      'not what you infer:',
    '- "that fixed it", "working now", "all sorted, thanks" — resolved.',
    '- "thanks, I\'ll try that", "thanks for looking" — NOT resolved. Gratitude is not an outcome.',
    '- "I found a workaround but the bug is still there" — NOT resolved.',
    '- Someone other than the reporter saying it looks fixed — NOT resolved.',
    '- A question, any question, even a cheerful one — NOT resolved.',
    '',
    'When and only when it is resolved, set `quote` to the reporter\'s own words that say so, ' +
      'copied EXACTLY from the message, character for character. Do not paraphrase, do not ' +
      'fix their spelling, do not add quotation marks. Copy the shortest span that carries the ' +
      'meaning. If you cannot copy such a span verbatim, it is not resolved.',
    '',
    'Set `confidence` between 0 and 1. Anything you would not act on yourself belongs below 0.8.',
    ...(extra ? ['', '## House rules', extra] : []),
  ].join('\n');
}
