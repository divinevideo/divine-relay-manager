# Report Render Survival Tests

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fixtures corpus of real report data shapes and render survival tests that catch UI crashes before production does.

**Architecture:** A shared test wrapper provides the provider stack (AppProvider, QueryClient, NostrProvider, TooltipProvider) with all custom hooks mocked at the module level. Fixture files define NostrEvent shapes for every edge case we've encountered. Render tests mount components with each fixture and assert no crash -- not pixel correctness, just survival. The corpus grows over time: every new production crash gets a fixture added before the fix.

**Tech Stack:** Vitest (already configured), @testing-library/react (already installed), jsdom (already configured in vite.config.ts)

---

## File Structure

```
src/test/
  setup.ts                    -- existing (already mocks localStorage, matchMedia, etc.)
  render-wrapper.tsx           -- NEW: shared provider wrapper for render tests
  fixtures/
    index.ts                   -- NEW: re-exports all fixtures
    report-events.ts           -- NEW: kind 1984 report event shapes
    content-events.ts          -- NEW: reported content event shapes (videos, notes, comments, reposts)
    profiles.ts                -- NEW: kind 0 profile metadata shapes (and missing profiles)
    ai-summaries.ts            -- NEW: AI summary response shapes
  __tests__/
    AISummary.survival.test.tsx       -- NEW: render survival for AISummary
    ThreadContext.survival.test.tsx    -- NEW: render survival for ThreadContext
    UserProfileCard.survival.test.tsx -- NEW: render survival for UserProfileCard
    MediaPreview.survival.test.tsx    -- NEW: render survival for MediaPreview
```

**Why this structure:**
- Fixtures are separate from tests so multiple test files share the same corpus
- `.survival.test.tsx` suffix distinguishes these from logic/integration tests
- `render-wrapper.tsx` is shared so provider changes propagate everywhere
- Tests live under `src/test/__tests__/` to keep them grouped, not scattered across component dirs

**Key decisions:**
- Mock all custom hooks at the module level. These tests verify rendering, not data fetching.
- Don't mock NostrEvent construction -- use real event shapes from production (sanitized pubkeys/sigs).
- Each fixture has a comment explaining what production scenario it represents.

---

### Task 1: Test render wrapper

**Files:**
- Create: `src/test/render-wrapper.tsx`

- [ ] **Step 1: Create the shared render wrapper**

```tsx
// ABOUTME: Shared provider wrapper for render survival tests
// ABOUTME: Matches App.tsx provider hierarchy so components mount without crashing

import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NostrLoginProvider } from '@nostrify/react/login';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppProvider } from '@/components/AppProvider';
import NostrProvider from '@/components/NostrProvider';
import { render, type RenderOptions } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

const TEST_CONFIG = {
  theme: 'light' as const,
  relayUrl: 'wss://test-relay.example.com',
  apiUrl: 'https://test-api.example.com',
};

function TestProviders({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  return (
    <BrowserRouter>
      <AppProvider storageKey="test-config" defaultConfig={TEST_CONFIG}>
        <QueryClientProvider client={queryClient}>
          <NostrLoginProvider storageKey="test-login">
            <NostrProvider>
              <TooltipProvider>
                {children}
              </TooltipProvider>
            </NostrProvider>
          </NostrLoginProvider>
        </QueryClientProvider>
      </AppProvider>
    </BrowserRouter>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
) {
  return render(ui, { wrapper: TestProviders, ...options });
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/code/divine-relay-manager && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/test/render-wrapper.tsx
git commit -m "test: add shared render wrapper for survival tests"
```

---

### Task 2: Fixture corpus -- report events

**Files:**
- Create: `src/test/fixtures/report-events.ts`

- [ ] **Step 1: Create report event fixtures**

Each fixture represents a real production scenario. Pubkeys and sigs are sanitized but structurally valid.

