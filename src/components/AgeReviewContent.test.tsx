import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AgeReviewContent } from "./AgeReviewContent";
import type { AccountStatusResponse } from "@/lib/adminApi";

// Isolate from MediaPreview's media-fetch/proxy logic.
vi.mock("@/components/MediaPreview", () => ({
  MediaPreview: ({ event }: { event: { id: string } }) => (
    <div data-testid="media-preview">{event.id}</div>
  ),
}));

const active: AccountStatusResponse = { success: true, status: "active" };
const suspended: AccountStatusResponse = { success: true, status: "suspended" };
const banned: AccountStatusResponse = { success: true, status: "banned" };

function ev(id: string) {
  return { id, pubkey: "b".repeat(64), created_at: 1751000000, kind: 34235, tags: [], content: "a clip", sig: "" } as never;
}

const base = { postCount: 0, contentLoading: false, contentError: false, accountStatus: active, recentPosts: [] as never[] };
const reported = (event: ReturnType<typeof ev>, banned: boolean) => ({ event, banned });

describe("AgeReviewContent", () => {
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

  it("states confirmed-absent explicitly, not blamed on suspension", () => {
    render(<AgeReviewContent {...base} accountStatus={active} />);
    expect(screen.getByText(/no content found/i)).toBeInTheDocument();
    expect(screen.getByText(/not attributable to suspension/i)).toBeInTheDocument();
  });

  it("shows the reported event (relay-visible, no banned badge)", () => {
    render(<AgeReviewContent {...base} hasReportId reportedEvent={reported(ev("f".repeat(64)), false)} />);
    expect(screen.getByText(/reported content/i)).toBeInTheDocument();
    expect(screen.queryByText(/removed \(banned\)/i)).not.toBeInTheDocument();
  });

  it("shows a banned reported event (via getbannedevent) badged as removed", () => {
    render(<AgeReviewContent {...base} hasReportId reportedEvent={reported(ev("f".repeat(64)), true)} />);
    expect(screen.getByText(/reported content/i)).toBeInTheDocument();
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
        reportedEvent={reported(shared, false)}
      />,
    );
    // reported event + one other post = 2 MediaPreviews, not 3
    expect(screen.getAllByTestId("media-preview")).toHaveLength(2);
    expect(screen.getByText(/recent content \(1\)/i)).toBeInTheDocument();
  });

  it("states when the reported event is not found (and there was a report id)", () => {
    render(<AgeReviewContent {...base} hasReportId reportedEvent={null} reportedEventLoading={false} />);
    expect(screen.getByText(/not on the relay/i)).toBeInTheDocument();
  });

  it("labels a reported-event load error (with retry), not as absent", () => {
    const onRetryReported = vi.fn();
    render(
      <AgeReviewContent
        {...base}
        hasReportId
        reportedEvent={undefined}
        reportedEventLoading={false}
        reportedEventError
        onRetryReported={onRetryReported}
      />,
    );
    expect(screen.getByText(/couldn't load the reported event/i)).toBeInTheDocument();
    expect(screen.queryByText(/not on the relay/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
