// Documents tab for the planner — aggregates every attached file across the trip
// (direct documents, travel-leg files, accommodation files, receipts) into one
// list, plus the add/edit document modal with upload. Extracted from planner.js
// following the plannerReceipts contract: planner-internal collaborators are
// supplied once via initDocuments(); shared field/format + storage/modal helpers
// are imported directly.

import { escapeHtml as esc } from './utils.js';
import { showModal, hideModal } from './modal.js';
import { showUndoToast } from './notify.js';
import { makeItemId } from './plannerStorage.js';
import { buildSelectOptions, fileDisplayName, syncModalFile } from './plannerFields.js';
import { sortLegs, TRAVEL_MODES } from './plannerTravel.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let scheduleAutoSave;
let getActiveBudgetCategoryOptions;
let uploadOrReadFile;
let deleteUploadedFile;
let resolveFileUrl;
// Source-editor openers, injected so a file/gap can jump to the entity it belongs to.
let openReceiptModal;
let openPersonalLegModal;
let openPersonalAccomModal;
let openAccommodationModal;
let openAssignmentModal;

export function initDocuments(deps) {
  ({
    state,
    scheduleAutoSave,
    getActiveBudgetCategoryOptions,
    uploadOrReadFile,
    deleteUploadedFile,
    resolveFileUrl,
    openReceiptModal,
    openPersonalLegModal,
    openPersonalAccomModal,
    openAccommodationModal,
    openAssignmentModal,
  } = deps);
}

function getDocCategoryOptions() {
  return [{ value: '', label: 'No category' }, ...getActiveBudgetCategoryOptions()];
}

function _legIcon(leg, isReturn) {
  const info = TRAVEL_MODES[leg.mode] || TRAVEL_MODES.other;
  return (isReturn ? info.returnIcon || info.icon : info.icon) || '';
}
function _route(leg) {
  return [leg.from, leg.to].filter(Boolean).join(' → ');
}

function collectDocuments() {
  const mode = state.planner.mode || 'personal';
  const docs = [];

  if (mode === 'personal') {
    // Personal legs + stays no longer carry their own file — their proof lives on a
    // linked receipt (surfaced under the Receipts group below).
    (state.planner.personal?.documents || []).forEach((d) => {
      docs.push({
        ...d,
        isDirect: true,
        sourceLabel: 'Personal document',
        nav: { kind: 'doc', id: d.id },
      });
    });
  } else {
    // Org legs/stays also prove themselves via linked receipts now (surfaced below).
    (state.planner.org?.documents || []).forEach((d) => {
      docs.push({
        ...d,
        isDirect: true,
        sourceLabel: 'Document',
        nav: { kind: 'doc', id: d.id },
      });
    });
  }

  // Receipts are planner-global (not mode-scoped), so surface their attachments in
  // both personal and sponsor modes — every entity's cost/file now lives on a receipt.
  (state.planner.receipts || []).forEach((r) => {
    if (!r.filePath) return;
    docs.push({
      id: `receipt-${r.id}`,
      name: fileDisplayName(r.filePath, r.fileLabel),
      filePath: r.filePath,
      isDirect: false,
      docType: 'receipt',
      date: r.date || '',
      category: r.category || '',
      sourceLabel: `Receipt${r.merchant ? ` · ${r.merchant}` : ''}`,
      nav: { kind: 'receipt', id: r.id },
    });
  });

  return docs;
}

