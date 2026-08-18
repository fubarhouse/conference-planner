// The two new home views rest on three pure decisions: which host a recording
// lives on, whether we can show a still for it, and which events have an album
// worth listing. Everything else is markup around those answers.
import { describe, it, expect } from 'vitest';
import { videoRef, videoThumb, albumRows } from '../archiveDashboard.js';

describe('videoRef', () => {
  it('reads an id from every YouTube URL shape the archive holds', () => {
    // All four appear in the data: watch links with and without extra params,
    // youtu.be shorteners, and the embed form left by an old scrape.
    for (const url of [
      'https://www.youtube.com/watch?v=PCLx4fRHmCk',
      'https://www.youtube.com/watch?v=PCLx4fRHmCk&list=PLpeDXSh4nHjQ',
      'https://www.youtube.com/watch?feature=player_embedded&v=PCLx4fRHmCk',
      'https://youtu.be/PCLx4fRHmCk',
      'https://www.youtube.com/embed/PCLx4fRHmCk?rel=0',
    ]) {
      expect(videoRef(url), url).toEqual({ host: 'YouTube', id: 'PCLx4fRHmCk' });
    }
  });

  it('names other hosts without inventing an id', () => {
    // 245 recordings are not on YouTube; a thumbnail cannot be derived for them,
    // and pretending otherwise would render a broken image on every card.
    expect(videoRef('https://archive.org/details/drupalcon-2012')).toEqual({
      host: 'archive.org',
      id: '',
    });
    expect(videoRef('https://vimeo.com/12345')).toEqual({ host: 'Vimeo', id: '' });
    expect(videoRef('https://www.jacobsingh.name/talk.ogv').host).toBe('jacobsingh.name');
  });

  it('treats nothing as nothing rather than throwing', () => {
    expect(videoRef('')).toEqual({ host: '', id: '' });
    expect(videoRef(null)).toEqual({ host: '', id: '' });
    expect(videoRef('not a url')).toEqual({ host: '', id: '' });
  });
});

describe('videoThumb', () => {
  it('returns a still only when there is an id to build one from', () => {
    expect(videoThumb('https://youtu.be/PCLx4fRHmCk')).toBe(
      'https://i.ytimg.com/vi/PCLx4fRHmCk/mqdefault.jpg',
    );
    expect(videoThumb('https://archive.org/details/x')).toBe('');
    expect(videoThumb('')).toBe('');
  });
});

describe('albumRows', () => {
  const yearEvents = {
    2024: [
      { label: 'DrupalCon Barcelona 2024', album: 'https://flickr.com/groups/bcn/', sessions: 201 },
      { label: 'DrupalCon Portland 2024', album: null, sessions: 136 },
    ],
    2026: [
      {
        label: 'DrupalCamp Tokyo 2026',
        album: 'https://photos.app.goo.gl/abc',
        albumProvider: 'Google Photos',
        sessions: 12,
      },
    ],
  };

  it('lists only events that have an album, newest first', () => {
    const rows = albumRows(yearEvents);
    expect(rows.map((r) => r.label)).toEqual(['DrupalCamp Tokyo 2026', 'DrupalCon Barcelona 2024']);
  });

  it('names the provider from the URL when the dataset never recorded one', () => {
    // 21 of the 33 albums have a groupUrl but no provider — the host is the
    // honest answer, and it is what the card shows.
    const rows = albumRows(yearEvents);
    expect(rows.find((r) => r.year === 2024).provider).toBe('Flickr');
    expect(rows.find((r) => r.year === 2026).provider).toBe('Google Photos');
  });

  it('respects the scope filter the rest of the home page uses', () => {
    const rows = albumRows(yearEvents, (e) => e.year === 2024);
    expect(rows.map((r) => r.label)).toEqual(['DrupalCon Barcelona 2024']);
  });

  it('has nothing to say about an empty archive', () => {
    expect(albumRows({})).toEqual([]);
    expect(albumRows(undefined)).toEqual([]);
  });
});
