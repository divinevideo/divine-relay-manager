// ABOUTME: Whether media that may be sensitive (post media, profile images) is showing: follows
// ABOUTME: a default that can arrive late or turn sensitive, and the moderator's own Show or Hide

import { useState } from "react";

type MediaChoice = 'show' | 'hide' | null;

interface MediaVisibility {
  show: boolean;
  // The moderator's last Show or Hide, if any.
  choice: MediaChoice;
  // The props `show` was last worked out from.
  showByDefault: boolean | null;
  resetKey?: string;
}

// Whether the media is showing. The default can arrive after mount (report
// classification loads async), so it is followed as it changes:
// - to false: hide, and forget a choice to show, so a Show from a report whose
//   media showed by default does not carry into a sensitive one when the pane
//   is reused. A choice to hide is kept. Callers that cannot tell pass false
//   for a sensitive report and also for one whose reports are not known yet.
//   A default that stays false is no change, so a Show made under it is kept.
// - to null (not known yet): no change. Media starts hidden under null, and
//   a later false counts as a change, so a Show made meanwhile is forgotten.
// - to true: show, unless the moderator has chosen.
// A new resetKey (the event shown) starts again from its default.
//
// Worked out during render, not in an effect: an effect would first commit
// the old state with the new props, and a browser starts loading any media
// that commit mounts.
export function useMediaVisibility(showByDefault: boolean | null, resetKey?: string): [boolean, () => void] {
  const [state, setState] = useState<MediaVisibility>({ show: showByDefault === true, choice: null, showByDefault, resetKey });

  let next = state;
  if (resetKey !== state.resetKey) {
    next = { show: showByDefault === true, choice: null, showByDefault, resetKey };
  } else if (showByDefault !== state.showByDefault) {
    next = showByDefault === true
      ? { ...state, showByDefault, show: state.choice === null ? true : state.show }
      : showByDefault === false
        ? { ...state, showByDefault, show: false, choice: state.choice === 'show' ? null : state.choice }
        : { ...state, showByDefault };
  }
  if (next !== state) setState(next);

  const toggle = () => setState(s => ({ ...s, show: !s.show, choice: s.show ? 'hide' : 'show' }));
  return [next.show, toggle];
}
