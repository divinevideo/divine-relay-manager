# NIP-22 Comment Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give moderators full NIP-22 comment context on the report surfaces — what a comment is attached to, whether an account sprayed across many targets, and the comments left on a reported video — closing issue #164.

**Architecture:** Two independent improvements. (A) recent-content context adds a per-card spray roll-up and a per-row "on \<parent\>" link into the internal Events tab, backed by a batched title-resolution hook. (B) reported-content context extends `ThreadModal` to load and nest NIP-22 kind-1111 comments. New pure logic lives in `src/lib/`, the hook in `src/hooks/`, and one shared link component in `src/components/`.

**Tech Stack:** React 18 + TypeScript, TanStack Query 5, @nostrify/nostrify + @nostrify/react, nostr-tools (nip19), react-router-dom, Vitest + @testing-library/react.

## Global Constraints

- Do not truncate Nostr ids: full 64-hex for pubkeys/event ids in any value used for lookups; only slice for display labels.
- Reposter/reporter/commenter-authored tag values are untrusted: validate an event id is 64-hex and an address coordinate is `kind:pubkey:d` (numeric kind, 64-hex pubkey) before using it in a filter or an encoded link.
- Internal event links target `/events?event=<nevent|naddr>` (reuse the Events tab), never the public page.
- Reuse `eventAddress()` (`src/lib/threadFilters.ts`), `isHex64()` (`src/lib/constants.ts`), `isVideoKind()`/`VIDEO_KINDS` (`src/lib/kindNames.ts`), `getCommentTarget()`/`summarizeCommentActivity()` (`src/lib/commentActivity.ts`) — do not re-implement.
- Run `npx tsc --noEmit` and `npx vitest run <touched test files>` after each task. The worktree root is `/Users/mjb/code/divine-relay-manager/.claude/worktrees/feat+comment-context`; run frontend commands from there.
- Commit after every task. No `Co-Authored-By` lines.

---

### Task 1: `eventTitles.ts` — pure target parsing / encoding / title extraction / filters

**Files:**
- Create: `src/lib/eventTitles.ts`
- Test: `src/lib/eventTitles.test.ts`

**Interfaces:**
- Consumes: `isHex64` from `@/lib/constants`; `nip19` from `nostr-tools`; `NostrEvent`, `NostrFilter` from `@nostrify/nostrify`.
- Produces:
  - `type ParsedTarget = { kind: 'id'; id: string } | { kind: 'address'; addressKind: number; pubkey: string; identifier: string }`
  - `parseCommentTarget(target: string): ParsedTarget | null`
  - `encodeTarget(parsed: ParsedTarget): string`
  - `extractEventTitle(event: Pick<NostrEvent, 'kind' | 'content' | 'tags'>): string`
  - `buildTitleFilters(targets: string[]): NostrFilter[]`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/eventTitles.test.ts
// ABOUTME: Tests pure target parsing/encoding/title-extraction for comment parents (#164 A)

import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import {
  parseCommentTarget,
  encodeTarget,
  extractEventTitle,
  buildTitleFilters,
} from './eventTitles';

const PK = 'b'.repeat(64);
const ID = 'c'.repeat(64);

describe('parseCommentTarget', () => {
  it('parses a 64-hex event id', () => {
    expect(parseCommentTarget(ID)).toEqual({ kind: 'id', id: ID });
  });

  it('parses a kind:pubkey:d address coordinate', () => {
    expect(parseCommentTarget(`34236:${PK}:my-video`)).toEqual({
      kind: 'address', addressKind: 34236, pubkey: PK, identifier: 'my-video',
    });
  });

  it('parses an addressable coordinate with an empty d-tag', () => {
    expect(parseCommentTarget(`34235:${PK}:`)).toEqual({
      kind: 'address', addressKind: 34235, pubkey: PK, identifier: '',
    });
  });

  it('rejects malformed targets (untrusted commenter tags)', () => {
    expect(parseCommentTarget('')).toBeNull();
    expect(parseCommentTarget('garbage')).toBeNull();
    expect(parseCommentTarget(`notakind:${PK}:d`)).toBeNull();
    expect(parseCommentTarget('34236:shortpubkey:d')).toBeNull();
    expect(parseCommentTarget(`34236:${PK}`)).toBeNull(); // 2-segment, no d
  });
});

describe('encodeTarget', () => {
  it('encodes an id target as nevent', () => {
    const encoded = encodeTarget({ kind: 'id', id: ID });
    const decoded = nip19.decode(encoded);
    expect(decoded.type).toBe('nevent');
  });

  it('encodes an address target as naddr round-trip', () => {
    const encoded = encodeTarget({ kind: 'address', addressKind: 34236, pubkey: PK, identifier: 'my-video' });
    const decoded = nip19.decode(encoded);
    expect(decoded.type).toBe('naddr');
    expect(decoded.data).toMatchObject({ kind: 34236, pubkey: PK, identifier: 'my-video' });
  });
});

describe('extractEventTitle', () => {
  it('prefers the title tag', () => {
    expect(extractEventTitle({ kind: 34236, content: 'body', tags: [['title', 'Cute Puppies']] }))
      .toBe('Cute Puppies');
  });

  it('falls back to a trimmed content snippet when there is no title tag', () => {
    expect(extractEventTitle({ kind: 1, content: '  hello world  ', tags: [] })).toBe('hello world');
  });

  it('truncates a long content snippet to 60 chars with an ellipsis', () => {
    const long = 'x'.repeat(100);
    const out = extractEventTitle({ kind: 1, content: long, tags: [] });
    expect(out).toBe('x'.repeat(60) + '…');
  });

  it('returns empty string when there is neither title nor content', () => {
    expect(extractEventTitle({ kind: 34236, content: '', tags: [] })).toBe('');
  });
});

