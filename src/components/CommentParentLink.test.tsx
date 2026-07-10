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
