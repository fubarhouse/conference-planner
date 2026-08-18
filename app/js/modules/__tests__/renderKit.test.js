import { describe, it, expect } from 'vitest';
import { removeIconBtn, emptyStateP } from '../renderKit.js';

describe('removeIconBtn', () => {
  // These used to assert the exact Tailwind class string and the Font Awesome
  // <i>, which is what pinned them to a look rather than to a contract. What
  // callers actually depend on: their hook class is present (they delegate
  // clicks off it), their data attributes survive, the accessible name is set,
  // and the control says "Remove" in words.
  it('puts the hook class first so click delegation still finds it', () => {
    const html = removeIconBtn({
      hook: 'remove-leg-btn',
      data: 'data-leg-id="l1" data-direction="outbound"',
      label: 'Remove leg',
    });
    expect(html).toContain('class="remove-leg-btn');
    expect(html).toContain('data-leg-id="l1" data-direction="outbound"');
    expect(html).toContain('aria-label="Remove leg"');
  });

  it('labels itself in words, not an icon font', () => {
    const html = removeIconBtn({ hook: 'x-btn', label: 'Remove' });
    expect(html).toContain('>Remove</button>');
    expect(html).not.toContain('<i ');
    expect(html).not.toContain('fa-');
  });

  it('appends extraClass modifiers after the base', () => {
    const html = removeIconBtn({
      hook: 'delete-accommodation-btn',
      data: 'data-accom-id="a1"',
      label: 'Remove Hotel',
      extraClass: 'is-inline',
    });
    expect(html).toContain('class="delete-accommodation-btn pl-act pl-act--del is-inline"');
  });

  it('omits the data attribute segment when none is given', () => {
    expect(removeIconBtn({ hook: 'x-btn', label: 'Remove' })).toBe(
      '<button type="button" class="x-btn pl-act pl-act--del" aria-label="Remove">Remove</button>',
    );
  });
});

describe('emptyStateP', () => {
  it('renders the shared empty-state paragraph', () => {
    expect(emptyStateP('No legs yet.')).toBe('<p class="cmp-none">No legs yet.</p>');
  });

  it('accepts a custom class', () => {
    expect(emptyStateP('None', 'text-sm')).toBe('<p class="text-sm">None</p>');
  });
});
