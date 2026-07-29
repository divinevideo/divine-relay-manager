import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AgeReviewContent } from "./AgeReviewContent";
import type { AccountStatusResponse } from "@/lib/adminApi";
import type { ReportedEventResult } from "@/hooks/useReportedEvent";

// A stateful stand-in for MediaPreview. The real component holds `showMedia` in
// state and its reset effect only clears `userToggledRef` on an event change, so
// a revealed clip stays revealed when the same element is reused for another
// event. This mock reproduces that retention so the guard (a key on the reported
// card) is actually exercised rather than assumed.
vi.mock("@/components/MediaPreview", async () => {
  const { useState } = await import("react");
  return {
    MediaPreview: ({ event }: { event: { id: string } }) => {
      const [shown, setShown] = useState(false);
      return (
        <div data-testid="media-preview">
          <span>{event.id}</span>
          <button onClick={() => setShown(true)}>{shown ? "revealed" : "reveal"}</button>
        </div>
      );
    },
  };
});

const active: AccountStatusResponse = { success: true, status: "active" };

function ev(id: string) {
  return { id, pubkey: "d4".repeat(32), created_at: 1751000000, kind: 34235, tags: [], content: "", sig: "" } as never;
}
const found = (event: ReturnType<typeof ev>): ReportedEventResult => ({ status: "found", event, banned: false });

const base = {
  postCount: 0,
  contentLoading: false,
  contentError: false,
  accountStatus: active,
  accountStatusLoading: false,
  accountStatusFailed: false,
  recentPosts: [] as never[],
  hasReportId: true,
};

describe("AgeReviewContent reveal state", () => {
  it("does not carry a revealed clip over to the next case", () => {
    const caseA = ev("a1".repeat(32));
    const caseB = ev("b2".repeat(32));

    const { rerender } = render(<AgeReviewContent {...base} reportedEvent={found(caseA)} />);

    fireEvent.click(screen.getByRole("button", { name: "reveal" }));
    expect(screen.getByRole("button", { name: "revealed" })).toBeInTheDocument();

    // Same pane, different case. Media must be gated again: revealing content in
    // an under-16 review is a deliberate act, not a sticky preference.
    rerender(<AgeReviewContent {...base} reportedEvent={found(caseB)} />);

    expect(screen.getByText("b2".repeat(32))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "reveal" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "revealed" })).not.toBeInTheDocument();
  });
});