```ts
// ABOUTME: Kind 1984 report event fixtures for render survival tests
// ABOUTME: Each fixture represents a data shape encountered in production

import type { NostrEvent } from '@nostrify/nostrify';

const FAKE_SIG = '0'.repeat(128);
const PUBKEY_A = '1'.repeat(64); // reporter
const PUBKEY_B = '2'.repeat(64); // reported user
const EVENT_ID_A = 'a'.repeat(64); // reported event

/** Standard report against a video event with all expected tags */
export const reportVideoEvent: NostrEvent = {
  id: 'f'.repeat(64),
  pubkey: PUBKEY_A,
  created_at: Math.floor(Date.now() / 1000),
  kind: 1984,
  tags: [
    ['e', EVENT_ID_A, 'wss://relay.divine.video'],
    ['p', PUBKEY_B],
    ['L', 'MOD'],
    ['l', 'sexual_minors', 'MOD'],
    ['client', 'diVine'],
  ],
  content: 'Inappropriate content',
  sig: FAKE_SIG,
};

/** User report (pubkey target, no event) */
export const reportUserOnly: NostrEvent = {
  id: 'e'.repeat(64),
  pubkey: PUBKEY_A,
  created_at: Math.floor(Date.now() / 1000),
  kind: 1984,
  tags: [
    ['p', PUBKEY_B],
    ['L', 'MOD'],
    ['l', 'impersonation', 'MOD'],
    ['client', 'diVine'],
  ],
  content: 'This user is impersonating someone',
  sig: FAKE_SIG,
};

/** Report with no content field */
export const reportEmptyContent: NostrEvent = {
  id: 'd'.repeat(64),
  pubkey: PUBKEY_A,
  created_at: Math.floor(Date.now() / 1000),
  kind: 1984,
  tags: [
    ['e', EVENT_ID_A],
    ['p', PUBKEY_B],
    ['L', 'MOD'],
    ['l', 'spam', 'MOD'],
    ['client', 'divine-web'],
  ],
  content: '',
  sig: FAKE_SIG,
};

/** Report with relay hint to external relay */
export const reportWithRelayHint: NostrEvent = {
  id: 'c'.repeat(64),
  pubkey: PUBKEY_A,
  created_at: Math.floor(Date.now() / 1000),
  kind: 1984,
  tags: [
    ['e', EVENT_ID_A, 'wss://nos.lol'],
    ['p', PUBKEY_B],
    ['L', 'MOD'],
    ['l', 'harassment', 'MOD'],
    ['client', 'diVine'],
  ],
  content: 'Harassing comments',
  sig: FAKE_SIG,
};

/** Report from untrusted client */
export const reportUntrustedClient: NostrEvent = {
  id: 'b'.repeat(64),
  pubkey: PUBKEY_A,
  created_at: Math.floor(Date.now() / 1000),
  kind: 1984,
  tags: [
    ['e', EVENT_ID_A],
    ['p', PUBKEY_B],
    ['L', 'MOD'],
    ['l', 'other', 'MOD'],
    ['client', 'some-random-app'],
  ],
  content: 'Report from unknown client',
  sig: FAKE_SIG,
};

/** Report with no category label */
export const reportNoCategory: NostrEvent = {
  id: '9'.repeat(64),
  pubkey: PUBKEY_A,
  created_at: Math.floor(Date.now() / 1000),
  kind: 1984,
  tags: [
    ['e', EVENT_ID_A],
    ['p', PUBKEY_B],
  ],
  content: 'Bad stuff',
  sig: FAKE_SIG,
};

/** Report with no e tag and no p tag (malformed) */
export const reportMalformed: NostrEvent = {
  id: '8'.repeat(64),
  pubkey: PUBKEY_A,
  created_at: Math.floor(Date.now() / 1000),
  kind: 1984,
  tags: [],
  content: 'Somehow published with no tags',
  sig: FAKE_SIG,
};
```

- [ ] **Step 2: Commit**

```bash
git add src/test/fixtures/report-events.ts
git commit -m "test: add report event fixtures for render survival tests"
```

---

### Task 3: Fixture corpus -- content events

**Files:**
- Create: `src/test/fixtures/content-events.ts`

- [ ] **Step 1: Create content event fixtures**

