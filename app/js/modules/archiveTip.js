// "Tell us about a conference" — the reader's side of the suggestion box.
//
// Nineteen years of events are in here because somebody knew about them. This is
// the way to say "you're missing one" without hunting for an email address.
//
// A native <dialog>: the browser gives focus trapping, Escape, the backdrop and
// `inert` on everything behind it, and every one of those is a thing this would
// otherwise have to reimplement and get subtly wrong. The archive does not load
// planner.css, so the styling is the archive's own `obs-*` vocabulary rather
// than `.pl-modal-*` — see the CSS split note in CLAUDE.md.

// The caps are repeated here rather than imported from lib/suggestions.js: that
// module reads node:fs, so the browser cannot load it. The server re-validates
// and truncates every field regardless — these numbers only decide when the
// counter turns red, so drifting apart degrades the hint, not the data.
const MAX = { name: 120, url: 300, notes: 256 };

let dialog = null;

function build() {
  const el = document.createElement('dialog');
  el.className = 'obs-tip';
  el.id = 'obsTipDialog';
  el.innerHTML = `
    <form method="dialog" class="obs-tip-form" id="obsTipForm" novalidate>
      <div class="obs-tip-head">
        <span class="obs-eyebrow">Help the archive</span>
        <h2 class="obs-tip-title">Tell us about a conference</h2>
        <p class="obs-tip-lede">Know an event that should be in here? A name and a link is plenty — we will do the digging.</p>
      </div>
      <label class="obs-tip-l" for="obsTipName">Conference name</label>
      <input id="obsTipName" name="name" class="obs-tip-input" maxlength="${MAX.name}"
             required autocomplete="off" placeholder="DrupalCamp Ghent">
      <label class="obs-tip-l" for="obsTipUrl">Website <span class="obs-tip-opt">optional</span></label>
      <input id="obsTipUrl" name="url" class="obs-tip-input" maxlength="${MAX.url}"
             inputmode="url" autocomplete="off" placeholder="drupalcamp.be">
      <label class="obs-tip-l" for="obsTipNotes">Anything else <span class="obs-tip-opt">optional</span></label>
      <textarea id="obsTipNotes" name="notes" class="obs-tip-input obs-tip-area" rows="3"
                maxlength="${MAX.notes}" placeholder="Which years are missing, where the programme lives, or how to reach you."></textarea>
      <div class="obs-tip-count" id="obsTipCount">${MAX.notes} left</div>
      <p class="obs-tip-msg" id="obsTipMsg" role="status" aria-live="polite"></p>
      <div class="obs-tip-foot">
        <button type="button" class="obs-more" id="obsTipCancel">Cancel</button>
        <button type="submit" class="obs-more obs-more--go" id="obsTipSend">Send</button>
      </div>
    </form>`;
  document.body.appendChild(el);

  const notes = el.querySelector('#obsTipNotes');
  const count = el.querySelector('#obsTipCount');
  notes.addEventListener('input', () => {
    const left = MAX.notes - notes.value.length;
    count.textContent = `${left} left`;
    count.classList.toggle('is-tight', left <= 20);
  });

  el.querySelector('#obsTipCancel').addEventListener('click', () => el.close());
  el.querySelector('#obsTipForm').addEventListener('submit', (e) => {
    // The form is method="dialog", which would close on submit before anything
    // is sent. Take the event over.
    e.preventDefault();
    send(el);
  });
  return el;
}

async function send(el) {
  const msg = el.querySelector('#obsTipMsg');
  const btn = el.querySelector('#obsTipSend');
  const body = {
    name: el.querySelector('#obsTipName').value,
    url: el.querySelector('#obsTipUrl').value,
    notes: el.querySelector('#obsTipNotes').value,
  };
  msg.className = 'obs-tip-msg';
  msg.textContent = 'Sending…';
  btn.disabled = true;
  try {
    const r = await fetch(new URL('../../api/curation/suggestions', import.meta.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      // The server's own words: it knows about rate limits and bad links, and
      // inventing a friendlier message here would hide which one happened.
      msg.className = 'obs-tip-msg is-bad';
      msg.textContent = out.error || 'That did not send. Try again shortly.';
      btn.disabled = false;
      return;
    }
    msg.className = 'obs-tip-msg is-good';
    msg.textContent = 'Thank you — it is in the queue.';
    el.querySelector('#obsTipForm').reset();
    setTimeout(() => el.close(), 1400);
  } catch {
    msg.className = 'obs-tip-msg is-bad';
    msg.textContent = 'No connection. Try again when you are back online.';
  } finally {
    btn.disabled = false;
  }
}

/** Open the suggestion box, building it the first time it is asked for. */
function openTipDialog() {
  dialog ??= build();
  const msg = dialog.querySelector('#obsTipMsg');
  msg.textContent = '';
  msg.className = 'obs-tip-msg';
  dialog.showModal();
  dialog.querySelector('#obsTipName').focus();
}

/** The call to action itself — rendered wherever the archive has room for it. */
export function tipPromptHtml() {
  return `<div class="obs-tip-cta">
    <p class="obs-tip-cta-t">Missing a conference?</p>
    <p class="obs-tip-cta-s">This archive is only as complete as what we know about.</p>
    <button type="button" class="obs-more" data-tip-open="1">Tell us about one</button>
  </div>`;
}

// Delegated, so the prompt can be re-rendered with the rest of a tab without
// anything needing to re-bind it.
export function wireTipPrompt(root = document) {
  root.addEventListener('click', (e) => {
    if (e.target.closest?.('[data-tip-open]')) openTipDialog();
  });
}
