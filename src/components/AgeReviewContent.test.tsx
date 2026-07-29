import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AgeReviewContent } from "./AgeReviewContent";
import type { AccountStatusResponse } from "@/lib/adminApi";
import type { ReportedEventResult } from "@/hooks/useReportedEvent";

// Isolate from MediaPreview's media-fetch/proxy logic.
vi.mock("@/components/MediaPreview", () => ({
  MediaPreview: ({ event }: { event: { id: string } }) => (
    <div data-testid="media-preview">{event.id}</div>
  ),
}));

const active: AccountStatusResponse = { success: true, status: "active" };
const suspended: AccountStatusResponse = { success: true, status: "suspended" };
const banned: AccountStatusResponse = { success: true, status: "banned" };
const statusUnavailable: AccountStatusResponse = { success: false };

function ev(id: string) {
  return { id, pubkey: "b".repeat(64), created_at: 1751000000, kind: 34235, tags: [], content: "a clip", sig: "" } as never;
}

const found = (event: ReturnType<typeof ev>, isBanned = false): ReportedEventResult =>
  ({ status: "found", event, banned: isBanned });

// Account status resolved and says "active" unless a test says otherwise, so
// the absent/unknown distinction is exercised deliberately rather than by default.
const base = {
  postCount: 0,
  contentLoading: false,
  contentError: false,
  accountStatus: active,
  accountStatusLoading: false,
  accountStatusFailed: false,
  recentPosts: [] as never[],
};