```ts
// ABOUTME: Reported content event fixtures for render survival tests
// ABOUTME: Covers video, note, comment, repost, and edge cases

import type { NostrEvent } from '@nostrify/nostrify';

const FAKE_SIG = '0'.repeat(128);
const PUBKEY_B = '2'.repeat(64);

/** Video event (kind 34235) with imeta tags */
export const videoEvent: NostrEvent = {
  id: 'a1'.padEnd(64, '0'),
  pubkey: PUBKEY_B,
  created_at: Math.floor(Date.now() / 1000),
  kind: 34235,
  tags: [
    ['title', 'My Cool Video'],
    ['imeta', 'url https://media.divine.video/abc123/video.mp4', 'dim 1920x1080', 'm video/mp4'],
    ['thumb', 'https://media.divine.video/abc123/thumb.jpg'],
    ['d', 'abc123'],
  ],
  content: 'Check out this video',
  sig: FAKE_SIG,
};

/** Short text note (kind 1) */
export const noteEvent: NostrEvent = {
  id: 'a2'.padEnd(64, '0'),
  pubkey: PUBKEY_B,
  created_at: Math.floor(Date.now() / 1000),
  kind: 1,
  tags: [],
  content: 'Just a regular note with some text content',
  sig: FAKE_SIG,
};

/** Comment (kind 1111) with uppercase E tag ancestor */
export const commentEvent: NostrEvent = {
  id: 'a3'.padEnd(64, '0'),
  pubkey: PUBKEY_B,
  created_at: Math.floor(Date.now() / 1000),
  kind: 1111,
  tags: [
    ['E', 'f'.repeat(64), 'wss://relay.divine.video', 'root'],
    ['e', 'e'.repeat(64), 'wss://relay.divine.video', 'reply'],
    ['p', '3'.repeat(64)],
    ['K', '34235'],
  ],
  content: 'This is a comment on a video',
  sig: FAKE_SIG,
};

/** Repost (kind 6) with missing original */
export const repostMissingOriginal: NostrEvent = {
  id: 'a4'.padEnd(64, '0'),
  pubkey: PUBKEY_B,
  created_at: Math.floor(Date.now() / 1000),
  kind: 6,
  tags: [
    ['e', 'dead'.repeat(16), 'wss://relay.divine.video'],
    ['p', '4'.repeat(64)],
  ],
  content: '', // original event content often empty in reposts
  sig: FAKE_SIG,
};

/** Event with no content and no tags */
export const bareEvent: NostrEvent = {
  id: 'a5'.padEnd(64, '0'),
  pubkey: PUBKEY_B,
  created_at: Math.floor(Date.now() / 1000),
  kind: 1,
  tags: [],
  content: '',
  sig: FAKE_SIG,
};

/** Event with extremely long content (overflow test) */
export const longContentEvent: NostrEvent = {
  id: 'a6'.padEnd(64, '0'),
  pubkey: PUBKEY_B,
  created_at: Math.floor(Date.now() / 1000),
  kind: 1,
  tags: [],
  content: 'https://example.com/' + 'a'.repeat(500) + ' ' + 'word '.repeat(200),
  sig: FAKE_SIG,
};

/** Video event with no media tags (metadata only) */
export const videoNoMedia: NostrEvent = {
  id: 'a7'.padEnd(64, '0'),
  pubkey: PUBKEY_B,
  created_at: Math.floor(Date.now() / 1000),
  kind: 34235,
  tags: [
    ['title', 'Video with no media URLs'],
    ['d', 'def456'],
  ],
  content: '',
  sig: FAKE_SIG,
};
```

- [ ] **Step 2: Commit**

```bash
git add src/test/fixtures/content-events.ts
git commit -m "test: add content event fixtures for render survival tests"
```

---

### Task 4: Fixture corpus -- profiles and AI summaries

**Files:**
- Create: `src/test/fixtures/profiles.ts`
- Create: `src/test/fixtures/ai-summaries.ts`
- Create: `src/test/fixtures/index.ts`

