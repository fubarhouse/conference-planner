// Team tab (global team members) — the member roster and add/edit modal. The
// read-only "view" now gathers a member's associated data (travel, stays,
// tickets, budget, itinerary) into the shared person-detail modal
// (plannerPersonDetail.js), which Companions uses too. Extracted from planner.js:
// planner-internal collaborators are injected via initTeam().

import { escapeHtml as esc } from './utils.js';
import { showModal } from './modal.js';
import { makeItemId, saveGlobal } from './plannerStorage.js';
import { openPersonDetail } from './plannerPersonDetail.js';

// ── Injected planner collaborators ────────────────────────────────────────────
let state;
let renderListPanel;
let createModal;
let buildEventBudgetData;
let refreshAssignMemberSelect;
let renderSettingsTeamSection;

export function initTeam(deps) {
  ({
    state,
    renderListPanel,
    createModal,
    buildEventBudgetData,
    refreshAssignMemberSelect,
    renderSettingsTeamSection,
  } = deps);
}

function teamMemberCardHtml(member) {
  const disabled = member.enabled === false;
  const meta = [member.role, member.department, member.company, member.phone]
    .filter(Boolean)
    .join(' · ');
  // The same register row Companions uses. A team member and a companion are
  // the same kind of thing to a reader — a person on this trip — so they get
  // the same row rather than a second design that means the same.
  return `
    <div class="cmp-row${disabled ? ' cmp-row--off' : ''}" data-member-id="${esc(member.id)}">
      <span class="cmp-mono">${esc(monogram(member.name))}</span>
      <div class="cmp-main">
        <p class="cmp-name">${esc(member.name || 'Unnamed')}</p>
        ${meta ? `<p class="cmp-meta">${esc(meta)}</p>` : ''}
      </div>
      ${disabled ? '<span class="cmp-tag">Inactive</span>' : ''}
      <span class="cmp-acts">
        <button type="button" class="cmp-act view-team-member-btn" data-member-id="${esc(member.id)}" aria-label="View ${esc(member.name || 'team member')}">Details</button>
      </span>
    </div>`;
}

