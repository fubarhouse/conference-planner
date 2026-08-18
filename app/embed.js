/* Conference schedule embed — host-side helper.
 *
 * Include once on any page that embeds our schedule:
 *   <script src="https://YOUR-HOST/embed.js" async></script>
 *
 * Provides two things:
 *
 *  1. A <conference-schedule> custom element. Drop the tag anywhere and it builds
 *     the schedule iframe for you (no raw iframe markup) and auto-sizes it:
 *       <conference-schedule id="my-event-id" theme="drupalcon-dark"
 *                            sponsors="0" related="0"></conference-schedule>
 *     Attributes: id (event id, required; `event`/`data-event` also accepted),
 *     theme (theme id), sponsors/related ("0" to hide), view, height, title,
 *     origin (override the host the schedule is served from).
 *
 *  2. Auto-height for any embedded schedule (?embed=1) — the element above OR a
 *     hand-written iframe. The embedded page posts its content height via
 *     postMessage and we resize the matching iframe so it flows in the host page
 *     instead of showing a nested scrollbar.
 *
 * Plain IIFE, no dependencies, no framework. */
(function () {
  'use strict';

  // Derive our own origin from this script's URL so a cross-origin host can still
  // build same-host schedule URLs. Falls back to the host page's origin.
  var SELF = (document.currentScript && document.currentScript.src) || '';
  var ORIGIN;
  try {
    ORIGIN = SELF ? new URL(SELF).origin : window.location.origin;
  } catch (e) {
    ORIGIN = window.location.origin;
  }

  // ── 1. auto-height ────────────────────────────────────────────────────────
  function isEmbedFrame(f) {
    return f && f.src && f.src.indexOf('embed=1') !== -1;
  }

  window.addEventListener(
    'message',
    function (e) {
      var d = e && e.data;
      if (!d || d.type !== 'cesx-embed-height' || typeof d.height !== 'number') return;

      var frames = document.getElementsByTagName('iframe');
      var i;
      var target = null;

      // Prefer the exact frame that sent the message (robust with several embeds).
      for (i = 0; i < frames.length; i++) {
        if (frames[i].contentWindow === e.source) {
          target = frames[i];
          break;
        }
      }
      // Fallback: the single embed frame on the page.
      if (!target) {
        var embeds = [];
        for (i = 0; i < frames.length; i++) {
          if (isEmbedFrame(frames[i])) embeds.push(frames[i]);
        }
        if (embeds.length === 1) target = embeds[0];
      }

      if (target) target.style.height = Math.max(0, d.height) + 'px';
    },
    false,
  );

  // ── 2. <conference-schedule> custom element ───────────────────────────────
  function attr(el, names) {
    for (var i = 0; i < names.length; i++) {
      var v = el.getAttribute(names[i]);
      if (v !== null && v !== '') return v;
    }
    return null;
  }

  function buildScheduleSrc(el) {
    var origin = (attr(el, ['origin']) || ORIGIN).replace(/\/+$/, '');
    var params = [];
    var id = attr(el, ['event', 'data-event', 'id']);
    if (id) params.push('id=' + encodeURIComponent(id));
    params.push('embed=1');
    var theme = attr(el, ['theme']);
    if (theme) params.push('theme=' + encodeURIComponent(theme));
    var view = attr(el, ['view']);
    if (view) params.push('view=' + encodeURIComponent(view));
    if (attr(el, ['sponsors']) === '0') params.push('sponsors=0');
    if (attr(el, ['related']) === '0') params.push('related=0');
    return origin + '/index.html?' + params.join('&');
  }

  function initialHeight(el) {
    var h = attr(el, ['height']);
    if (!h) return '600px';
    return /^\d+$/.test(h) ? h + 'px' : h;
  }

  // Custom elements v1 require ES class syntax — always available where
  // window.customElements exists, so this is safe without a build step.
  if (window.customElements && !window.customElements.get('conference-schedule')) {
    class ConferenceSchedule extends HTMLElement {
      connectedCallback() {
        if (this._mounted) return;
        this._mounted = true;

        this.style.display = 'block';

        const iframe = document.createElement('iframe');
        iframe.src = buildScheduleSrc(this);
        iframe.title = attr(this, ['title']) || 'Event schedule';
        iframe.loading = 'lazy';
        iframe.setAttribute('scrolling', 'no');
        iframe.style.width = '100%';
        iframe.style.border = '0';
        iframe.style.display = 'block';
        iframe.style.height = initialHeight(this);

        this.appendChild(iframe);
        this._iframe = iframe;
      }
    }

    window.customElements.define('conference-schedule', ConferenceSchedule);
  }
})();