- [ ] **Step 1: Create profile fixtures**

```ts
// ABOUTME: Kind 0 profile metadata fixtures for render survival tests
// ABOUTME: Covers normal profiles, empty profiles, and missing data

import type { NostrMetadata } from '@nostrify/nostrify';

/** Full profile with all fields */
export const fullProfile: NostrMetadata = {
  name: 'TestUser',
  display_name: 'Test User',
  about: 'Just a test profile for survival tests',
  picture: 'https://media.divine.video/profile/pic.jpg',
  banner: 'https://media.divine.video/profile/banner.jpg',
  nip05: 'testuser@divine.video',
  website: 'https://example.com',
};

/** Profile with only name */
export const minimalProfile: NostrMetadata = {
  name: 'minimal',
};

/** Empty profile object (user published kind 0 with empty content) */
export const emptyProfile: NostrMetadata = {};

/** Profile with unicode and emoji in display name */
export const unicodeProfile: NostrMetadata = {
  name: 'user_with_special',
  display_name: '🔥 Tëst Üsér 日本語',
  about: 'Profile with <script>alert("xss")</script> in about',
};
```

- [ ] **Step 2: Create AI summary fixtures**

```ts
// ABOUTME: AI summary response fixtures for render survival tests
// ABOUTME: Covers all risk levels including the 'unknown' that caused the crash

export interface AISummaryFixture {
  summary?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  isLoading?: boolean;
  error?: Error | null;
}

/** Normal low risk */
export const summaryLow: AISummaryFixture = {
  summary: 'User has minimal activity. No prior moderation actions.',
  riskLevel: 'low',
};

/** Medium risk */
export const summaryMedium: AISummaryFixture = {
  summary: 'User has been reported twice in the past week for spam.',
  riskLevel: 'medium',
};

/** High risk */
export const summaryHigh: AISummaryFixture = {
  summary: 'Multiple reports across categories. Previous warnings issued.',
  riskLevel: 'high',
};

/** Critical risk */
export const summaryCritical: AISummaryFixture = {
  summary: 'Severe content violations. Immediate review recommended.',
  riskLevel: 'critical',
};

/** Unknown risk (THE CRASH SCENARIO -- PR #35 returns this on API error) */
export const summaryUnknown: AISummaryFixture = {
  summary: 'Analysis completed but risk could not be determined.',
  riskLevel: 'unknown',
};

/** Loading state */
export const summaryLoading: AISummaryFixture = {
  isLoading: true,
};

/** Error state */
export const summaryError: AISummaryFixture = {
  error: new Error('Failed to summarize user'),
};

/** No summary (API returned nothing) */
export const summaryEmpty: AISummaryFixture = {};

/** Summary with no risk level */
export const summaryNoRisk: AISummaryFixture = {
  summary: 'User analysis complete.',
  riskLevel: undefined,
};
```

- [ ] **Step 3: Create fixtures index**

```ts
// ABOUTME: Re-exports all fixture modules for convenient importing
export * as reportEvents from './report-events';
export * as contentEvents from './content-events';
export * as profiles from './profiles';
export * as aiSummaries from './ai-summaries';
```

- [ ] **Step 4: Commit**

```bash
git add src/test/fixtures/
git commit -m "test: add profile, AI summary fixtures and index"
```

---

### Task 5: AISummary survival tests

**Files:**
- Create: `src/test/__tests__/AISummary.survival.test.tsx`

- [ ] **Step 1: Write the survival tests**

AISummary is self-contained (no hooks, just props). No mocking needed.