// A one/two-letter monogram from a name. Mirrors plannerCompanions.js — kept
// local rather than shared because it is four lines and the two modules have no
// other reason to depend on each other.
function monogram(name) {
  const src = (name || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  return ((parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : src.slice(0, 2)) || '?')
    .toUpperCase()
    .slice(0, 2);
}

export function renderTeamTab() {
  const assignedIds = new Set((state.planner?.org?.teamAssignments || []).map((a) => a.memberId));
  const members = (state.global?.teamMembers || []).filter((m) => assignedIds.has(m.id));
  renderListPanel('teamMembersList', 'teamMembersEmpty', members, teamMemberCardHtml);
}

export function openTeamMemberModal(id) {
  const modal = document.getElementById('teamMemberModal');
  if (!modal) return;
  const member = id ? (state.global?.teamMembers || []).find((m) => m.id === id) : null;
  modal.dataset.memberId = id || '';
  document.getElementById('tmName').value = member?.name || '';
  document.getElementById('tmRole').value = member?.role || '';
  document.getElementById('tmCompany').value = member?.company || '';
  document.getElementById('tmDepartment').value = member?.department || '';
  document.getElementById('tmPhone').value = member?.phone || '';
  document.getElementById('tmNotes').value = member?.notes || '';
  document.getElementById('tmEnabled').checked = member ? member.enabled !== false : true;
  document.getElementById('tmSkipFinances').checked = member?.skipFinances === true;
  document.getElementById('teamMemberModalDelete').classList.toggle('hidden', !id);
  showModal('teamMemberModal', 'tmName');
}

export function openTeamMemberDetailModal(memberId) {
  const member = (state.global?.teamMembers || []).find((m) => m.id === memberId);
  if (!member) return;
  openPersonDetail(buildTeamMemberDetail(member));
}

// Gather everything associated with a team member into the shared person shape.
function buildTeamMemberDetail(member) {
  const memberId = member.id;
  const org = state.planner.org || {};

  const badges = [];
  if (member.enabled === false) badges.push({ text: 'Inactive', tone: 'muted' });
  if (member.skipFinances) badges.push({ text: 'No finance tracking', tone: 'amber' });
  const subtitle = [member.role, [member.department, member.company].filter(Boolean).join(' · ')]
    .filter(Boolean)
    .join(' — ');

  const legs = (org.teamAssignments || [])
    .filter((a) => a.memberId === memberId)
    .flatMap((a) => [
      ...(a.outboundLegs || []).map((l) => ({ ...l, dir: 'outbound' })),
      ...(a.returnLegs || []).map((l) => ({ ...l, dir: 'return' })),
    ]);

  const stays = (org.accommodations || [])
    .map((acc) => {
      const st = (acc.assignments || []).find((s) => s.memberId === memberId);
      if (!st) return null;
      return {
        name: acc.name,
        checkIn: st.checkIn || acc.checkIn,
        checkOut: st.checkOut || acc.checkOut,
      };
    })
    .filter(Boolean);

  const tickets = [...(org.tickets || []), ...(state.planner.personal?.tickets || [])]
    .filter((t) => t.assignedTo === memberId || t.purchasedBy === memberId)
    .map((t) => ({
      name: t.name,
      status: t.status,
      relation: t.assignedTo === memberId ? 'assigned' : 'purchased by',
    }));

  const itinerary = (org.memberItinerary || []).filter(
    (i) => Array.isArray(i.memberIds) && i.memberIds.includes(memberId),
  );

  let budget;
  if (member.skipFinances) {
    budget = { mode: 'skipped' };
  } else {
    const cats = buildEventBudgetData(state.planner, memberId);
    const active = Object.entries(cats).filter(
      ([, c]) => c.budget !== 0 || c.actual !== 0 || c.items.length,
    );
    if (active.length) {
      budget = {
        mode: 'categories',
        items: active.flatMap(([, c]) =>
          (c.items || []).map((it) => ({
            label: it.label,
            cat: c.label,
            budget: it.budget,
            actual: it.actual,
          })),
        ),
        totalB: active.reduce((s, [, c]) => s + c.budget, 0),
        totalA: active.reduce((s, [, c]) => s + c.actual, 0),
        currency: org.sponsorCurrency || 'AUD',
      };
    } else {
      budget = { mode: 'none' };
    }
  }

  return {
    name: member.name,
    subtitle,
    badges,
    phone: member.phone,
    notes: member.notes,
    legs,
    stays,
    tickets,
    itinerary,
    budget,
  };
}

export function wireTeamPanel() {
  const panel = document.getElementById('plannerTeamPanel');
  if (!panel) return;

  panel.addEventListener('click', (e) => {
    const viewBtn = e.target.closest('.view-team-member-btn');
    if (viewBtn) {
      openTeamMemberDetailModal(viewBtn.dataset.memberId);
      return;
    }
    const editBtn = e.target.closest('.edit-team-member-btn');
    if (editBtn) {
      openTeamMemberModal(editBtn.dataset.memberId);
      return;
    }
  });

  document
    .getElementById('addTeamMemberBtn')
    ?.addEventListener('click', () => openTeamMemberModal(null));

  // The read-only person-detail modal wires its own close handlers
  // (wirePersonDetailModal, called from planner.js).

  const modal = document.getElementById('teamMemberModal');
  if (!modal) return;

  function readModalFields() {
    return {
      name: document.getElementById('tmName').value.trim(),
      role: document.getElementById('tmRole').value.trim(),
      company: document.getElementById('tmCompany').value.trim(),
      department: document.getElementById('tmDepartment').value.trim(),
      phone: document.getElementById('tmPhone').value.trim(),
      notes: document.getElementById('tmNotes').value.trim(),
      enabled: document.getElementById('tmEnabled').checked,
      skipFinances: document.getElementById('tmSkipFinances').checked,
    };
  }

  createModal('teamMemberModal', {
    onSave: () => {
      const id = modal.dataset.memberId;
      if (!id) return;
      const member = (state.global?.teamMembers || []).find((m) => m.id === id);
      if (!member) return;
      Object.assign(member, readModalFields());
      saveGlobal(state.global);
    },
    onDone: () => {
      const id = modal.dataset.memberId;
      const fields = readModalFields();
      if (!id) {
        state.global.teamMembers = [
          ...(state.global?.teamMembers || []),
          { id: makeItemId('tm'), ...fields },
        ];
      } else {
        const member = (state.global?.teamMembers || []).find((m) => m.id === id);
        if (member) Object.assign(member, fields);
      }
      saveGlobal(state.global);
    },
    onDelete: () => {
      const id = modal.dataset.memberId;
      if (!id) return;
      state.global.teamMembers = (state.global?.teamMembers || []).filter((m) => m.id !== id);
      saveGlobal(state.global);
    },
    onClose: () => {
      renderTeamTab();
      refreshAssignMemberSelect();
      renderSettingsTeamSection();
    },
  }).wire();
}

// Static shell for this tab panel — injected into #plannerTeamPanel at boot (#7 co-location).
export function teamPanelHtml() {
  return `
          <section>
            <div class="pln-section__head">
              <div>
                <p class="pln-eyebrow">Who's on the stand</p>
                <h2 class="pln-section__title">Team</h2>
              </div>
              <button id="addTeamMemberBtn" type="button" class="pl-add-btn">Add member</button>
            </div>
            <p class="wx-lede">Team members are shared across every event. Assign them to this one from the Planner tab.</p>
            <div id="teamMembersList" class="cmp-list"></div>
            <div id="teamMembersEmpty" class="jrn-empty">
              <p class="jrn-empty-t">No team members yet</p>
              <p class="jrn-empty-s">Build the roster once and reuse it — members are shared across all events, and you assign them per event.</p>
            </div>
          </section>
        `;
}