// The trip's file-bearing entities that have NO file yet — the paper-trail gaps.
// Same nav targets as collectDocuments, so "Attach" jumps to the right editor.
function collectGaps() {
  const mode = state.planner.mode || 'personal';
  const gaps = [];
  const legReal = (l) => !!(l.date || l.from || l.to);
  const accReal = (a) => !!(a.name || a.checkIn);
  const rcReal = (r) => !!(r.name || r.amount);

  if (mode === 'personal') {
    // Personal legs/stays now prove themselves via a linked receipt, so the gap is
    // "no receipt linked" (the Attach action opens the editor's receipt picker).
    const p = state.planner.personal || {};
    [
      ['outboundLegs', 'Outbound', false, 'outbound'],
      ['returnLegs', 'Return', true, 'return'],
    ].forEach(([key, word, isRet, dir]) => {
      sortLegs(p[key] || []).forEach((leg) => {
        if (leg.receiptId || !legReal(leg)) return;
        const route = _route(leg);
        gaps.push({
          icon: _legIcon(leg, isRet),
          label: `${word} travel${route ? ` · ${route}` : ''}`,
          nav: { kind: 'pleg', id: leg.id, dir },
        });
      });
    });
    (p.accommodations || []).forEach((a) => {
      if (a.receiptId || !accReal(a)) return;
      gaps.push({
        label: `Accommodation${a.name ? ` · ${a.name}` : ''}`,
        nav: { kind: 'paccom', id: a.id },
      });
    });
  } else {
    const o = state.planner.org || {};
    (o.teamAssignments || []).forEach((a) => {
      const member = (state.global?.teamMembers || []).find((m) => m.id === a.memberId);
      const mn = member?.name || 'Team member';
      [
        ['outboundLegs', 'Outbound', false],
        ['returnLegs', 'Return', true],
      ].forEach(([key, word, isRet]) => {
        sortLegs(a[key] || []).forEach((leg) => {
          if (leg.receiptId || !legReal(leg)) return;
          const route = _route(leg);
          gaps.push({
            icon: _legIcon(leg, isRet),
            label: `${mn} · ${word}${route ? ` · ${route}` : ''}`,
            nav: { kind: 'tleg', member: a.memberId },
          });
        });
      });
    });
    (o.accommodations || []).forEach((a) => {
      if (a.receiptId || !accReal(a)) return;
      gaps.push({
        label: `Team accommodation${a.name ? ` · ${a.name}` : ''}`,
        nav: { kind: 'oaccom', id: a.id },
      });
    });
  }

  (state.planner.receipts || []).forEach((r) => {
    if (r.filePath || !rcReal(r)) return;
    gaps.push({
      label: `Receipt${r.name ? ` · ${r.name}` : ''}`,
      nav: { kind: 'receipt', id: r.id },
    });
  });

  return gaps;
}