```tsx
// ABOUTME: Render survival tests for AISummary component
// ABOUTME: Verifies component doesn't crash on any known data shape

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AISummary } from '@/components/AISummary';
import * as aiSummaries from '../fixtures/ai-summaries';

describe('AISummary survival', () => {
  const fixtures = Object.entries(aiSummaries) as [string, aiSummaries.AISummaryFixture][];

  for (const [name, fixture] of fixtures) {
    it(`renders without crashing: ${name}`, () => {
      expect(() => {
        render(
          <AISummary
            summary={fixture.summary}
            riskLevel={fixture.riskLevel}
            isLoading={fixture.isLoading}
            error={fixture.error}
          />
        );
      }).not.toThrow();
    });
  }

  it('renders risk badge text for each known level', () => {
    const levels = ['low', 'medium', 'high', 'critical', 'unknown'] as const;
    for (const level of levels) {
      const { unmount } = render(
        <AISummary summary="Test summary" riskLevel={level} />
      );
      // Just verify it rendered something -- not checking exact text
      expect(screen.getByText('AI Analysis')).toBeTruthy();
      unmount();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd ~/code/divine-relay-manager && npx vitest run src/test/__tests__/AISummary.survival.test.tsx`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/test/__tests__/AISummary.survival.test.tsx
git commit -m "test: AISummary render survival tests across all data shapes"
```

---

### Task 6: ThreadContext survival tests

**Files:**
- Create: `src/test/__tests__/ThreadContext.survival.test.tsx`

ThreadContext takes props directly but renders PostCard internally, which calls `useAuthor()` (needs NostrProvider). The render wrapper provides the full provider stack.

- [ ] **Step 1: Write the survival tests**

```tsx
// ABOUTME: Render survival tests for ThreadContext component
// ABOUTME: Verifies thread display doesn't crash on edge-case event shapes

import { describe, it, expect } from 'vitest';
import { renderWithProviders } from '../render-wrapper';
import { ThreadContext } from '@/components/ThreadContext';
import * as contentEvents from '../fixtures/content-events';
import { reportVideoEvent, reportUserOnly, reportNoCategory, reportMalformed, reportWithRelayHint } from '../fixtures/report-events';