describe('buildTitleFilters', () => {
  it('groups id targets into one ids filter and each address into its own filter', () => {
    const filters = buildTitleFilters([ID, `34236:${PK}:my-video`]);
    expect(filters).toContainEqual({ ids: [ID] });
    expect(filters).toContainEqual({ kinds: [34236], authors: [PK], '#d': ['my-video'], limit: 1 });
  });

  it('drops malformed targets and returns [] when nothing is valid', () => {
    expect(buildTitleFilters(['garbage', ''])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/eventTitles.test.ts`
Expected: FAIL — module `./eventTitles` not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/eventTitles.ts
// ABOUTME: Pure helpers to parse a NIP-22 comment's parent target (id or address),
// ABOUTME: encode it for an internal link, extract a display title, and batch-fetch

import { nip19 } from 'nostr-tools';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { isHex64 } from '@/lib/constants';

export type ParsedTarget =
  | { kind: 'id'; id: string }
  | { kind: 'address'; addressKind: number; pubkey: string; identifier: string };

/**
 * Parse a comment target (from getCommentTarget): a 64-hex event id, or a
 * `kind:pubkey:d` address coordinate. Targets come from commenter-authored
 * tags, so both shapes are validated (numeric kind, 64-hex pubkey) before use.
 */
export function parseCommentTarget(target: string): ParsedTarget | null {
  if (isHex64(target)) return { kind: 'id', id: target };
  const parts = target.split(':');
  if (parts.length >= 3 && /^\d+$/.test(parts[0]) && isHex64(parts[1])) {
    return {
      kind: 'address',
      addressKind: Number(parts[0]),
      pubkey: parts[1],
      // d-tags may contain ':' — rejoin the remainder
      identifier: parts.slice(2).join(':'),
    };
  }
  return null;
}

/** nevent for an id target, naddr for an address target — for /events?event= links. */
export function encodeTarget(parsed: ParsedTarget): string {
  return parsed.kind === 'id'
    ? nip19.neventEncode({ id: parsed.id })
    : nip19.naddrEncode({ kind: parsed.addressKind, pubkey: parsed.pubkey, identifier: parsed.identifier });
}

/** Human title for a parent event: title tag, else a trimmed 60-char content snippet. */
export function extractEventTitle(event: Pick<NostrEvent, 'kind' | 'content' | 'tags'>): string {
  const title = event.tags.find(t => t[0] === 'title')?.[1];
  if (title && title.trim()) return title.trim();
  const snippet = event.content.trim();
  if (!snippet) return '';
  return snippet.length > 60 ? snippet.slice(0, 60) + '…' : snippet;
}

/** One batched query for a set of targets: ids grouped, each address its own filter. */
export function buildTitleFilters(targets: string[]): NostrFilter[] {
  const ids: string[] = [];
  const filters: NostrFilter[] = [];
  for (const target of targets) {
    const parsed = parseCommentTarget(target);
    if (!parsed) continue;
    if (parsed.kind === 'id') {
      ids.push(parsed.id);
    } else {
      filters.push({ kinds: [parsed.addressKind], authors: [parsed.pubkey], '#d': [parsed.identifier], limit: 1 });
    }
  }
  if (ids.length) filters.unshift({ ids });
  return filters;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/eventTitles.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/eventTitles.ts src/lib/eventTitles.test.ts
git commit -m "feat(reports): pure helpers for comment-parent target parsing and titles (#164)"
```

---

### Task 2: `useEventTitles` hook — batched resolution with graceful degradation

**Files:**
- Create: `src/hooks/useEventTitles.ts`
- Test: `src/hooks/useEventTitles.test.ts`

**Interfaces:**
- Consumes: Task 1 (`parseCommentTarget`, `encodeTarget`, `extractEventTitle`, `buildTitleFilters`); `useNostr` from `@nostrify/react`; `useQuery` from `@tanstack/react-query`; `eventAddress` from `@/lib/threadFilters`.
- Produces:
  - `interface ResolvedTarget { target: string; title: string; encoded: string; kind?: number }`
  - `useEventTitles(targets: string[], apiUrl?: string): { titles: Map<string, ResolvedTarget>; isLoading: boolean }`
  - Exported pure builder for testing: `buildResolvedMap(targets: string[], events: NostrEvent[]): Map<string, ResolvedTarget>`

Every requested (parseable) target always has a map entry: a degraded fallback (short id / coordinate as title, still encoded/linkable) that is overwritten when the event resolves.

- [ ] **Step 1: Write the failing test** (pure `buildResolvedMap`; the hook wrapper is exercised in the card tests)

```typescript
// src/hooks/useEventTitles.test.ts
// ABOUTME: Tests the pure resolved-map builder behind useEventTitles (#164 A)

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { buildResolvedMap } from './useEventTitles';

const PK = 'b'.repeat(64);
const ID = 'c'.repeat(64);

function ev(over: Partial<NostrEvent>): NostrEvent {
  return { id: 'a'.repeat(64), pubkey: PK, kind: 1, content: '', tags: [], created_at: 1, sig: 'f'.repeat(128), ...over };
}

describe('buildResolvedMap', () => {
  it('resolves an id target to the fetched event title + kind', () => {
    const map = buildResolvedMap([ID], [ev({ id: ID, kind: 34236, tags: [['title', 'Puppies']] })]);
    const r = map.get(ID)!;
    expect(r.title).toBe('Puppies');
    expect(r.kind).toBe(34236);
    expect(r.encoded.startsWith('nevent1')).toBe(true);
  });

  it('resolves an address target by matching kind+pubkey+d', () => {
    const coord = `34236:${PK}:vid1`;
    const map = buildResolvedMap([coord], [ev({ kind: 34236, tags: [['d', 'vid1'], ['title', 'My Video']] })]);
    const r = map.get(coord)!;
    expect(r.title).toBe('My Video');
    expect(r.encoded.startsWith('naddr1')).toBe(true);
  });

  it('degrades unresolved id target to a short-id title, still encoded/linkable', () => {
    const map = buildResolvedMap([ID], []);
    const r = map.get(ID)!;
    expect(r.title).toContain(ID.slice(0, 8));
    expect(r.encoded.startsWith('nevent1')).toBe(true);
  });

  it('degrades unresolved address target to the coordinate, still encoded', () => {
    const coord = `34236:${PK}:vid1`;
    const map = buildResolvedMap([coord], []);
    const r = map.get(coord)!;
    expect(r.title).toBe(coord);
    expect(r.encoded.startsWith('naddr1')).toBe(true);
  });

  it('omits malformed targets entirely', () => {
    const map = buildResolvedMap(['garbage'], []);
    expect(map.has('garbage')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useEventTitles.test.ts`
Expected: FAIL — `buildResolvedMap` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/hooks/useEventTitles.ts
// ABOUTME: Batch-resolves NIP-22 comment parents to titles + encoded internal links,
// ABOUTME: degrading unresolved targets to their id/coordinate (#164 A)

import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { NostrEvent } from '@nostrify/nostrify';
import { parseCommentTarget, encodeTarget, extractEventTitle, buildTitleFilters } from '@/lib/eventTitles';
import { eventAddress } from '@/lib/threadFilters';

export interface ResolvedTarget {
  target: string;
  title: string;
  encoded: string;
  kind?: number;
}

/** Build the target→ResolvedTarget map from fetched events. Pure; exported for tests. */
export function buildResolvedMap(targets: string[], events: NostrEvent[]): Map<string, ResolvedTarget> {
  const byId = new Map(events.map(e => [e.id, e]));
  const byAddress = new Map<string, NostrEvent>();
  for (const e of events) {
    const addr = eventAddress(e);
    if (addr) byAddress.set(addr, e);
  }

  const map = new Map<string, ResolvedTarget>();
  for (const target of targets) {
    const parsed = parseCommentTarget(target);
    if (!parsed) continue;
    const encoded = encodeTarget(parsed);
    const found = parsed.kind === 'id' ? byId.get(parsed.id) : byAddress.get(target);
    if (found) {
      const title = extractEventTitle(found);
      map.set(target, { target, encoded, kind: found.kind, title: title || fallbackTitle(parsed, target) });
    } else {
      map.set(target, { target, encoded, title: fallbackTitle(parsed, target) });
    }
  }
  return map;
}

function fallbackTitle(parsed: ReturnType<typeof parseCommentTarget>, target: string): string {
  return parsed?.kind === 'id' ? `${parsed.id.slice(0, 8)}…` : target;
}

/**
 * Resolve a set of comment targets to display titles + internal-link encodings.
 * Distinct targets are fetched in one batched query; results degrade gracefully
 * so every parseable target is always linkable.
 */
export function useEventTitles(targets: string[], apiUrl?: string): { titles: Map<string, ResolvedTarget>; isLoading: boolean } {
  const { nostr } = useNostr();
  const distinct = useMemo(() => Array.from(new Set(targets)).sort(), [targets]);

  const { data: events = [], isLoading } = useQuery<NostrEvent[]>({
    queryKey: ['event-titles', apiUrl ?? '', distinct],
    queryFn: async ({ signal }) => {
      const filters = buildTitleFilters(distinct);
      if (filters.length === 0) return [];
      return nostr.query(filters, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    },
    enabled: distinct.length > 0,
    staleTime: 5 * 60_000,
  });

  const titles = useMemo(() => buildResolvedMap(distinct, events), [distinct, events]);
  return { titles, isLoading };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/useEventTitles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useEventTitles.ts src/hooks/useEventTitles.test.ts
git commit -m "feat(reports): useEventTitles batched comment-parent resolution (#164)"
```

---

### Task 3: `CommentParentLink` — shared "on \<parent\>" row link

**Files:**
- Create: `src/components/CommentParentLink.tsx`
- Test: `src/components/CommentParentLink.test.tsx`

**Interfaces:**
- Consumes: `ResolvedTarget` from `@/hooks/useEventTitles`; `Link` from `react-router-dom`.
- Produces: `CommentParentLink({ resolved }: { resolved: ResolvedTarget | undefined }): JSX.Element | null`

Renders `on <title>` as an internal `Link` to `/events?event=<encoded>`. Returns `null` when `resolved` is undefined (row has no valid parent).

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/CommentParentLink.test.tsx
// ABOUTME: Tests the shared "on <parent>" comment-row link (#164 A)

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CommentParentLink } from './CommentParentLink';

describe('CommentParentLink', () => {
  it('links "on <title>" to the internal events tab with the encoded ref', () => {
    render(
      <MemoryRouter>
        <CommentParentLink resolved={{ target: 'x', title: 'Cute Puppies', encoded: 'nevent1abc' }} />
      </MemoryRouter>
    );
    const link = screen.getByRole('link', { name: /Cute Puppies/ });
    expect(link).toHaveAttribute('href', '/events?event=nevent1abc');
  });

  it('renders nothing when there is no resolved parent', () => {
    const { container } = render(
      <MemoryRouter><CommentParentLink resolved={undefined} /></MemoryRouter>
    );
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/CommentParentLink.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/components/CommentParentLink.tsx
// ABOUTME: "on <parent>" link on a comment row, into the internal Events tab (#164 A)

import { Link } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import type { ResolvedTarget } from '@/hooks/useEventTitles';

export function CommentParentLink({ resolved }: { resolved: ResolvedTarget | undefined }) {
  if (!resolved) return null;
  return (
    <Link
      to={`/events?event=${resolved.encoded}`}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground min-w-0"
    >
      <MessageSquare className="h-3 w-3 shrink-0" />
      <span className="truncate">on {resolved.title}</span>
    </Link>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/CommentParentLink.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/CommentParentLink.tsx src/components/CommentParentLink.test.tsx
git commit -m "feat(reports): shared CommentParentLink row link (#164)"
```

---

### Task 4: `formatCommentActivity` — the per-card spray roll-up line

**Files:**
- Modify: `src/lib/commentActivity.ts`
- Test: `src/lib/commentActivity.test.ts` (append)

**Interfaces:**
- Consumes: existing `summarizeCommentActivity` (same file); `isVideoKind` from `@/lib/kindNames`.
- Produces: `formatCommentActivity(events: NostrEvent[]): string | null`

`null` when there are no comments. Noun is `video` when every comment's root-kind `K` tag is a video kind, else `post`. Appends a spray note when the same text hit ≥2 targets.

- [ ] **Step 1: Write the failing test** (append to `src/lib/commentActivity.test.ts`)

```typescript
import { formatCommentActivity } from './commentActivity';

const PK2 = 'd'.repeat(64);
function comment(content: string, root: string, rootKind: number, id: string): NostrEvent {
  return {
    id: id.repeat(64), pubkey: PK2, kind: 1111, content,
    tags: [['E', root], ['K', String(rootKind)]],
    created_at: 1, sig: 'f'.repeat(128),
  };
}

describe('formatCommentActivity', () => {
  it('returns null when there are no comments', () => {
    expect(formatCommentActivity([])).toBeNull();
  });

  it('reads "on 1 video" for comments concentrated on one video target', () => {
    const events = [
      comment('a', 'r1', 34236, '1'),
      comment('b', 'r1', 34236, '2'),
    ];
    expect(formatCommentActivity(events)).toBe('2 comments on 1 video');
  });

  it('reads "across M videos" for a spread, with a spray note for repeated text', () => {
    const events = [
      comment('same', 'r1', 34236, '1'),
      comment('same', 'r2', 34236, '2'),
      comment('same', 'r3', 34236, '3'),
    ];
    expect(formatCommentActivity(events)).toBe('3 comments across 3 videos (same comment on 3)');
  });

  it('uses "post" when the root kinds are not all video', () => {
    const events = [
      comment('a', 'r1', 1, '1'),
      comment('b', 'r2', 34236, '2'),
    ];
    expect(formatCommentActivity(events)).toBe('2 comments across 2 posts');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/commentActivity.test.ts`
Expected: FAIL — `formatCommentActivity` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `src/lib/commentActivity.ts`; add the import at top)

```typescript
import { isVideoKind } from "@/lib/kindNames";

/**
 * The at-a-glance spray line for a card: "8 comments across 7 videos" vs
 * "8 comments on 1 video". Noun is "video" only when every comment's root-kind
 * (K tag) is a video kind, else "post". Returns null when there are no comments.
 */
export function formatCommentActivity(events: NostrEvent[]): string | null {
  const comments = events.filter(e => e.kind === 1111);
  if (comments.length === 0) return null;

  const { commentCount, distinctTargets, repeatedAcrossTargets } = summarizeCommentActivity(comments);

  const rootKinds = comments
    .map(c => c.tags.find(t => t[0] === 'K')?.[1])
    .filter((k): k is string => !!k)
    .map(Number)
    .filter(k => !Number.isNaN(k));
  const allVideo = rootKinds.length > 0 && rootKinds.every(isVideoKind);
  const noun = allVideo ? 'video' : 'post';

  const c = `${commentCount} comment${commentCount === 1 ? '' : 's'}`;
  const where = distinctTargets === 1
    ? `on 1 ${noun}`
    : `across ${distinctTargets} ${noun}s`;
  const spray = repeatedAcrossTargets >= 2 ? ` (same comment on ${repeatedAcrossTargets})` : '';
  return `${c} ${where}${spray}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/commentActivity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/commentActivity.ts src/lib/commentActivity.test.ts
git commit -m "feat(reports): formatCommentActivity spray roll-up line (#164)"
```

---

### Task 5: Wire roll-up + parent link into `UserProfileCard`

**Files:**
- Modify: `src/components/UserProfileCard.tsx` (RecentPostsSection, ~250-364; and the card body where the roll-up line goes)
- Test: `src/components/UserProfileCard.test.tsx` (append)

**Interfaces:**
- Consumes: `formatCommentActivity` (`@/lib/commentActivity`), `getCommentTarget` (`@/lib/commentActivity`), `useEventTitles` (`@/hooks/useEventTitles`), `CommentParentLink` (`@/components/CommentParentLink`).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test** (append; the file already mocks `@/hooks/useAdminApi` and `InlineMediaPreview` — reuse those mocks, wrap renders in `MemoryRouter`)

```tsx
// append imports at top of src/components/UserProfileCard.test.tsx
import { MemoryRouter } from 'react-router-dom';

// mock the batched-title hook so the row link is deterministic
vi.mock('@/hooks/useEventTitles', () => ({
  useEventTitles: (targets: string[]) => ({
    titles: new Map(targets.map(t => [t, { target: t, title: 'Parent Video', encoded: 'nevent1parent' }])),
    isLoading: false,
  }),
}));

describe('UserProfileCard comment context', () => {
  const comment = (id: string, root: string): NostrEvent => ({
    id: id.repeat(64), pubkey: PUBKEY, kind: 1111,
    content: 'spam comment', tags: [['E', root], ['K', '34236']],
    created_at: 1_750_000_000, sig: 'f'.repeat(128),
  });

  it('shows the spray roll-up and a per-row "on <parent>" link for comments', () => {
    const recent = [comment('1', 'r1'.padEnd(64, 'a')), comment('2', 'r2'.padEnd(64, 'a'))];
    render(
      <MemoryRouter>
        <UserProfileCard pubkey={PUBKEY} stats={stats(recent)} />
      </MemoryRouter>
    );
    expect(screen.getByText(/2 comments across 2 videos/)).toBeInTheDocument();
    const link = screen.getAllByRole('link', { name: /on Parent Video/ })[0];
    expect(link).toHaveAttribute('href', '/events?event=nevent1parent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/UserProfileCard.test.tsx`
Expected: FAIL — no roll-up text / no parent link rendered.

- [ ] **Step 3: Write minimal implementation**

In `RecentPostsSection` (which receives `posts`), before `return`, resolve targets and the roll-up:

```tsx
  // #164 A: batched parent-title resolution for the comment rows + spray roll-up
  const commentTargets = posts
    .map(getCommentTarget)
    .filter((t): t is string => !!t);
  const { titles } = useEventTitles(commentTargets, apiUrl);
  const activityLine = formatCommentActivity(posts);
```

Add the roll-up line just under the section header (inside the outer `div`, after the header `div`):

```tsx
      {activityLine && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{activityLine}</p>
      )}
```

In the per-post row, inside the timestamp/kind row (the `flex items-center justify-between` at ~318), add the parent link for comment rows — place it in the left cell next to the timestamp:

```tsx
                  <div className="flex items-center gap-2 min-w-0">
                    <span>{new Date(post.created_at * 1000).toLocaleString()}</span>
                    {post.kind === 1111 && (
                      <CommentParentLink resolved={titles.get(getCommentTarget(post) ?? '')} />
                    )}
                  </div>
```

(Replace the existing bare `<span>{new Date(...)...</span>` on the left of that row with the wrapper above.)

Add imports at the top of the file:

```tsx
import { getCommentTarget, formatCommentActivity } from "@/lib/commentActivity";
import { useEventTitles } from "@/hooks/useEventTitles";
import { CommentParentLink } from "@/components/CommentParentLink";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/UserProfileCard.test.tsx`
Expected: PASS (existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/components/UserProfileCard.tsx src/components/UserProfileCard.test.tsx
git commit -m "feat(reports): comment roll-up + parent links on UserProfileCard (#164)"
```

---

### Task 6: Wire roll-up + parent link into `BannedUserCard`

**Files:**
- Modify: `src/components/BannedUserCard.tsx` (query returns full events for the summary; row render ~213-249; header stats ~146-161)
- Test: `src/components/BannedUserCard.test.tsx` (append)

**Interfaces:**
- Consumes: `formatCommentActivity`, `getCommentTarget` (`@/lib/commentActivity`), `useEventTitles`, `CommentParentLink`.
- Produces: no new exports.

Note: the card fetches up to 50 events but slices to 3 for display. The roll-up must summarize the **full** fetched set, so the query returns `allEvents` alongside `recentPosts`.

- [ ] **Step 1: Write the failing test** (append; the file already mocks `@nostrify/react` and `@/hooks/useAuthor` — reuse; wrap in `MemoryRouter`, mock `useEventTitles` as in Task 5)

```tsx
// append at top of src/components/BannedUserCard.test.tsx
import { MemoryRouter } from 'react-router-dom';
vi.mock('@/hooks/useEventTitles', () => ({
  useEventTitles: (targets: string[]) => ({
    titles: new Map(targets.map(t => [t, { target: t, title: 'Parent Video', encoded: 'nevent1parent' }])),
    isLoading: false,
  }),
}));

it('shows the comment spray roll-up over all fetched comments (#164 A)', async () => {
  setAuthored([
    event(1111, 'x', '1', [['E', 'r1'.padEnd(64, 'a')], ['K', '34236']]),
    event(1111, 'y', '2', [['E', 'r2'.padEnd(64, 'a')], ['K', '34236']]),
    event(1111, 'z', '3', [['E', 'r3'.padEnd(64, 'a')], ['K', '34236']]),
    event(1111, 'w', '4', [['E', 'r4'.padEnd(64, 'a')], ['K', '34236']]),
  ]);
  render(<MemoryRouter><BannedUserCard pubkey={PUBKEY} /></MemoryRouter>);
  expect(await screen.findByText(/4 comments across 4 videos/)).toBeInTheDocument();
});

it('renders an "on <parent>" link on a comment row (#164 A)', async () => {
  setAuthored([event(1111, 'scam', '1', [['E', 'r1'.padEnd(64, 'a')], ['K', '34236']])]);
  render(<MemoryRouter><BannedUserCard pubkey={PUBKEY} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /toggle details/i }));
  const link = await screen.findByRole('link', { name: /on Parent Video/ });
  expect(link).toHaveAttribute('href', '/events?event=nevent1parent');
});
```

(The `event()` helper in this file already accepts a `tags` argument.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/BannedUserCard.test.tsx`
Expected: FAIL — no roll-up text / no parent link.

- [ ] **Step 3: Write minimal implementation**

Extend the query's return to include the full set:

```tsx
      return {
        count: events.length,
        recentPosts: [...events].sort((a, b) => b.created_at - a.created_at).slice(0, 3),
        allEvents: events,
      };
```

After the query, resolve targets + roll-up (over `allEvents`):

```tsx
  const allEvents = postStats?.allEvents ?? [];
  const commentTargets = allEvents.map(getCommentTarget).filter((t): t is string => !!t);
  const { titles } = useEventTitles(commentTargets, undefined);
  const activityLine = formatCommentActivity(allEvents);
```

Add the roll-up line into the stats row (after the "N events on relay" span, ~151):

```tsx
                {activityLine && (
                  <span className="text-amber-700 dark:text-amber-400">{activityLine}</span>
                )}
```

In the per-post row's timestamp/kind row (~243), add the parent link:

```tsx
                        <div className="flex items-center justify-between text-xs text-muted-foreground gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span>{new Date(post.created_at * 1000).toLocaleString()}</span>
                            {post.kind === 1111 && (
                              <CommentParentLink resolved={titles.get(getCommentTarget(post) ?? '')} />
                            )}
                          </div>
                          <KindBadge kind={post.kind} />
                        </div>
```

Add imports:

```tsx
import { getCommentTarget, formatCommentActivity } from "@/lib/commentActivity";
import { useEventTitles } from "@/hooks/useEventTitles";
import { CommentParentLink } from "@/components/CommentParentLink";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/BannedUserCard.test.tsx`
Expected: PASS (existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/components/BannedUserCard.tsx src/components/BannedUserCard.test.tsx
git commit -m "feat(reports): comment roll-up + parent links on BannedUserCard (#164)"
```

---

### Task 7: `EventsList` internal-nav — naddr lookup + `?event=` param

**Files:**
- Modify: `src/components/EventsList.tsx` (SearchMode ~62-66; parseSearchInput ~68-104; searchParams effects ~409-425; direct-lookup ~502-535)
- Test: `src/components/EventsList.test.tsx` (append; if absent, create with the mock pattern from `BannedUserCard.test.tsx`)

**Interfaces:**
- Consumes: `nip19` (already imported), existing `parseSearchInput`.
- Produces: extended `SearchMode` with `{ type: 'address'; addressKind: number; pubkey: string; identifier: string }`; `parseSearchInput` handles `naddr1`.

- [ ] **Step 1: Write the failing test** (unit-test `parseSearchInput` — export it for the test)

```tsx
// src/components/EventsList.test.ts (or append to existing EventsList.test.tsx)
// ABOUTME: Tests EventsList search parsing incl. naddr internal-nav (#164 A)
import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import { parseSearchInput } from './EventsList';

const PK = 'b'.repeat(64);

describe('parseSearchInput naddr', () => {
  it('parses an naddr into an address search mode', () => {
    const naddr = nip19.naddrEncode({ kind: 34236, pubkey: PK, identifier: 'vid1' });
    expect(parseSearchInput(naddr)).toEqual({
      type: 'address', addressKind: 34236, pubkey: PK, identifier: 'vid1',
    });
  });

  it('still parses nevent as event_id', () => {
    const nevent = nip19.neventEncode({ id: 'c'.repeat(64) });
    expect(parseSearchInput(nevent)).toEqual({ type: 'event_id', hex: 'c'.repeat(64) });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/EventsList.test.ts`
Expected: FAIL — `parseSearchInput` not exported / no address mode.

- [ ] **Step 3: Write minimal implementation**

Export `parseSearchInput` (change `function parseSearchInput` to `export function parseSearchInput`). Extend the type and parser:

```tsx
type SearchMode =
  | { type: 'none' }
  | { type: 'event_id'; hex: string }
  | { type: 'pubkey'; hex: string }
  | { type: 'address'; addressKind: number; pubkey: string; identifier: string }
  | { type: 'text'; query: string };
```

Add, inside `parseSearchInput` before the hex fallback:

```tsx
  if (trimmed.startsWith('naddr1')) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === 'naddr') {
        return {
          type: 'address',
          addressKind: decoded.data.kind,
          pubkey: decoded.data.pubkey,
          identifier: decoded.data.identifier,
        };
      }
    } catch {
      // Invalid encoding, fall through to text search
    }
  }
```

Extend the direct-lookup query to handle the address branch (and its `queryKey` / `enabled` / auto-select):

```tsx
  const { data: directEventLookup, isLoading: isLoadingDirectEvent, error: directEventError } = useQuery({
    queryKey: ['event-search', committedSearch, searchMode.type],
    queryFn: async ({ signal }) => {
      const timeoutSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);

      if (searchMode.type === 'event_id') {
        const events = await nostr.query([{ ids: [searchMode.hex] }], { signal: timeoutSignal });
        if (events[0]) return { event: events[0], banned: false };
        try {
          const bannedEvent = await callRelayRpc<NostrEvent>('getbannedevent', [searchMode.hex]);
          if (bannedEvent) return { event: bannedEvent, banned: true };
        } catch { /* not banned or RPC failed */ }
        return null;
      }

      if (searchMode.type === 'address') {
        const events = await nostr.query(
          [{ kinds: [searchMode.addressKind], authors: [searchMode.pubkey], '#d': [searchMode.identifier], limit: 1 }],
          { signal: timeoutSignal },
        );
        return events[0] ? { event: events[0], banned: false } : null;
      }

      return null;
    },
    enabled: (searchMode.type === 'event_id' || searchMode.type === 'address') && !!nostr,
    staleTime: 60 * 1000,
  });

  // Auto-select found event in detail pane
  useEffect(() => {
    if (directEventLookup?.event && (searchMode.type === 'event_id' || searchMode.type === 'address')) {
      setSelectedEvent(directEventLookup.event);
    }
  }, [directEventLookup, searchMode]);
```

Add an effect that seeds the search from a `?event=` param (mirrors the `pubkey` sync effect, after it, ~415):

```tsx
  // #164 A: an internal parent link routes here as /events?event=<nevent|naddr>
  useEffect(() => {
    const eventParam = searchParams.get('event');
    if (eventParam && eventParam !== committedSearch) {
      setCommittedSearch(eventParam);
    }
  }, [searchParams, committedSearch]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/EventsList.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify existing EventsList behavior didn't regress**

Run: `npx vitest run src/components/EventsList.test.tsx` (if present) and `npx tsc --noEmit`
Expected: PASS / no type errors (the `SearchMode` union is exhaustively handled at ~811 and ~722 — confirm those still typecheck; add an `address` branch to any switch that the compiler flags).

- [ ] **Step 6: Commit**

```bash
git add src/components/EventsList.tsx src/components/EventsList.test.ts
git commit -m "feat(reports): EventsList naddr lookup + ?event= internal nav (#164)"
```

---

### Task 8: `EventsList` — "on \<parent\>" link on kind-1111 rows

**Files:**
- Modify: `src/components/EventsList.tsx` (EventCard row, ~136-260; the list-level resolution)
- Test: `src/components/EventsList.test.tsx` (append — a lighter assertion: a 1111 row renders a parent link)

**Interfaces:**
- Consumes: `getCommentTarget` (`@/lib/commentActivity`), `useEventTitles`, `CommentParentLink`.

Resolve targets at the list level (one batched query for all visible 1111 rows) and pass the resolved entry down to each `EventCard`. Add a `parentLink?: ResolvedTarget` prop to `EventCard` and render `<CommentParentLink>` in its metadata row when `event.kind === 1111`.

- [ ] **Step 1: Write the failing test** — render `EventsList` with a mocked relay returning one kind-1111 event and assert an `on <parent>` link appears. Reuse the `@nostrify/react` mock pattern and mock `useEventTitles` (as in Task 5). Wrap in `MemoryRouter`.

```tsx
it('renders an "on <parent>" link on kind-1111 rows in the events list (#164 A)', async () => {
  // relay mock returns a single 1111 comment; useEventTitles mocked to resolve it
  // (see BannedUserCard.test.tsx for the useNostr mock shape)
  // ...render <MemoryRouter><EventsList /></MemoryRouter>...
  expect(await screen.findByRole('link', { name: /on Parent Video/ })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/EventsList.test.tsx`
Expected: FAIL — no parent link on the row.

- [ ] **Step 3: Write minimal implementation**

At the list level (where `events` is flattened, ~538), resolve visible comment targets:

```tsx
  const commentTargets = useMemo(
    () => events.map(getCommentTarget).filter((t): t is string => !!t),
    [events],
  );
  const { titles: parentTitles } = useEventTitles(commentTargets, undefined);
```

Add a prop to `EventCard` and render the link in its metadata row (near where the kind badge / timestamp render, ~200):

```tsx
  parentLink,
  // ...
  parentLink?: ResolvedTarget;
  // ...
  {event.kind === 1111 && <CommentParentLink resolved={parentLink} />}
```

At each `EventCard` call site (~1045, ~1095), pass:

```tsx
                        parentLink={parentTitles.get(getCommentTarget(event) ?? '')}
```

Add imports:

```tsx
import { getCommentTarget } from "@/lib/commentActivity";
import { useEventTitles, type ResolvedTarget } from "@/hooks/useEventTitles";
import { CommentParentLink } from "@/components/CommentParentLink";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/EventsList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/EventsList.tsx src/components/EventsList.test.tsx
git commit -m "feat(reports): parent links on comment rows in EventsList (#164)"
```

---

### Task 9: `ThreadModal` — load and nest NIP-22 comments (issue #164 B)

**Files:**
- Modify: `src/components/ThreadModal.tsx` (`buildThreadTree` ~36-56; query ~137-170)
- Test: `src/components/ThreadModal.test.tsx` (create — pure `buildThreadTree` tests; export it for testing)

**Interfaces:**
- Consumes: `buildThreadReplyFilters`, `eventAddress` (`@/lib/threadFilters`).
- Produces: `buildThreadTree` exported for tests; unchanged external component API.

- [ ] **Step 1: Write the failing test** (export `buildThreadTree`, then test NIP-22 nesting)

```tsx
// src/components/ThreadModal.test.tsx
// ABOUTME: Tests ThreadModal's thread-tree builder incl. NIP-22 comment nesting (#164 B)

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';
import { buildThreadTree } from './ThreadModal';

const PK = 'b'.repeat(64);
function ev(over: Partial<NostrEvent>): NostrEvent {
  return { id: 'x', pubkey: PK, kind: 1, content: '', tags: [], created_at: 1, sig: 'f'.repeat(128), ...over };
}

describe('buildThreadTree NIP-22', () => {
  it('nests a kind-1111 comment under its lowercase-e parent', () => {
    const root = ev({ id: 'root', kind: 34236, tags: [['d', 'vid1']] });
    const comment = ev({
      id: 'c1', kind: 1111,
      tags: [['A', `34236:${PK}:vid1`], ['e', 'root'], ['k', '34236']],
    });
    const tree = buildThreadTree([root, comment], 'root');
    expect(tree?.replies.map(r => r.event.id)).toContain('c1');
  });

  it('nests a NIP-22 reply-to-a-comment under that comment (lowercase e)', () => {
    const root = ev({ id: 'root', kind: 1 });
    const c1 = ev({ id: 'c1', kind: 1111, tags: [['E', 'root'], ['e', 'root'], ['k', '1']] });
    const c2 = ev({ id: 'c2', kind: 1111, tags: [['E', 'root'], ['e', 'c1'], ['k', '1111']] });
    const tree = buildThreadTree([root, c1, c2], 'root');
    const c1node = tree?.replies.find(r => r.event.id === 'c1');
    expect(c1node?.replies.map(r => r.event.id)).toContain('c2');
  });

  it('hangs a comment whose parent is not in the set directly under root', () => {
    const root = ev({ id: 'root', kind: 34236, tags: [['d', 'vid1']] });
    const orphan = ev({ id: 'o1', kind: 1111, tags: [['A', `34236:${PK}:vid1`], ['e', 'missing'], ['k', '34236']] });
    const tree = buildThreadTree([root, orphan], 'root');
    expect(tree?.replies.map(r => r.event.id)).toContain('o1');
  });

  it('still nests NIP-10 kind-1 replies (no regression)', () => {
    const root = ev({ id: 'root', kind: 1 });
    const reply = ev({ id: 'r1', kind: 1, tags: [['e', 'root', '', 'reply']] });
    const tree = buildThreadTree([root, reply], 'root');
    expect(tree?.replies.map(r => r.event.id)).toContain('r1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ThreadModal.test.tsx`
Expected: FAIL — `buildThreadTree` not exported / comments not nested.

- [ ] **Step 3: Write minimal implementation**

Export and extend `buildThreadTree` so a node's children include NIP-22 comments whose immediate parent (lowercase `e` = this event id, or lowercase `a` = this event's address) matches, with a root catch-all for orphaned comments:

```tsx
export function buildThreadTree(events: NostrEvent[], rootId: string): ThreadNode | null {
  const eventMap = new Map<string, NostrEvent>();
  events.forEach(e => eventMap.set(e.id, e));

  const root = eventMap.get(rootId);
  if (!root) return null;

  const rootAddress = eventAddress(root);
  const idSet = new Set(events.map(e => e.id));

  // A NIP-22 comment's immediate parent: lowercase `e` (event id) or `a` (address).
  function commentParent(e: NostrEvent): { id?: string; address?: string } {
    return {
      id: e.tags.find(t => t[0] === 'e')?.[1],
      address: e.tags.find(t => t[0] === 'a')?.[1],
    };
  }

  function isChildOf(e: NostrEvent, parent: NostrEvent, parentAddress: string | undefined): boolean {
    if (e.kind === 1111) {
      const { id, address } = commentParent(e);
      if (id && id === parent.id) return true;
      if (address && parentAddress && address === parentAddress) return true;
      // Orphan (parent not fetched): attach to root only.
      const parentPresent = (id && idSet.has(id)) || (address && rootAddress === address);
      return parent.id === rootId && !parentPresent;
    }
    // NIP-10 kind-1 reply markers (existing behavior)
    const replyTag = e.tags.find(t => t[0] === 'e' && (t[3] === 'reply' || !t[3]));
    return !!replyTag && replyTag[1] === parent.id;
  }

  function buildNode(event: NostrEvent, depth: number): ThreadNode {
    const parentAddress = eventAddress(event);
    const replies = events
      .filter(e => e.id !== event.id && isChildOf(e, event, parentAddress))
      .map(e => buildNode(e, depth + 1))
      .sort((a, b) => a.event.created_at - b.event.created_at);
    return { event, replies, depth };
  }

  return buildNode(root, 0);
}
```

Update the query to load comments via `buildThreadReplyFilters` and to root addressable events correctly:

```tsx
      if (!targetEvent) return null;

      // Root: NIP-10 `e root` when present, else the event itself.
      const rootTag = targetEvent.tags.find(t => t[0] === 'e' && t[3] === 'root');
      const rootId = rootTag ? rootTag[1] : eventId;

      const [rootEvent] = await nostr.query([{ ids: [rootId], limit: 1 }], { signal: combinedSignal });
      const rootForFilters = rootEvent ?? targetEvent;

      // NIP-10 kind-1 replies + NIP-22 kind-1111 comments (scoped by root E/A).
      const replies = await nostr.query(
        buildThreadReplyFilters(rootForFilters, 100),
        { signal: combinedSignal },
      );

      const allEvents = rootEvent ? [rootEvent, ...replies] : [targetEvent, ...replies];
      return buildThreadTree(allEvents, rootId);
```

Add imports:

```tsx
import { buildThreadReplyFilters, eventAddress } from "@/lib/threadFilters";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/ThreadModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ThreadModal.tsx src/components/ThreadModal.test.tsx
git commit -m "feat(reports): ThreadModal loads and nests NIP-22 comments (#164 B)"
```

---

### Task 10: Final verification + PR body

**Files:**
- Modify: PR #165 body (via `gh pr edit` — draft inline for Matt first; do NOT post without approval)

- [ ] **Step 1: Full type-check + test + build**

Run from the worktree root:
```bash
npx tsc --noEmit
npx vitest run
npx vite build
```
Expected: tsc clean; all tests pass; build succeeds.

- [ ] **Step 2: Rebase check**

```bash
git fetch origin && git rev-list --count HEAD..origin/main
```
Expected: `0`. If not, `git rebase origin/main`, re-run Step 1.

- [ ] **Step 3: Draft the updated PR body inline for Matt**

Rewrite the PR #165 body: change "early draft" framing to complete, `Relates to #164` → `Closes #164`, mark every A and B checkbox done, and add a Verification section (test count, tsc/build clean, note the internal-nav + naddr decision). Present inline; post only on Matt's go.

- [ ] **Step 4: Self-review + code-review loop**

Per CLAUDE.md: read the full branch diff as a reviewer, then dispatch a fresh-context reviewer over `origin/main..HEAD`. Resolve findings, re-review until clean, before marking ready / requesting Daniel.

---

## Self-Review (against the spec)

**Spec coverage:**
- B / ThreadModal → Task 9. ✓
- A1 batched title resolution → Tasks 1, 2. ✓
- A2 per-row parent link (shared) → Task 3, wired in Tasks 5, 6, 8. ✓
- A3 per-card roll-up → Task 4, wired in Tasks 5, 6. ✓
- A4 Events-list rows + internal nav (naddr) → Tasks 7, 8. ✓
- Key decision (internal `/events?event=`, naddr lookup, banned fallback) → Task 7. ✓
- Testing (buildThreadTree, useEventTitles, naddr lookup, roll-up, links) → Tasks 1-9. ✓

**Type consistency:** `ResolvedTarget` (Task 2) is the single shape consumed by Tasks 3/5/6/8. `ParsedTarget` (Task 1) is consumed by Task 2. `SearchMode` address shape (Task 7) matches the `naddr` decode fields. `formatCommentActivity`/`getCommentTarget`/`summarizeCommentActivity` names are consistent across Tasks 4/5/6/8.

**Placeholder scan:** No TBD/TODO; every code step carries real code. Component-wiring steps show the exact snippet + anchor line ranges.

**Open risk flagged for execution:** Tasks 7/8 modify a 1100-line file; the `SearchMode` union is switched on at ~722 and ~811 — Task 7 Step 5 verifies those branches typecheck and adds an `address` case if the compiler flags a non-exhaustive switch.
