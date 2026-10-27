// ABOUTME: Finds the reporting-app line by its visible text. The line splits that
// ABOUTME: text across <bdi> elements, so a plain string query no longer matches it.

import type { Matcher } from '@testing-library/react';

/** Matches the element whose whole visible text is `text` and that carries the line's hover title. */
export function appLine(text: string): Matcher {
  return (_content, element) => element?.hasAttribute('title') === true && element.textContent === text;
}