describe("AgeReviewContent: account content", () => {
  it("renders the target's recent content when present", () => {
    render(<AgeReviewContent {...base} postCount={2} recentPosts={[ev("1".repeat(64)), ev("2".repeat(64))]} />);
    expect(screen.getByText(/recent content \(2\)/i)).toBeInTheDocument();
    expect(screen.getAllByTestId("media-preview")).toHaveLength(2);
  });

  it("labels suspended content as hidden by suspension (not blank)", () => {
    render(<AgeReviewContent {...base} accountStatus={suspended} />);
    expect(screen.getByText(/hidden by suspension/i)).toBeInTheDocument();
    expect(screen.queryByTestId("media-preview")).not.toBeInTheDocument();
  });

  it("labels banned content as removed", () => {
    render(<AgeReviewContent {...base} accountStatus={banned} />);
    expect(screen.getByText(/removed \(account banned\)/i)).toBeInTheDocument();
  });

  it("surfaces a load error (with retry) rather than claiming absent", () => {
    const onRetry = vi.fn();
    render(<AgeReviewContent {...base} postCount={undefined} contentError={true} onRetry={onRetry} />);
    expect(screen.getByText(/couldn't load/i)).toBeInTheDocument();
    expect(screen.queryByText(/no content found/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("treats a truncated relay read as an error, never as absence", () => {
    // NPool.query resolves with partial results instead of throwing, so a cut-short
    // read arrives as postCount 0 with no error flag. It must not read as "absent".
    render(<AgeReviewContent {...base} postCount={0} contentIncomplete={true} />);
    expect(screen.getByText(/couldn't load/i)).toBeInTheDocument();
    expect(screen.queryByText(/no content found/i)).not.toBeInTheDocument();
  });

  it("states confirmed-absent only when the account is known not suspended", () => {
    render(<AgeReviewContent {...base} accountStatus={active} />);
    expect(screen.getByText(/no content found/i)).toBeInTheDocument();
    expect(screen.getByText(/not suspended/i)).toBeInTheDocument();
  });

  it("does not rule out suspension when account status is unavailable", () => {
    render(<AgeReviewContent {...base} accountStatus={statusUnavailable} accountStatusFailed />);
    expect(screen.getByText(/suspension cannot be ruled out/i)).toBeInTheDocument();
  });

  it("does not rule out suspension while account status is still loading", () => {
    render(<AgeReviewContent {...base} accountStatus={undefined} accountStatusLoading />);
    expect(screen.getByText(/suspension cannot be ruled out/i)).toBeInTheDocument();
  });
});

describe("AgeReviewContent: reported content", () => {
  it("shows the resolved reported event (no banned badge)", () => {
    render(<AgeReviewContent {...base} hasReportId reportedEvent={found(ev("f".repeat(64)))} />);
    expect(screen.getByText(/reported content/i)).toBeInTheDocument();
    expect(screen.queryByText(/removed \(banned\)/i)).not.toBeInTheDocument();
  });

  it("badges a reported event retrieved via getbannedevent as removed", () => {
    render(<AgeReviewContent {...base} hasReportId reportedEvent={found(ev("f".repeat(64)), true)} />);
    expect(screen.getByText(/removed \(banned\)/i)).toBeInTheDocument();
  });

  it("dedupes the reported event from the recent-content list", () => {
    const shared = ev("f".repeat(64));
    render(
      <AgeReviewContent
        {...base}
        postCount={2}
        recentPosts={[shared, ev("1".repeat(64))]}
        hasReportId
        reportedEvent={found(shared)}
      />,
    );
    expect(screen.getAllByTestId("media-preview")).toHaveLength(2);
    expect(screen.getByText(/recent content \(1\)/i)).toBeInTheDocument();
  });

  it("explains an account-level report instead of implying a missing post", () => {
    render(<AgeReviewContent {...base} hasReportId reportedEvent={{ status: "account_level" }} />);
    expect(screen.getByText(/filed against the account/i)).toBeInTheDocument();
    expect(screen.queryByText(/not retrievable/i)).not.toBeInTheDocument();
  });

  it("says when the report event itself is gone", () => {
    render(<AgeReviewContent {...base} hasReportId reportedEvent={{ status: "report_missing" }} />);
    expect(screen.getByText(/report event is no longer on the relay/i)).toBeInTheDocument();
  });

  it("says the target is not retrievable when the account is not under enforcement", () => {
    render(
      <AgeReviewContent
        {...base}
        hasReportId
        reportedEvent={{ status: "target_missing", targetEventId: "a".repeat(64) }}
      />,
    );
    expect(screen.getByText(/not retrievable/i)).toBeInTheDocument();
  });

  it("blames suspension, not deletion, when the target is hidden by a suspended account", () => {
    // Suspension hides the account's events and getbannedevent only knows per-event
    // bans, so without the account-status ladder this reads as "deleted".
    render(
      <AgeReviewContent
        {...base}
        accountStatus={suspended}
        hasReportId
        reportedEvent={{ status: "target_missing", targetEventId: "a".repeat(64) }}
      />,
    );
    expect(screen.getByText(/hidden by the account's suspension/i)).toBeInTheDocument();
    expect(screen.queryByText(/deleted, aged out/i)).not.toBeInTheDocument();
  });

  it("attributes a missing target to the ban when the account is banned", () => {
    render(
      <AgeReviewContent
        {...base}
        accountStatus={banned}
        hasReportId
        reportedEvent={{ status: "target_missing", targetEventId: "a".repeat(64) }}
      />,
    );
    expect(screen.getByText(/removed with the account ban/i)).toBeInTheDocument();
  });

  it("labels a reported-event load error (with retry), not as absent", () => {
    const onRetryReported = vi.fn();
    render(
      <AgeReviewContent
        {...base}
        hasReportId
        reportedEvent={undefined}
        reportedEventError
        onRetryReported={onRetryReported}
      />,
    );
    expect(screen.getByText(/couldn't load the reported content/i)).toBeInTheDocument();
    expect(screen.queryByText(/not retrievable/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("shows a loading state while the lookup is in flight, never a missing-content claim", () => {
    render(<AgeReviewContent {...base} hasReportId reportedEvent={undefined} reportedEventLoading />);
    expect(screen.getByText(/loading reported content/i)).toBeInTheDocument();
    expect(screen.queryByText(/not retrievable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no longer on the relay/i)).not.toBeInTheDocument();
  });

  it("omits the reported section entirely for a case with no report", () => {
    render(<AgeReviewContent {...base} hasReportId={false} reportedEvent={undefined} />);
    expect(screen.queryByText(/reported content/i)).not.toBeInTheDocument();
  });

  it("does not render a bare heading when there is nothing to say yet", () => {
    // Idle: a report id exists but the lookup has not resolved, errored, or
    // started. A lone "Reported content" label over empty space reads as though
    // something failed to render.
    render(<AgeReviewContent {...base} hasReportId reportedEvent={undefined} reportedEventLoading={false} />);
    expect(screen.queryByText(/reported content/i)).not.toBeInTheDocument();
  });
});