describe('ThreadContext survival', () => {
  const contentFixtures = Object.entries(contentEvents);

  // Test each content event as the reported event
  for (const [name, event] of contentFixtures) {
    it(`renders without crashing: reported event = ${name}`, () => {
      expect(() => {
        renderWithProviders(
          <ThreadContext
            ancestors={[]}
            reportedEvent={event}
            reportTags={reportVideoEvent.tags}
            targetEventId={event.id}
          />
        );
      }).not.toThrow();
    });
  }

  // Null/missing reported event
  it('renders without crashing: null reported event', () => {
    expect(() => {
      renderWithProviders(
        <ThreadContext
          ancestors={[]}
          reportedEvent={null}
          reportTags={reportVideoEvent.tags}
          targetEventId={'a'.repeat(64)}
        />
      );
    }).not.toThrow();
  });

  // Loading states
  it('renders without crashing: isLoading=true', () => {
    expect(() => {
      renderWithProviders(
        <ThreadContext
          ancestors={[]}
          reportedEvent={null}
          isLoading={true}
          reportTags={reportVideoEvent.tags}
          targetEventId={'a'.repeat(64)}
        />
      );
    }).not.toThrow();
  });

  it('renders without crashing: isCheckingBanned=true', () => {
    expect(() => {
      renderWithProviders(
        <ThreadContext
          ancestors={[]}
          reportedEvent={null}
          isCheckingBanned={true}
          reportTags={reportVideoEvent.tags}
          targetEventId={'a'.repeat(64)}
        />
      );
    }).not.toThrow();
  });

  // Ancestor chains
  it('renders without crashing: multiple ancestors', () => {
    expect(() => {
      renderWithProviders(
        <ThreadContext
          ancestors={[contentEvents.noteEvent, contentEvents.commentEvent]}
          reportedEvent={contentEvents.commentEvent}
          reportTags={reportVideoEvent.tags}
          targetEventId={contentEvents.commentEvent.id}
        />
      );
    }).not.toThrow();
  });

  // Moderation status states
  it('renders without crashing: event deleted + user banned', () => {
    expect(() => {
      renderWithProviders(
        <ThreadContext
          ancestors={[]}
          reportedEvent={contentEvents.videoEvent}
          isEventDeleted={true}
          isUserBanned={true}
          checkedAt={new Date()}
          reportTags={reportVideoEvent.tags}
          targetEventId={contentEvents.videoEvent.id}
        />
      );
    }).not.toThrow();
  });

  // Report with no tags (malformed)
  it('renders without crashing: malformed report tags', () => {
    expect(() => {
      renderWithProviders(
        <ThreadContext
          ancestors={[]}
          reportedEvent={null}
          reportTags={reportMalformed.tags}
          targetEventId={undefined}
        />
      );
    }).not.toThrow();
  });

  // Relay hint in report tags (external relay fallback UI)
  it('renders without crashing: relay hint report tags with null event', () => {
    expect(() => {
      renderWithProviders(
        <ThreadContext
          ancestors={[]}
          reportedEvent={null}
          reportTags={reportWithRelayHint.tags}
          targetEventId={'a'.repeat(64)}
          triedExternalRelay="wss://nos.lol"
          fetchSource={null}
        />
      );
    }).not.toThrow();
  });

  // External relay fetch state
  it('renders without crashing: tried external relay', () => {
    expect(() => {
      renderWithProviders(
        <ThreadContext
          ancestors={[]}
          reportedEvent={contentEvents.videoEvent}
          fetchSource="external"
          triedExternalRelay="wss://nos.lol"
          reportTags={reportVideoEvent.tags}
          targetEventId={contentEvents.videoEvent.id}
        />
      );
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd ~/code/divine-relay-manager && npx vitest run src/test/__tests__/ThreadContext.survival.test.tsx`
Expected: All tests PASS. If any fail because ThreadContext imports hooks that need NostrProvider, add NostrProvider to the render wrapper or mock the specific hook.

- [ ] **Step 3: Commit**

```bash
git add src/test/__tests__/ThreadContext.survival.test.tsx
git commit -m "test: ThreadContext render survival tests across event types and states"
```

---

### Task 7: UserProfileCard survival tests

**Files:**
- Create: `src/test/__tests__/UserProfileCard.survival.test.tsx`

- [ ] **Step 1: Write the survival tests**

```tsx
// ABOUTME: Render survival tests for UserProfileCard component
// ABOUTME: Verifies profile card doesn't crash on edge-case profile shapes

import { describe, it, expect } from 'vitest';
import { renderWithProviders } from '../render-wrapper';
import { UserProfileCard } from '@/components/UserProfileCard';
import * as profiles from '../fixtures/profiles';

const PUBKEY_B = '2'.repeat(64);

describe('UserProfileCard survival', () => {
  const profileFixtures = Object.entries(profiles);

  for (const [name, profile] of profileFixtures) {
    it(`renders without crashing: ${name}`, () => {
      expect(() => {
        renderWithProviders(
          <UserProfileCard
            profile={profile}
            pubkey={PUBKEY_B}
          />
        );
      }).not.toThrow();
    });
  }

  // No profile at all (kind 0 not found)
  it('renders without crashing: undefined profile', () => {
    expect(() => {
      renderWithProviders(
        <UserProfileCard
          profile={undefined}
          pubkey={PUBKEY_B}
        />
      );
    }).not.toThrow();
  });

  // No pubkey
  it('renders without crashing: null pubkey', () => {
    expect(() => {
      renderWithProviders(
        <UserProfileCard
          profile={profiles.fullProfile}
          pubkey={null}
        />
      );
    }).not.toThrow();
  });

  // Loading state
  it('renders without crashing: isLoading', () => {
    expect(() => {
      renderWithProviders(
        <UserProfileCard
          profile={undefined}
          pubkey={PUBKEY_B}
          isLoading={true}
        />
      );
    }).not.toThrow();
  });

  // With stats (empty)
  it('renders without crashing: empty stats', () => {
    expect(() => {
      renderWithProviders(
        <UserProfileCard
          profile={profiles.fullProfile}
          pubkey={PUBKEY_B}
          stats={{ postCount: 0, reportCount: 0, labelCount: 0, recentPosts: [], existingLabels: [], previousReports: [] }}
        />
      );
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd ~/code/divine-relay-manager && npx vitest run src/test/__tests__/UserProfileCard.survival.test.tsx`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/test/__tests__/UserProfileCard.survival.test.tsx
git commit -m "test: UserProfileCard render survival tests across profile shapes"
```

---

### Task 8: MediaPreview survival tests

**Files:**
- Create: `src/test/__tests__/MediaPreview.survival.test.tsx`

MediaPreview uses `useApiUrl()` internally. Mock it.

- [ ] **Step 1: Write the survival tests**

```tsx
// ABOUTME: Render survival tests for MediaPreview component
// ABOUTME: Verifies media preview doesn't crash on events with various media tag shapes

import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders } from '../render-wrapper';
import { MediaPreview } from '@/components/MediaPreview';
import * as contentEvents from '../fixtures/content-events';

// Mock useAdminApi module -- MediaPreview imports useApiUrl from here
vi.mock('@/hooks/useAdminApi', () => ({
  useApiUrl: () => 'https://test-api.example.com',
  useAdminApi: () => ({}),
}));

// Mock fetch for proxy requests
global.fetch = vi.fn(() =>
  Promise.resolve(new Response('', { status: 404 }))
) as unknown as typeof fetch;

describe('MediaPreview survival', () => {
  const fixtures = Object.entries(contentEvents);

  for (const [name, event] of fixtures) {
    it(`renders without crashing: ${name}`, () => {
      expect(() => {
        renderWithProviders(
          <MediaPreview event={event} />
        );
      }).not.toThrow();
    });
  }

  // Null event
  it('renders without crashing: null event', () => {
    expect(() => {
      renderWithProviders(<MediaPreview event={null} />);
    }).not.toThrow();
  });

  // Undefined event
  it('renders without crashing: undefined event', () => {
    expect(() => {
      renderWithProviders(<MediaPreview />);
    }).not.toThrow();
  });

  // Tags only, no event
  it('renders without crashing: tags without event', () => {
    expect(() => {
      renderWithProviders(
        <MediaPreview
          tags={[
            ['imeta', 'url https://media.divine.video/test.mp4', 'm video/mp4'],
          ]}
        />
      );
    }).not.toThrow();
  });

  // Content with inline URLs only
  it('renders without crashing: content with inline URLs', () => {
    expect(() => {
      renderWithProviders(
        <MediaPreview content="Check this https://media.divine.video/test.jpg" />
      );
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd ~/code/divine-relay-manager && npx vitest run src/test/__tests__/MediaPreview.survival.test.tsx`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/test/__tests__/MediaPreview.survival.test.tsx
git commit -m "test: MediaPreview render survival tests across media tag shapes"
```

---

### Task 9: Run full suite, verify CI compatibility

- [ ] **Step 1: Run all survival tests together**

Run: `cd ~/code/divine-relay-manager && npx vitest run src/test/__tests__/`
Expected: All tests PASS

- [ ] **Step 2: Run full CI pipeline locally**

Run: `cd ~/code/divine-relay-manager && npm test`
Expected: tsc, eslint, vitest (all tests including worker + survival), vite build all PASS

- [ ] **Step 3: Fix any issues found**

Common issues:
- Missing mock for a hook: add `vi.mock()` at test file top
- Provider not available: add to `render-wrapper.tsx`
- Import path mismatch: check `@/` alias resolves in test environment

- [ ] **Step 4: Commit any fixes, then final commit**

```bash
git add -A
git commit -m "test: complete render survival test suite -- fixtures corpus + 4 components"
```

---

## Maintaining the corpus

**The discipline (not automated, just process):**

1. Production crash discovered
2. Add a fixture to the appropriate file in `src/test/fixtures/` that reproduces the data shape
3. Write a failing survival test (or verify an existing parametrized test now fails with the new fixture)
4. Fix the component
5. Verify the test passes
6. Commit fixture + fix together

**When to add new test files:**

If a new component starts appearing in crash reports, add `src/test/__tests__/ComponentName.survival.test.tsx` following the same pattern. The render wrapper and fixtures are already shared.
