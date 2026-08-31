# WikiOasisSupport

Support-forum triage bot for the WikiOasis Discord.

It watches one forum channel and, for every thread that appears:

- classifies it with the OpenAI API into **categories**, **teams** and one
  **priority**, all of which are defined in config rather than in code;
- applies the matching **category tags** on the forum, so its own tag filter
  works as a queue view — categories are the only thing tagged, since teams,
  priorities and statuses are internal triage state;
- posts a **triage card** in the thread (Components V2) with the classification
  and the buttons staff act on;
- keeps a **triage board** in a staff channel — a bulleted list broken into a
  subsection per team, showing each thread's link, priority, status and whether
  anyone on the team has replied yet;
- points people at the **issue tracker** when a thread is really a bug report;
- tells a reporter when they have hit a **known issue** and asks them to wait —
  then tells them when it is fixed;
- **re-reads a thread** as the conversation develops, and moves the categories
  when the problem turns out not to be what the first post said;
- marks a thread **resolved** when the reporter says so in their own words, and
  when a thread is closed or deleted without anyone telling the bot.

Every message the bot sends uses Discord **Components V2**.

## Configuration

Two inputs, deliberately separated:

| | |
|---|---|
| `/etc/wikioasis-support.env` | Secrets only — bot token, OpenAI key, database password. Mode `0600`. |
| `/etc/wikioasis-support/triage.json` | Everything else. World-readable, diffable, and the only thing you edit to retune the bot. |