// Classify a file by path/extension into a type chip (+ thumbnail for images).
function fileKind(path) {
  const p = String(path || '');
  if (/^data:image\//.test(p) || /\.(png|jpe?g|webp|gif|avif)$/i.test(p))
    return { kind: 'img', ext: (p.match(/\.(\w+)$/)?.[1] || 'IMG').toUpperCase() };
  if (/\.pdf$/i.test(p) || /^data:application\/pdf/.test(p)) return { kind: 'pdf', ext: 'PDF' };
  if (/\.docx?$/i.test(p)) return { kind: 'doc', ext: 'DOC' };
  if (/\.xlsx?$/i.test(p)) return { kind: 'sheet', ext: 'XLS' };
  if (/\.pptx?$/i.test(p)) return { kind: 'slide', ext: 'PPT' };
  return { kind: 'file', ext: (p.match(/\.(\w+)$/)?.[1] || 'FILE').toUpperCase().slice(0, 4) };
}

// Which filing section a document belongs to (mirrors collectDocuments' id prefixes).
function docBucket(doc) {
  if (doc.isDirect) return 'yours';
  const id = String(doc.id || '');
  if (doc.docType === 'receipt' || id.startsWith('receipt-')) return 'receipts';
  if (id.startsWith('leg-') || id.startsWith('tleg-')) return 'travel';
  if (id.startsWith('paccom-') || id.startsWith('oaccom-')) return 'stays';
  return 'other';
}

// Serialize a nav target onto data-* attributes read back by openDocSource.
function navAttrs(nav) {
  if (!nav) return '';
  return [
    `data-nav-kind="${esc(nav.kind)}"`,
    nav.id ? `data-nav-id="${esc(nav.id)}"` : '',
    nav.dir ? `data-nav-dir="${esc(nav.dir)}"` : '',
    nav.member ? `data-nav-member="${esc(nav.member)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

// The label for a document's "jump to source" link.
function sourceLinkLabel(doc) {
  if (doc.isDirect) {
    const catLabel = getDocCategoryOptions().find((c) => c.value === doc.category)?.label || '';
    return [doc.description, catLabel].filter(Boolean).join(' · ') || 'Edit details';
  }
  const receiptCat =
    doc.docType === 'receipt' && doc.category
      ? getActiveBudgetCategoryOptions().find((c) => c.value === doc.category)?.label || ''
      : '';
  return (
    [doc.sourceLabel, [doc.date, receiptCat].filter(Boolean).join(' · ')]
      .filter(Boolean)
      .join(' · ') || 'Go to source'
  );
}

// One filed document. The whole row opens the document detail overlay — an inline
// preview (image/PDF) plus the adaptive action bar (Open · Download · Go to source
// · Edit · Remove). The thumbnail still shows inline; the source line is provenance.
function documentCardHtml(doc) {
  const { kind, ext } = fileKind(doc.filePath);
  const isImg = kind === 'img' && !!doc.filePath;
  const name = doc.name || 'Untitled file';
  const url = resolveFileUrl?.(doc.filePath) || doc.filePath || '';
  const srcLabel = sourceLinkLabel(doc);
  return `
    <button type="button" class="doc-row doc-open-detail" data-doc-id="${esc(doc.id)}" aria-label="Open ${esc(name)}">
      <span class="doc-chip doc-chip--${kind}">
        ${isImg ? `<img class="doc-thumb" src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
        <span class="doc-ext">${esc(ext)}</span>
      </span>
      <div class="doc-main">
        <span class="doc-name">${esc(name)}</span>
        <span class="doc-src-plain">${esc(srcLabel)}</span>
      </div>
      <span class="pl-open-go" aria-hidden="true">&rsaquo;</span>
    </button>`;
}

// A single "still to attach" gap row.
function gapRowHtml(gap) {
  return `
    <div class="doc-gap">
      <span class="doc-gap-label">${esc(gap.label)}</span>
      <button type="button" class="doc-gap-btn doc-goto" ${navAttrs(gap.nav)}>Attach</button>
    </div>`;
}

let _documentModalId = null;
let _documentModalFilePath = '';
let _documentModalFileLabel = '';

function openDocumentModal(id) {
  _documentModalId = id;
  const mode = state.planner.mode || 'personal';
  const arr =
    mode === 'sponsor'
      ? state.planner.org?.documents || []
      : state.planner.personal?.documents || [];
  const doc = id ? arr.find((d) => d.id === id) : null;
  document.getElementById('documentModalTitle').textContent = id ? 'Edit Document' : 'Add Document';
  document.getElementById('documentModalName').value = doc?.name || '';
  document.getElementById('documentModalDescription').value = doc?.description || '';
  document.getElementById('documentModalCategory').innerHTML = buildSelectOptions(
    getDocCategoryOptions(),
    doc?.category || '',
  );
  _documentModalFilePath = doc?.filePath || '';
  _documentModalFileLabel = doc?.fileLabel || '';
  syncModalFile(
    _documentModalFilePath,
    _documentModalFileLabel,
    'documentModalFileLabel',
    'documentModalRemoveFileBtn',
  );
  document.getElementById('documentModalDelete')?.classList.toggle('hidden', !id);
  showModal('documentModal', 'documentModalName');
}

function saveDocumentModal() {
  const isNew = !_documentModalId;
  const id = _documentModalId || makeItemId('doc');
  const data = {
    id,
    name: document.getElementById('documentModalName').value.trim(),
    description: document.getElementById('documentModalDescription').value.trim(),
    category: document.getElementById('documentModalCategory').value,
    filePath: _documentModalFilePath,
    fileLabel: _documentModalFileLabel,
    updatedAt: new Date().toISOString(),
  };
  const mode = state.planner.mode || 'personal';
  if (mode === 'sponsor') {
    const arr = (state.planner.org.documents ??= []);
    if (isNew) arr.push(data);
    else {
      const i = arr.findIndex((d) => d.id === id);
      if (i !== -1) arr[i] = data;
    }
  } else {
    if (!state.planner.personal) state.planner.personal = {};
    const arr = (state.planner.personal.documents ??= []);
    if (isNew) arr.push(data);
    else {
      const i = arr.findIndex((d) => d.id === id);
      if (i !== -1) arr[i] = data;
    }
  }
  closeDocumentModal();
  renderDocumentsTab();
  scheduleAutoSave();
}

function closeDocumentModal() {
  hideModal('documentModal');
  _documentModalId = null;
  _documentModalFilePath = '';
  _documentModalFileLabel = '';
}

// The third slot used to be a Font Awesome class. A section is named by its
// heading; the glyph said nothing the word did not.
const DOC_SECTIONS = [
  ['yours', 'Your documents'],
  ['travel', 'Travel'],
  ['stays', 'Stays'],
  ['receipts', 'Receipts'],
  ['other', 'Other'],
];

export function renderDocumentsTab() {
  const docs = collectDocuments();
  const gaps = collectGaps();
  const list = document.getElementById('documentsList');
  const empty = document.getElementById('documentsEmptyState');
  const summary = document.getElementById('documentsSummary');
  const gapsEl = document.getElementById('documentsGaps');
  if (!list) return;

  // Empty only when there's nothing filed AND nothing outstanding to attach.
  empty?.classList.toggle('hidden', docs.length > 0 || gaps.length > 0);
  if (summary) {
    summary.classList.toggle('hidden', docs.length === 0);
    const yours = docs.filter((d) => d.isDirect).length;
    summary.innerHTML = docs.length
      ? `<span class="doc-sum-n">${docs.length}</span> file${docs.length === 1 ? '' : 's'} · ${yours} yours · ${docs.length - yours} collected`
      : '';
  }

  if (gapsEl) {
    gapsEl.classList.toggle('hidden', gaps.length === 0);
    gapsEl.innerHTML = gaps.length
      ? `<div class="doc-gaps-head"><span>Still to attach</span><span class="doc-gaps-n">${gaps.length}</span></div>${gaps.map(gapRowHtml).join('')}`
      : '';
  }

  if (!docs.length) {
    list.innerHTML = '';
    return;
  }
  const grouped = {};
  for (const d of docs) (grouped[docBucket(d)] ??= []).push(d);
  list.innerHTML = DOC_SECTIONS.filter(([k]) => grouped[k]?.length)
    .map(
      ([k, label]) => `
      <div class="doc-group">
        <div class="doc-divider"><span>${esc(label)}</span><span class="doc-divider-n">${grouped[k].length}</span></div>
        ${grouped[k].map(documentCardHtml).join('')}
      </div>`,
    )
    .join('');
}

// Jump to the editor of the entity a file belongs to (or the gap to fill). Uses
// the openers injected via initDocuments; falls back to a tab switch.
function openDocSource(nav) {
  if (!nav) return;
  switch (nav.kind) {
    case 'doc':
      openDocumentModal(nav.id);
      break;
    case 'receipt':
      openReceiptModal?.(nav.id);
      break;
    case 'pleg':
      openPersonalLegModal?.(nav.dir, nav.id);
      break;
    case 'paccom':
      openPersonalAccomModal?.(nav.id);
      break;
    case 'oaccom':
      openAccommodationModal?.(nav.id);
      break;
    case 'tleg':
      openAssignmentModal?.(nav.member);
      break;
    default:
      break;
  }
}

// Delete a direct document (record + stored file), undo-safe.
function removeDirectDocument(id) {
  const mode = state.planner.mode || 'personal';
  const listOf = () =>
    mode === 'sponsor' ? state.planner.org.documents || [] : state.planner.personal.documents || [];
  const setList = (arr) => {
    if (mode === 'sponsor') state.planner.org.documents = arr;
    else state.planner.personal.documents = arr;
  };
  const snapshot = listOf().find((d) => d.id === id);
  if (!snapshot) return;
  setList(listOf().filter((d) => d.id !== id));
  renderDocumentsTab();
  scheduleAutoSave();
  const fileCleanup = snapshot.filePath
    ? setTimeout(() => deleteUploadedFile?.(snapshot.filePath), 6000)
    : null;
  showUndoToast(snapshot.name || 'Document', () => {
    if (fileCleanup) clearTimeout(fileCleanup);
    setList([...listOf(), snapshot]);
    renderDocumentsTab();
    scheduleAutoSave();
  });
}

// Remove the copy attached to a receipt (keeps the receipt record), undo-safe.
function removeReceiptCopy(receiptId) {
  const r = (state.planner.receipts || []).find((x) => x.id === receiptId);
  if (!r || !r.filePath) return;
  const prevPath = r.filePath;
  const prevLabel = r.fileLabel;
  r.filePath = '';
  r.fileLabel = '';
  renderDocumentsTab();
  scheduleAutoSave();
  const fileCleanup = setTimeout(() => deleteUploadedFile?.(prevPath), 6000);
  showUndoToast(fileDisplayName(prevPath, prevLabel) || 'File', () => {
    clearTimeout(fileCleanup);
    r.filePath = prevPath;
    r.fileLabel = prevLabel;
    renderDocumentsTab();
    scheduleAutoSave();
  });
}

// Read a nav target back off a clicked element's data-* attributes.
function navFromEl(el) {
  const kind = el.dataset.navKind;
  if (!kind) return null;
  return { kind, id: el.dataset.navId, dir: el.dataset.navDir, member: el.dataset.navMember };
}

// ── Inline preview lightbox (images + PDFs) ──────────────────────────────────
let _lbBlobUrl = null;
function _lbKey(e) {
  if (e.key === 'Escape') closeLightbox();
}
function closeLightbox() {
  document.querySelector('.doc-lightbox')?.remove();
  document.body.style.overflow = '';
  document.removeEventListener('keydown', _lbKey, true);
  if (_lbBlobUrl) {
    URL.revokeObjectURL(_lbBlobUrl);
    _lbBlobUrl = null;
  }
}
// The document detail surface: an inline preview (image inline / PDF framed via a
// blob: URL) plus an action bar that adapts to the document — every file gets
// Open + Download; attached files get "Go to source"; your own documents get Edit;
// direct docs and receipt copies get a two-step Remove. Non-previewable types show
// a placeholder with an Open button instead of silently punting to a new tab.
async function openDocumentDetail(doc) {
  const file = resolveFileUrl?.(doc.filePath) || doc.filePath || '';
  const name = doc.name || 'Untitled file';
  const { kind } = fileKind(doc.filePath);
  const isImg = kind === 'img' && !!file;
  const isPdf = /\.pdf(\?|$)/i.test(file) || /^data:application\/pdf/.test(file);
  // data: PDFs can't be framed reliably, so they fall back to the placeholder.
  const canInline = !!file && (isImg || (isPdf && !/^data:/i.test(file)));

  const isDirect = !!doc.isDirect;
  const removable = isDirect || doc.nav?.kind === 'receipt';
  const showSource = !isDirect && !!doc.nav; // direct docs edit in place; no "source"

  closeLightbox();
  const ov = document.createElement('div');
  ov.className = 'doc-lightbox';
  const barActions = [
    file
      ? `<a class="doc-lb-act" href="${esc(file)}" target="_blank" rel="noopener" aria-label="Open in a new tab">Open</a>`
      : '',
    file
      ? `<a class="doc-lb-act" href="${esc(file)}" download aria-label="Download">Download</a>`
      : '',
    showSource
      ? `<button type="button" class="doc-lb-act doc-lb-source" aria-label="Go to source">Source</button>`
      : '',
    isDirect
      ? `<button type="button" class="doc-lb-act doc-lb-edit" aria-label="Edit details">Edit</button>`
      : '',
    removable
      ? `<button type="button" class="doc-lb-act doc-lb-act--danger doc-lb-remove" aria-label="Remove">Remove</button>`
      : '',
    `<button type="button" class="doc-lb-act doc-lb-close" aria-label="Close">Close</button>`,
  ]
    .filter(Boolean)
    .join('');
  const stageHtml = isImg
    ? `<img src="${esc(file)}" alt="${esc(name)}">`
    : canInline
      ? `<div class="doc-lb-loading">Loading&hellip;</div>`
      : `<div class="doc-lb-none"><p>No inline preview for this file type.</p>${file ? `<a class="doc-lb-open-btn" href="${esc(file)}" target="_blank" rel="noopener">Open in a new tab</a>` : ''}</div>`;
  ov.innerHTML = `
    <div class="doc-lb-bar">
      <span class="doc-lb-name">${esc(name)}</span>
      ${barActions}
    </div>
    <div class="doc-lb-stage">${stageHtml}</div>`;
  document.body.appendChild(ov);
  document.body.style.overflow = 'hidden';
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('.doc-lb-close')) closeLightbox();
  });
  document.addEventListener('keydown', _lbKey, true);

  ov.querySelector('.doc-lb-source')?.addEventListener('click', () => {
    closeLightbox();
    openDocSource(doc.nav);
  });
  ov.querySelector('.doc-lb-edit')?.addEventListener('click', () => {
    closeLightbox();
    openDocumentModal(doc.id);
  });
  const removeBtn = ov.querySelector('.doc-lb-remove');
  if (removeBtn) {
    let armed = false;
    let armTimer = null;
    removeBtn.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        removeBtn.classList.add('is-armed');
        removeBtn.textContent = 'Confirm?';
        armTimer = setTimeout(() => {
          armed = false;
          removeBtn.classList.remove('is-armed');
          removeBtn.textContent = 'Remove';
        }, 3500);
        return;
      }
      clearTimeout(armTimer);
      closeLightbox();
      if (isDirect) removeDirectDocument(doc.id);
      else removeReceiptCopy(doc.nav.id);
    });
  }

  if (canInline && isPdf) {
    // Frame the PDF as a same-origin blob: URL so the file's X-Frame-Options header
    // can't block the inline preview (the header only governs framing a server
    // response — a client-side blob is exempt).
    try {
      const resp = await fetch(file);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      if (!document.body.contains(ov)) return; // closed while loading
      _lbBlobUrl = URL.createObjectURL(blob);
      const stage = ov.querySelector('.doc-lb-stage');
      if (stage)
        stage.innerHTML = `<iframe src="${_lbBlobUrl}" title="${esc(name || 'Document preview')}"></iframe>`;
    } catch {
      const stage = ov.querySelector('.doc-lb-stage');
      if (stage)
        stage.innerHTML = `<div class="doc-lb-error">Couldn't load the preview. <a href="${esc(file)}" target="_blank" rel="noopener">Open in a new tab</a> instead.</div>`;
    }
  }
}

