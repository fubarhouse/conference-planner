// Paging the recordings grid used to re-render the whole panel, which meant a
// "Show more" click threw the reader back to the top of the page. Appending
// instead put two decisions on the critical path: what the count line says once
// part of a result set is on screen, and when the button stops offering more.
import { describe, it, expect } from 'vitest';
import { videoCountLine, videoMoreHtml, videoMoreLabel } from '../archiveDashboard.js';

const VIDEO_PAGE = 60;

describe('videoCountLine', () => {
  it('names the total and, while paging, how much of it is on screen', () => {
    expect(videoCountLine(2110, 60, '', 'across every series')).toBe(
      '2,110 recordings across every series · showing 60',
    );
    expect(videoCountLine(2110, 120, '', 'across every series')).toBe(
      '2,110 recordings across every series · showing 120',
    );
  });

  it('drops the "showing" clause once everything is on the page', () => {
    // Otherwise the last page reads "42 recordings · showing 42", which invites
    // the reader to look for a Show more button that is no longer there.
    expect(videoCountLine(42, 42, '', 'in 2024')).toBe('42 recordings in 2024');
  });

  it('quotes the query when there is one', () => {
    expect(videoCountLine(7, 7, 'varnish', 'in 2025')).toBe('7 recordings match “varnish” in 2025');
  });

  it('agrees in number with a single result', () => {
    expect(videoCountLine(1, 1, '', 'in 2021')).toBe('1 recording in 2021');
  });

  it('returns plain text, not markup', () => {
    // Paging assigns this to textContent; an escaped ampersand would reach the
    // reader as "&amp;". Escaping is the render path's job, not this one's.
    expect(videoCountLine(3, 3, 'r&d', 'in 2024')).toBe('3 recordings match “r&d” in 2024');
  });
});

describe('videoMoreLabel', () => {
  it('offers a whole page when more than a page remains', () => {
    expect(videoMoreLabel(2110, 60)).toBe(`Show ${VIDEO_PAGE} more`);
  });

  it('offers only what is left on the final page', () => {
    expect(videoMoreLabel(70, 60)).toBe('Show 10 more');
  });

  it('never offers a negative remainder', () => {
    // The total can shrink under a stale button if the scope changed mid-flight.
    expect(videoMoreLabel(60, 120)).toBe('Show 0 more');
  });
});

describe('videoMoreHtml', () => {
  it('renders a button the click handler can find while results remain', () => {
    const html = videoMoreHtml(2110, 60);
    expect(html).toContain('data-vid-more="1"');
    expect(html).toContain('Show 60 more');
  });

  it('renders nothing once the whole result set is shown', () => {
    expect(videoMoreHtml(42, 42)).toBe('');
    expect(videoMoreHtml(0, 0)).toBe('');
  });
});