In production both are rendered by Salt from `pillar/wikioasis_support` — see
`salt/wikioasis_support/` in the [salt](https://github.com/WikiOasis/salt)
repo. `examples/triage.example.json` is the same shape, filled in, and is what
the tests run against.

### The taxonomy is the prompt

`teams`, `categories` and `priorities` each carry a `prompt` fragment
describing what belongs to them. `src/ai/prompt.ts` merges the preamble, every
fragment, and the closing house rules into the single system prompt the
classifier sees. Nothing about "urgent" or "infrastructure" is hardcoded —
adding a team is a config change, and so is changing what the bot thinks urgent
means.

```jsonc
{
  "teams":      [{ "key": "infra", "name": "Infrastructure", "role_id": "…",
                   "prompt": "The servers behind the farm: outages, 5xx errors, …" }],
  "categories": [{ "key": "bug", "name": "Bug", "teams": ["platform"],
                   "prompt": "A reproducible software fault: …" }],
  "priorities": [{ "key": "urgent", "name": "Urgent", "order": 0, "emoji": "🔴",
                   "prompt": "The farm or a whole wiki is down for everyone, …" }],
  "prompt": { "preamble": "…", "extra": "…" }
}
```

A thread gets **many** categories and **many** teams (`max_categories` caps the
first; Discord's five-applied-tag limit is what caps it in practice) but
**exactly one** priority.

### What is public and what is internal

| | Where it shows |
|---|---|
| **Categories** | Forum tags on the thread, the triage card, and the board |
| **Teams** | Board subsections and the triage card |
| **Priorities** | Board ordering and the card's accent colour |
| **Statuses** | Board rows and the triage card |

Only categories become forum tags. Teams, priorities and statuses are triage
state that staff read on the board — they are not put on the reporter's thread.
That also means all but one of Discord's five applied-tag slots are available
for categories, and the last is left free for a tag someone adds by hand (the
bot never evicts a manual tag to make room for its own).

### Redirecting a category elsewhere

Any category can carry a `redirect`. When it is applied, the bot posts a notice
addressed to the reporter with a link button. The example config uses it to
send bug reports to Phorge, but nothing here is Phorge-specific — the URL,
wording, button label and colour are all config, so the same mechanism handles
feature requests or security reports.

```jsonc
"redirect": {
  "url": "https://issue-tracker.wikioasis.org/…",
  "title": "This looks like a bug report",
  "message": "Please file it on Phorge so it gets a task number …",
  "button_label": "File it on Phorge",
  "once": true,                 // never repost on re-triage
  "set_waiting_on_user": true   // it is now their move
}
```

### Who counts as support

`support_roles` plus every team's `role_id`. A holder of any of them can use
the buttons and slash commands; their replies flip a thread to *waiting on
user* and satisfy the board's "has anyone replied?" column.

## Known issues

The team keeps a list of things already being worked on, so the tenth report of
the same outage gets an answer instead of a queue position:

```
/knownissue add title:"Search is down" description:"Search returns no results on every wiki."
                 advice:"Editing is unaffected." url:"https://phorge…/T123"
/knownissue list · show · edit · resolve · reopen · remove
```

When a thread is **opened**, its classification also checks it against the
active issues. A match posts a notice naming the issue, asks the reporter to
wait, and (by default) moves the thread to *waiting on user* so it leaves the
team's queue without being closed. `/knownissue resolve` retires the issue and
posts an update into every open thread that matched it — the other half of
"please be patient" is telling people when it is over.

Two things worth knowing:

- **Entries live in the database, not in the triage config.** That file is
  rendered from pillar on every highstate, so anything a slash command wrote to
  it would be reverted. The *settings* — the wording, the colour, whether to
  notify on resolve — are pillar; the *entries* are data.
- **Matching happens at open only.** Adding an issue does not reach back over
  threads that are already open.

## Rescanning

What a thread is about is often not what its first post said. The bot re-reads
a thread and moves its categories when the conversation has changed them.

This is **driven by new messages in that thread** — there is no sweep and no
timer. Two gates stop it becoming a model call per reply: `min_new_messages`
since the labels were last decided, and a `cooldown_minutes` floor on how often
one thread can be re-read however fast it is moving. `rescan.updates` controls
which labels a rescan may move (categories and teams by default; priority is
left out because an escalation is usually a human judgement), and threads
someone has corrected with `/triage set` are left alone unless
`override_manual` is on.

`/triage rescan` does it immediately, ignoring both gates.

## How a thread moves

```
opened ─▶ classified ─▶ waiting on team ⇄ waiting on user ─▶ resolved
                              ▲                                   │
                              └──── reporter replies ─────────────┘
```

- A **reporter** message sets *waiting on team* — and reopens a resolved thread,
  which is the cheapest possible "actually, it's back".
- A **staff** message sets *waiting on user* and records the first reply time.
- **Resolution** is detected only on the reporter's own messages, and only
  passes two gates: the model must be confident (`resolution.min_confidence`)
  *and* it must quote the reporter verbatim. The quote is checked against the
  real message text, so a paraphrase or an invented sign-off is discarded and
  the thread stays open.
- A thread **closed or deleted** without being resolved is caught by the
  reconciler (on startup and hourly). A closed thread gets a message saying it
  has been marked resolved, then is re-archived; a deleted one is closed out
  silently, because there is nowhere to post.

## Commands

| | |
|---|---|
| `/triage board` | Rebuild the board now |
| `/triage retriage` | Re-run the classifier on this thread |
| `/triage rescan` | Re-read the whole thread now and update its categories |
| `/triage set` | Override priority / category / team |
| `/triage resolve` · `/triage reopen` | Close or reopen |
| `/triage status` | What the bot knows about this thread |

Buttons on the triage card cover claim/release, waiting-on-user, resolve and
re-triage. The reporter — and only the reporter — gets a **Not resolved**
button on the resolution notice.

## Discord setup

- **Privileged intent:** Message Content. Without it every message arrives
  empty and neither classification nor resolution detection can see anything.
- **Permissions** in the forum: View Channel, Send Messages in Threads, Manage
  Messages (to pin the triage card), Manage Threads (to archive), and Manage
  Channels *if* `manage_tags` is on, which is what lets the bot create the
  category tags.
- **Board channel:** staff-only. The board names who has and has not replied.

## Development

```bash
npm install
cp .env.example .env      # fill in the three secrets
npm run typecheck
npm run smoke             # offline: config, prompt merge, board limits, tag budget
npm run dev               # tsx watch
```

`npm run smoke` needs no Discord, no OpenAI and no database. It asserts that
every configured prompt fragment reaches the model, that the rendered board
stays inside Discord's per-message limits (40 components, 4000 characters),
that only category tags are ever applied and a manual tag is never evicted, and
that the rescan gate fires on the cases it should and none of the ones it
should not. The board limits are enforced server-side with a 400, so getting
them wrong is otherwise invisible until the board silently stops updating.

## Licence

GPL-3.0-or-later, matching the rest of the WikiOasis stack.
