import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// notify.js touches the DOM (document, requestAnimationFrame) but the test suite
// runs in plain node, so stub a minimal DOM before importing the module — the
// same manual-stub approach used by the other tests in this folder.

function makeElement() {
  const classes = new Set();
  return {
    id: '',
    className: '',
    innerHTML: '',
    _classes: classes,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
    },
    setAttribute: () => {},
    appendChild: () => {},
    querySelector: () => ({ addEventListener: () => {} }),
    addEventListener: () => {},
  };
}

const byId = new Map();
const created = [];

vi.stubGlobal('document', {
  getElementById: (id) => byId.get(id) ?? null,
  createElement: () => {
    const el = makeElement();
    created.push(el);
    return el;
  },
  body: { appendChild: () => {} },
});
vi.stubGlobal('requestAnimationFrame', (fn) => fn());

const { showToast, reportError } = await import('../notify.js');

describe('reportError', () => {
  beforeEach(() => {
    created.length = 0;
    byId.clear();
    vi.restoreAllMocks();
  });

  it('always logs with the context prefix and the error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('boom');
    reportError('loadThemes', err);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toBe('[loadThemes]');
    expect(spy.mock.calls[0][1]).toBe(err);
  });

  it('does not create a toast when toast is not requested', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    reportError('silent path', new Error('x'));
    expect(created).toHaveLength(0);
  });

  it('creates and shows an error toast when toast is requested', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    reportError('save', new Error('x'), { toast: true, message: 'Save failed' });
    expect(created).toHaveLength(1);
    expect(created[0].innerHTML).toContain('Save failed');
    expect(created[0].classList.contains('opacity-100')).toBe(true);
  });
});

describe('showToast', () => {
  beforeEach(() => {
    byId.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds is-visible to the target element and removes it after the duration', () => {
    const el = makeElement();
    byId.set('plannerSaveToast', el);
    showToast('plannerSaveToast', 2500);
    expect(el.classList.contains('is-visible')).toBe(true);
    vi.advanceTimersByTime(2500);
    expect(el.classList.contains('is-visible')).toBe(false);
  });

  it('is a no-op when the target element is absent', () => {
    expect(() => showToast('missingToast')).not.toThrow();
  });
});
