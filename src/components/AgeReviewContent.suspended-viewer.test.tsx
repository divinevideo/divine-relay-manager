// ABOUTME: Pins the suspended-content viewer in age review: the reported post and the account's
// ABOUTME: posts, only for a suspended subject, on the age-review surface, media click-to-reveal.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgeReviewContent } from "./AgeReviewContent";
import type { AccountStatusResponse } from "@/lib/adminApi";
import type { ReportedEventResult } from "@/hooks/useReportedEvent";

vi.mock("@/components/MediaPreview", () => ({ MediaPreview: () => null }));
// The panels have their own tests; here they record what age review handed them.
const viewers = vi.hoisted(() => ({ post: null as Record<string, unknown> | null, account: null as Record<string, unknown> | null }));
vi.mock("@/components/suspended/SuspendedContentPanel", () => ({
  SuspendedPostViewer: (props: Record<string, unknown>) => { viewers.post = props; return <div data-testid="post-viewer" />; },
  SuspendedAccountViewer: (props: Record<string, unknown>) => { viewers.account = props; return <div data-testid="account-viewer" />; },
}));

const SUBJECT = "a".repeat(64);
const TARGET = "c".repeat(64);
const suspended: AccountStatusResponse = { success: true, status: "suspended" };
const active: AccountStatusResponse = { success: true, status: "active" };
const banned: AccountStatusResponse = { success: true, status: "banned" };
const missing: ReportedEventResult = { status: "target_missing", targetEventId: TARGET };

const base = {
  postCount: 0,
  contentLoading: false,
  contentError: false,
  recentPosts: [] as never[],
  hasReportId: true,
  reportedEvent: missing,
  subjectPubkey: SUBJECT,
};

beforeEach(() => {
  viewers.post = null;
  viewers.account = null;
});

describe("AgeReviewContent suspended-content viewer", () => {
  it("offers the reported post and the account's posts for a suspended subject", () => {
    render(<AgeReviewContent {...base} accountStatus={suspended} />);

    expect(screen.getByText(/hidden by the account's suspension/)).toBeInTheDocument();
    // The id is the report's target, so the viewer checks its author against the subject.
    expect(viewers.post).toMatchObject({ eventId: TARGET, surface: "age-review", showMediaByDefault: false, expectedAuthor: SUBJECT });
    expect(viewers.account).toMatchObject({ pubkey: SUBJECT, surface: "age-review", showMediaByDefault: false });
  });

  it.each([["active", active], ["banned", banned], ["unknown", undefined]] as const)(
    "offers neither for a %s subject", (_name, accountStatus) => {
      render(<AgeReviewContent {...base} accountStatus={accountStatus} />);

      expect(screen.queryByTestId("post-viewer")).not.toBeInTheDocument();
      expect(screen.queryByTestId("account-viewer")).not.toBeInTheDocument();
    },
  );

  // A post count cached from before the suspension makes the content section
  // read "has content", but keycast confirms the suspension: still offer it.
  it("offers the account viewer for a confirmed suspension even with a cached nonzero post count", () => {
    render(<AgeReviewContent {...base} accountStatus={suspended} postCount={3} recentPosts={[{ id: "e".repeat(64), pubkey: SUBJECT, created_at: 1, kind: 1, tags: [], content: "cached", sig: "" }] as never[]} />);

    expect(viewers.account).toMatchObject({ pubkey: SUBJECT, surface: "age-review", showMediaByDefault: false });
  });

  it("offers no post viewer when the report targets the account, not a post", () => {
    render(<AgeReviewContent {...base} accountStatus={suspended} reportedEvent={{ status: "account_level" }} />);

    expect(screen.queryByTestId("post-viewer")).not.toBeInTheDocument();
    expect(screen.getByTestId("account-viewer")).toBeInTheDocument();
  });

  it("offers no account viewer without the subject's pubkey", () => {
    render(<AgeReviewContent {...base} accountStatus={suspended} subjectPubkey={undefined} />);

    expect(screen.queryByTestId("account-viewer")).not.toBeInTheDocument();
  });

  it("offers no account viewer for a subject pubkey that is not 64 hex", () => {
    render(<AgeReviewContent {...base} accountStatus={suspended} subjectPubkey="nope" />);

    expect(screen.queryByTestId("account-viewer")).not.toBeInTheDocument();
  });

  it("offers no post viewer for a target id that is not 64 hex", () => {
    render(<AgeReviewContent {...base} accountStatus={suspended} reportedEvent={{ status: "target_missing", targetEventId: "nope" }} />);

    expect(screen.queryByTestId("post-viewer")).not.toBeInTheDocument();
  });
});