export function wireDocumentsPanel() {
  // Upload button: pick file first, then open modal with file pre-filled
  document.getElementById('uploadDocBtn')?.addEventListener('click', () => {
    const fi = document.getElementById('docFileInput');
    if (fi) {
      fi.dataset.target = 'documentModal';
      fi.click();
    }
  });

  document.getElementById('docFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    const target = e.target.dataset.target;
    e.target.value = '';
    if (!file) return;

    if (target === 'documentModal') {
      // Upload → open new-document modal with file pre-populated
      try {
        const { path, label } = await uploadOrReadFile(file, 'documents');
        _documentModalFilePath = path;
        _documentModalFileLabel = label;
        _documentModalId = null;
        document.getElementById('documentModalTitle').textContent = 'Add Document';
        document.getElementById('documentModalName').value = label;
        document.getElementById('documentModalDescription').value = '';
        document.getElementById('documentModalCategory').innerHTML =
          buildSelectOptions(getDocCategoryOptions());
        syncModalFile(
          _documentModalFilePath,
          _documentModalFileLabel,
          'documentModalFileLabel',
          'documentModalRemoveFileBtn',
        );
        document.getElementById('documentModalDelete')?.classList.add('hidden');
        showModal('documentModal', 'documentModalName');
      } catch (err) {
        window.alert(err.message);
      }
    } else if (target === 'documentModalAttach') {
      // Attach file while modal already open
      try {
        const { path, label } = await uploadOrReadFile(file, 'documents');
        _documentModalFilePath = path;
        _documentModalFileLabel = label;
        syncModalFile(
          _documentModalFilePath,
          _documentModalFileLabel,
          'documentModalFileLabel',
          'documentModalRemoveFileBtn',
        );
      } catch (err) {
        window.alert(err.message);
      }
    }
  });

  document.getElementById('plannerDocumentsPanel')?.addEventListener('click', (e) => {
    // A filed document row opens the detail overlay (preview + adaptive actions).
    const card = e.target.closest('.doc-open-detail');
    if (card) {
      const doc = collectDocuments().find((d) => String(d.id) === card.dataset.docId);
      if (doc) openDocumentDetail(doc);
      return;
    }
    // A "still to attach" gap row jumps to the entity that needs the file.
    const goto = e.target.closest('.doc-goto');
    if (goto) {
      openDocSource(navFromEl(goto));
      return;
    }
  });

  // Document modal controls
  document.getElementById('documentModalClose')?.addEventListener('click', closeDocumentModal);
  document.getElementById('documentModalDone')?.addEventListener('click', saveDocumentModal);
  document.getElementById('documentModal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeDocumentModal();
  });

  document.getElementById('documentModalDelete')?.addEventListener('click', () => {
    if (!_documentModalId) return;
    const id = _documentModalId;
    closeDocumentModal();
    removeDirectDocument(id);
  });

  document.getElementById('documentModalAttachBtn')?.addEventListener('click', () => {
    const fi = document.getElementById('docFileInput');
    if (fi) {
      fi.dataset.target = 'documentModalAttach';
      fi.click();
    }
  });

  document.getElementById('documentModalRemoveFileBtn')?.addEventListener('click', () => {
    _documentModalFilePath = '';
    _documentModalFileLabel = '';
    syncModalFile(
      _documentModalFilePath,
      _documentModalFileLabel,
      'documentModalFileLabel',
      'documentModalRemoveFileBtn',
    );
  });
}

// Static shell for this tab panel — injected into #plannerDocumentsPanel at boot (#7 co-location).
export function documentsPanelHtml() {
  return `
          <section>
            <div class="pln-section__head">
              <div>
                <p class="pln-eyebrow">Everything filed</p>
                <h2 class="pln-section__title">Documents</h2>
              </div>
              <button id="uploadDocBtn" type="button" class="pl-add-btn">Upload document</button>
            </div>
            <div id="documentsGaps" class="doc-gaps hidden"></div>
            <div id="documentsSummary" class="doc-summary hidden"></div>
            <div id="documentsList"></div>
            <div id="documentsEmptyState" class="jrn-empty">
              <p class="jrn-empty-t">Nothing filed yet</p>
              <p class="jrn-empty-s">Every file for the trip gathers here — booking confirmations, boarding passes, receipts. Upload one to start the dossier.</p>
            </div>
          </section>
        `;
}
