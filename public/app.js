const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let state = { schemes: [], terms: [], version: 0, demo: false };
let changes = [];
let schemeId = '';
let selectedId = location.hash.slice(1);
let dirty = false;
let saving = false;
let draftRelations = [];
let expanded = new Set();
let allExpanded = true;
let createMode = null;
let parentId = null;
let confirmResolve;
let noticeTimer;

async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, {
    ...options, headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function notice(message, error = false) {
  clearTimeout(noticeTimer);
  $('#notice').textContent = message;
  $('#notice').classList.toggle('error', error);
  $('#notice').hidden = false;
  if (!error) noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 6000);
}
function allowLeave() { return !saving && (!dirty || window.confirm('Discard your unsaved changes?')); }
function markDirty() {
  dirty = true;
  const status = $('#save-state');
  if (status) { status.textContent = 'Unsaved changes'; status.classList.add('dirty-tag'); }
  if ($('#save-term')) $('#save-term').disabled = saving;
  if ($('#discard')) $('#discard').disabled = saving;
}
function resetDirty() { dirty = false; }
function current() { return state.terms.find(term => term.id === selectedId); }
function byId(id) { return state.terms.find(term => term.id === id); }
function scheme() { return state.schemes.find(item => item.id === schemeId); }
function termOptions(terms, selected = '') {
  return terms.map(term => `<option value="${escape(term.id)}" ${term.id === selected ? 'selected' : ''}>${escape(term.label)} · ${escape(term.scheme)}</option>`).join('');
}

async function refresh(preferredId) {
  const [nextState, nextChanges] = await Promise.all([api('state'), api('changes')]);
  state = nextState;
  changes = nextChanges.changes;
  if (preferredId) selectedId = preferredId;
  const selected = current();
  if (selected) schemeId = selected.scheme;
  if (!state.schemes.some(item => item.id === schemeId)) schemeId = state.schemes[0]?.id ?? '';
  if (!selected || selected.scheme !== schemeId) selectedId = state.terms.find(term => term.scheme === schemeId)?.id ?? '';
  $('#version').textContent = `#${state.version}`;
  $('#demo-badge').hidden = !state.demo;
  $('#scheme').innerHTML = state.schemes.map(item => `<option value="${escape(item.id)}">${escape(item.label)}</option>`).join('');
  $('#scheme').value = schemeId;
  $('#scheme').disabled = !state.schemes.length;
  $('#new-root').disabled = !schemeId;
  $('#export-scheme').hidden = !schemeId;
  $('#export-scheme').href = `/api/schemes/${encodeURIComponent(schemeId)}/skos`;
  resetDirty();
  renderTree(); renderDetail(); renderChanges();
}

function renderTree() {
  const terms = state.terms.filter(term => term.scheme === schemeId);
  const termMap = new Map(terms.map(term => [term.id, term]));
  const childMap = new Map();
  for (const term of terms) for (const parent of term.broader) {
    if (!childMap.has(parent)) childMap.set(parent, []);
    childMap.get(parent).push(term);
  }
  $('#scheme-kind').textContent = scheme()?.hierarchy === 'poly' ? 'POLYHIERARCHY' : schemeId ? 'TREE SCHEME' : 'NO SCHEMES';
  $('#scheme-notations').innerHTML = (scheme()?.notations ?? []).map(notation => `<span class="alias" title="${escape(notation.datatype)}">${escape(notation.value)}</span>`).join('');
  $('#term-count').textContent = `${terms.length} ${terms.length === 1 ? 'term' : 'terms'}`;
  const query = $('#search').value.trim().toLocaleLowerCase();
  const matches = terms.filter(term => [term.id, term.label, term.scopeNote, ...term.altLabels, ...term.aliases,
    ...(term.notations ?? []).map(notation => notation.value)]
    .some(value => value.toLocaleLowerCase().includes(query)));
  const visible = new Set(matches.map(term => term.id));
  if (query) {
    const addParents = id => { for (const parent of termMap.get(id)?.broader ?? []) { if (!visible.has(parent)) { visible.add(parent); addParents(parent); } } };
    matches.forEach(term => addParents(term.id));
  }
  const rows = [];
  const seen = new Set();
  let limited = false;
  const walk = (term, level) => {
    if (query && !visible.has(term.id)) return;
    if (rows.length >= 5000) { limited = true; return; }
    const shared = seen.has(term.id);
    seen.add(term.id);
    const children = childMap.get(term.id) ?? [];
    const open = !!query || allExpanded || expanded.has(term.id);
    rows.push(`<div class="tree-item ${term.id === selectedId ? 'selected' : ''} ${term.status === 'retired' ? 'retired' : ''}" style="padding-left:${7 + level * 16}px">
      <button type="button" class="tree-toggle" data-toggle="${escape(term.id)}" aria-label="${open ? 'Collapse' : 'Expand'} ${escape(term.label)}" ${children.length && !shared ? `aria-expanded="${open}"` : 'disabled'}>${shared ? '↗' : children.length ? open ? '▾' : '▸' : '·'}</button>
      <button type="button" class="tree-pick" data-pick="${escape(term.id)}" ${term.id === selectedId ? 'aria-current="true"' : ''}>${escape(term.label)}</button>
      ${shared ? '<span class="help" data-shared-reference title="Shared concept; its children appear at its first occurrence">shared</span>' : ''}
      <span class="status-dot ${escape(term.status)}" title="${escape(term.status)}"><span class="sr-only">${escape(term.status)}</span></span></div>`);
    if (open && !shared) children.forEach(child => walk(child, level + 1));
  };
  terms.filter(term => !term.broader.length).forEach(term => walk(term, 0));
  $('#tree').innerHTML = rows.join('') || `<p class="tree-empty">${query ? 'No terms match your search.' : schemeId ? 'A blank page for your vocabulary. Add your first top-level term below.' : 'Create a scheme to start organizing terms.'}</p>`;
  if (limited) $('#tree').insertAdjacentHTML('beforeend', '<p class="tree-empty">Showing the first 5,000 outline rows. Filter terms to narrow the view.</p>');
}
function crumbs(term) {
  const labels = [];
  let node = term;
  while (node.broader.length) { node = byId(node.broader[0]); if (!node) break; labels.unshift(node.label); }
  return [scheme()?.label ?? '', ...labels].map(escape).join('<span>/</span>');
}
function renderDetail() {
  const term = current();
  if (!term) {
    $('#detail').innerHTML = `<div class="empty"><span class="empty-symbol">t.</span><h1>${schemeId ? 'Make room for an idea' : 'Your vocabulary starts here'}</h1><p>${escape(scheme()?.description || 'Create a scheme to give your terms a home.')}</p><button class="button primary" id="empty-create">${schemeId ? '+ Add a top-level term' : '+ Create a scheme'}</button></div>`;
    $('#empty-create').onclick = () => openCreate(schemeId ? 'term' : 'scheme');
    return;
  }
  history.replaceState(null, '', `#${encodeURIComponent(term.id)}`);
  draftRelations = structuredClone(term.relations);
  $('#detail').innerHTML = `
    <div class="term-heading"><div class="breadcrumbs">${crumbs(term)}</div>
      <div class="title-line"><h1>${escape(term.label)}</h1><span class="status-pill ${escape(term.status)}">${escape(term.status)}</span></div>
      <div class="term-id">${escape(term.id)}<br>${term.path ? escape(term.path) : `${term.broader.length} broader terms · depth ${term.depth}`} · created #${term.created} · changed #${term.changed}</div>
      <div class="term-actions"><button type="button" class="button small" id="new-child">+ Narrower term</button><button type="button" class="button small" id="show-history">View history ↗</button><span class="usage-note">Subscriber usage unknown</span></div>
      ${term.status === 'retired' ? `<div class="retirement-banner">This term is retired. ${term.replacedBy.length ? 'Replaced by: ' + term.replacedBy.map(id => `<button type="button" class="text-button" data-pick="${escape(id)}">${escape(byId(id)?.label)}</button>`).join(', ') : 'No replacement specified.'} Old IDs and aliases still resolve here.</div>` : `<div class="term-actions breaking-actions">${['move', 'merge', 'split', 'retire'].map(kind => `<button type="button" class="button small" data-operation="${kind}">${kind[0].toUpperCase() + kind.slice(1)}…</button>`).join('')}</div>`}
    </div>
    <form id="term-form" class="term-body">
      <label class="field"><span class="field-label">Preferred label</span><input id="label" name="label" value="${escape(term.label)}" required maxlength="200"><span class="help">Renames keep the stable ID and all previous path aliases.</span></label>
      <label class="field"><span class="field-label">Scope note</span><textarea id="scope-note" name="scopeNote" rows="4" maxlength="20000" placeholder="What belongs here, and what goes elsewhere.">${escape(term.scopeNote)}</textarea><span class="help">Describe the concept’s boundaries. Scope note edits apply immediately.</span></label>
      <div class="field"><span class="field-label">Notations <button type="button" class="text-button" id="add-notation">+ Notation</button></span><div id="notations" class="relations-list"></div><p class="help">Codes in a classification system. Exact text and datatype are preserved, including leading zeros.</p></div>
      <div class="two-columns"><label class="field"><span class="field-label">Alternative labels</span><textarea id="alt-labels" name="altLabels" rows="3" placeholder="One alternative label per line">${escape(term.altLabels.join('\n'))}</textarea><span class="help">Other names that help you find this term.</span></label>
      <label class="field"><span class="field-label">Status</span><select id="term-status" name="status"><option value="provisional" ${term.status === 'provisional' ? 'selected' : ''}>Provisional</option><option value="active" ${term.status === 'active' ? 'selected' : ''}>Active</option></select><span class="help">Provisional terms leave space for ideas still taking shape.</span></label></div>
      ${term.broader.length ? `<div class="field"><span class="field-label">Broader terms</span><div class="alias-list">${term.broader.map(id => `<button type="button" class="button small" data-pick="${escape(id)}">${escape(byId(id)?.label)}</button>`).join('')}</div></div>` : ''}
      <div class="section-line field"><span class="field-label">Relations</span><div id="relations" class="relations-list"></div>
        <div class="relation-add"><select id="relation-type" aria-label="Relation type"><option value="related">Related</option><option value="opposite">Opposite</option></select><select id="relation-target" class="target" aria-label="Related term"></select><button type="button" class="button small" id="add-relation">+ Link</button></div>
        <p class="help">Related connects terms across schemes. Opposite stays within this scheme.</p>
      </div>
      <div class="section-line field"><span class="field-label">External references <button type="button" class="text-button" id="add-link">+ Reference</button></span><div id="links" class="relations-list"></div><p class="help">Link to an equivalent or closely matching concept in another vocabulary.</p></div>
      <div class="section-line field"><span class="field-label">Aliases</span><div class="alias-list">${term.aliases.map(alias => `<span class="alias">${escape(alias)}</span>`).join('') || '<span class="help">No aliases yet.</span>'}</div><p class="help">Historical names continue to resolve to this term.</p></div>
      <label class="field"><span class="field-label">Change note <span class="help">optional</span></span><input id="reason" name="reason" maxlength="2000" placeholder="Why are you making this change?"></label>
      <p id="save-error" class="form-error" role="alert"></p>
      <div class="save-bar"><span id="save-state" class="save-state">Saved at #${term.changed}</span><div class="save-buttons"><button type="button" class="button" id="discard" disabled>Discard</button><button type="submit" class="button primary" id="save-term" disabled>Save changes</button></div></div>
    </form>`;
  renderRelations();
  updateRelationTargets();
  term.links.forEach(link => addLink(link, false));
  (term.notations ?? []).forEach(notation => addNotation(notation, false));
  $('#add-notation').onclick = () => { if (document.querySelectorAll('.notation-row').length < 100) addNotation({ value: '', datatype: 'http://www.w3.org/2001/XMLSchema#string' }); };
  $('#term-form').addEventListener('input', markDirty);
  $('#term-form').addEventListener('change', markDirty);
  $('#term-form').addEventListener('submit', saveTerm);
  $('#new-child').onclick = () => openCreate('term', term.id);
  $('#show-history').onclick = () => { $('#history-selected').checked = true; renderChanges(); $('.history').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  $('#discard').onclick = () => { if (allowLeave()) { resetDirty(); renderDetail(); } };
  $('#relation-type').onchange = updateRelationTargets;
  $('#add-relation').onclick = () => {
    const target = $('#relation-target').value;
    const type = $('#relation-type').value;
    if (!target) return;
    if (draftRelations.some(item => item.target === target && item.type === type)) return;
    draftRelations.push({ type, target }); markDirty(); renderRelations();
  };
  $('#add-link').onclick = () => addLink({ uri: '', match: 'exactMatch' });
  if (term.status === 'retired') {
    $('#new-child').disabled = true;
    $('#term-form').querySelectorAll('input,textarea,select,button').forEach(control => { control.disabled = true; });
    $('#save-state').textContent = `Retired at #${term.changed} · read-only`;
  }
}
function updateRelationTargets() {
  const type = $('#relation-type').value;
  const terms = state.terms.filter(term => term.status !== 'retired' && term.id !== selectedId && (type === 'related' || term.scheme === schemeId));
  $('#relation-target').innerHTML = '<option value="">Choose a term…</option>' + termOptions(terms);
}
function renderRelations() {
  const outgoing = draftRelations.map((relation, i) => `<div class="relation-row"><span class="relation-type">${escape(relation.type)}</span><button type="button" class="relation-pick" data-pick="${escape(relation.target)}">${escape(byId(relation.target)?.label)}</button><button type="button" class="remove" data-remove-relation="${i}" aria-label="Remove relation to ${escape(byId(relation.target)?.label)}">×</button></div>`);
  const incoming = state.terms.filter(term => term.id !== selectedId).flatMap(term => term.relations
    .filter(relation => relation.target === selectedId && !draftRelations.some(r => r.target === term.id && r.type === relation.type))
    .map(relation => `<div class="relation-row"><span class="relation-type">${escape(relation.type)}</span><button type="button" class="relation-pick" data-pick="${escape(term.id)}">${escape(term.label)}</button><span class="help">incoming</span></div>`));
  $('#relations').innerHTML = [...outgoing, ...incoming].join('') || '<p class="help">No connections yet.</p>';
}
function addLink(link, changed = true) {
  const row = document.createElement('div');
  row.className = 'relation-add link-row';
  row.innerHTML = `<select aria-label="Reference match"><option value="exactMatch" ${link.match === 'exactMatch' ? 'selected' : ''}>Exact match</option><option value="closeMatch" ${link.match === 'closeMatch' ? 'selected' : ''}>Close match</option>${['broadMatch', 'narrowMatch', 'relatedMatch'].map(match => `<option value="${match}" ${link.match === match ? 'selected' : ''}>${match.replace('Match', ' match')}</option>`).join('')}</select><input class="target" type="text" aria-label="Reference URL" value="${escape(link.uri)}" placeholder="https://…" required><button type="button" class="button small" aria-label="Remove reference">×</button>`;
  row.querySelector('button').onclick = () => { row.remove(); markDirty(); };
  $('#links').append(row);
  if (changed) { markDirty(); row.querySelector('input').focus(); }
}
function addNotation(notation, changed = true) {
  const row = document.createElement('div'); row.className = 'notation-row';
  row.innerHTML = `<label><span class="help">Code</span><input class="notation-value" aria-label="Notation value" maxlength="2000" value="${escape(notation.value)}"></label><label><span class="help">Datatype IRI</span><input class="notation-datatype" aria-label="Notation datatype" maxlength="2000" value="${escape(notation.datatype)}" placeholder="http://www.w3.org/2001/XMLSchema#string"></label><label><span class="help">Language</span><input class="notation-language" aria-label="Notation language" value="${escape(notation.language ?? '')}" placeholder="optional"></label><button type="button" class="button small" aria-label="Remove notation">×</button>`;
  row.querySelector('.notation-language').oninput = event => {
    const datatype = row.querySelector('.notation-datatype');
    if (event.target.value.trim()) datatype.value = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
    else if (datatype.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString') datatype.value = 'http://www.w3.org/2001/XMLSchema#string';
  };
  row.querySelector('button').onclick = () => { row.remove(); markDirty(); };
  $('#notations').append(row);
  if (changed) { markDirty(); row.querySelector('input').focus(); }
}
async function confirmChange(title, message) {
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  $('#confirm-dialog').showModal();
  return new Promise(resolve => { confirmResolve = resolve; });
}
function finishConfirm(answer) { $('#confirm-dialog').close(); confirmResolve?.(answer); confirmResolve = undefined; }
async function saveTerm(event) {
  event.preventDefault();
  if (saving) return;
  const term = current();
  const data = {
    label: $('#label').value.trim(), scopeNote: $('#scope-note').value,
    altLabels: $('#alt-labels').value.split('\n').map(value => value.trim()).filter(Boolean),
    notations: [...document.querySelectorAll('.notation-row')].map(row => ({ value: row.querySelector('.notation-value').value,
      datatype: row.querySelector('.notation-datatype').value.trim() || 'http://www.w3.org/2001/XMLSchema#string',
      ...(row.querySelector('.notation-language').value.trim() ? { language: row.querySelector('.notation-language').value.trim() } : {}) })),
    status: $('#term-status').value, relations: draftRelations,
    links: [...document.querySelectorAll('.link-row')].map(row => ({ uri: row.querySelector('input').value.trim(), match: row.querySelector('select').value })),
    expectedChanged: term.changed, reason: $('#reason').value,
  };
  const rename = data.label !== term.label;
  const removedRelation = term.relations.some(old => !data.relations.some(r => r.type === old.type && r.target === old.target));
  saving = true;
  $('#term-form').inert = true;
  $('#save-term').disabled = true;
  $('#discard').disabled = true;
  try {
    if ((rename || removedRelation) && !await confirmChange(rename ? 'Rename this term?' : 'Remove these relations?',
      `${rename ? `“${term.label}” will become “${data.label}”. Old aliases will continue to resolve.` : ''}${removedRelation ? ' Existing relations will be removed.' : ''}`)) return;
    const result = await api(`terms/${encodeURIComponent(term.id)}`, { method: 'PATCH', body: JSON.stringify(data) });
    await refresh(result.term.id);
    notice(`Saved “${result.term.label}” at #${result.version}.`);
  } catch (error) {
    $('#save-error').textContent = error.message;
    if (error.message.includes('changed since')) notice(error.message + ' Copy any unsaved text, then reload the page.', true);
  } finally {
    saving = false;
    if ($('#term-form')) $('#term-form').inert = false;
    if ($('#save-term')) $('#save-term').disabled = !dirty;
    if ($('#discard')) $('#discard').disabled = !dirty;
  }
}
function renderChanges() {
  const entries = changes.filter(change => !$('#history-selected').checked || change.terms.includes(selectedId));
  $('#change-count').textContent = entries.length;
  $('#changes').innerHTML = entries.toReversed().map(change => {
    const date = new Date(change.at);
    const summary = change.kind === 'added' ? 'A new term in the vocabulary.' : change.kind === 'scheme-added' ? 'A new home for terms.' : change.kind === 'labelled' ? `Previously “${change.before?.label}”. Stable ID preserved.` : change.kind === 'noted' ? 'Scope note updated.' : change.kind.startsWith('set-') ? 'Concept set membership or definition changed.' : 'Term details updated.';
    return `<article class="change-card"><div class="change-top"><span>#${change.n}</span><time datetime="${escape(change.at)}" title="${escape(date.toLocaleString())}">${escape(date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))} · ${escape(date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}</time></div><span class="change-kind ${change.breaking ? 'breaking' : ''}">${escape(change.kind.replaceAll('-', ' '))}${change.breaking ? ' · breaking' : ''}</span><div class="change-label">${escape(change.after.label)}</div><div class="change-summary">${escape(change.reason || summary)}</div><button class="change-view" data-revision="${change.n}">Inspect change ↗</button></article>`;
  }).join('') || '<p class="tree-empty">No changes recorded yet.</p>';
}
function showRevision(n) {
  const change = changes.find(item => item.n === n);
  if (!change) return;
  $('#revision-content').innerHTML = `<div class="dialog-heading"><span class="eyebrow">Changelog #${n}</span><h2>${escape(change.after.label)}</h2></div><p class="history-description">${escape(change.kind)} · ${escape(new Date(change.at).toLocaleString())}${change.breaking ? ' · breaking' : ''}</p><p class="help">${escape(change.reason || 'Saved by the local editor.')}</p><details ${change.before ? '' : 'hidden'}><summary>Before</summary><pre class="revision-json">${escape(JSON.stringify(change.beforeTerms ?? change.before, null, 2))}</pre></details><details open><summary>After</summary><pre class="revision-json">${escape(JSON.stringify(change.afterTerms ?? change.after, null, 2))}</pre></details>${change.terms.length > 1 ? `<p class="help">Affected ${change.terms.length} terms. Historical term reads include those revisions.</p>` : ''}`;
  $('#revision-dialog').showModal();
}
function openCreate(mode, parent = null) {
  if (!allowLeave()) return;
  createMode = mode; parentId = parent;
  $('#create-title').textContent = mode === 'scheme' ? 'New scheme' : parent ? 'New narrower term' : 'New top-level term';
  $('#create-error').textContent = '';
  const schemeFields = `<label class="field"><span class="field-label">Scheme ID</span><input name="id" required pattern="[a-z]([a-z0-9]|-){0,59}" maxlength="60" placeholder="e.g. subjects"><span class="help">Lowercase letters, numbers, and hyphens. This ID stays fixed.</span></label><label class="field"><span class="field-label">Hierarchy</span><select name="hierarchy"><option value="tree">Tree · one broader term</option><option value="poly">Polyhierarchy · multiple broader terms</option></select></label><label class="field"><span class="field-label">Description</span><textarea name="description" rows="2" maxlength="10000"></textarea></label>`;
  const termFields = `<label class="field"><span class="field-label">Broader terms</span><select name="broader" ${scheme()?.hierarchy === 'poly' ? 'multiple size="5"' : ''}><option value="" ${!parent ? 'selected' : ''}>Top level</option>${termOptions(state.terms.filter(term => term.scheme === schemeId), parent)}</select>${scheme()?.hierarchy === 'poly' ? '<span class="help">Use Ctrl or Command to select more than one parent.</span>' : ''}</label><label class="field"><span class="field-label">Scope note</span><textarea name="scopeNote" rows="3" maxlength="20000" placeholder="What belongs here?"></textarea></label><label class="field"><span class="field-label">Status</span><select name="status"><option value="provisional">Provisional</option><option value="active">Active</option></select></label>`;
  $('#create-fields').innerHTML = `<label class="field"><span class="field-label">${mode === 'scheme' ? 'Scheme name' : 'Preferred label'}</span><input name="label" required maxlength="200" autocomplete="off"></label>${mode === 'scheme' ? schemeFields : termFields}`;
  $('#create-dialog').showModal();
}
$('#create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const data = Object.fromEntries(form);
  if (createMode === 'term') { data.scheme = schemeId; data.broader = form.getAll('broader').filter(Boolean); }
  $('#submit-create').disabled = true;
  try {
    const result = await api(createMode === 'scheme' ? 'schemes' : 'terms', { method: 'POST', body: JSON.stringify(data) });
    $('#create-dialog').close();
    if (result.scheme) { schemeId = result.scheme.id; selectedId = ''; }
    if (parentId) expanded.add(parentId);
    $('#search').value = '';
    await refresh(result.term?.id);
    notice(`Created “${result.term?.label ?? result.scheme.label}”.`);
  } catch (error) { $('#create-error').textContent = error.message; }
  finally { $('#submit-create').disabled = false; }
});
$('#cancel-create').onclick = () => $('#create-dialog').close();
$('#cancel-confirm').onclick = () => finishConfirm(false);
$('#apply-confirm').onclick = () => finishConfirm(true);
$('#confirm-dialog').addEventListener('cancel', event => { event.preventDefault(); finishConfirm(false); });
$('#close-revision').onclick = () => $('#revision-dialog').close();
$('#new-scheme').onclick = () => openCreate('scheme');
$('#new-root').onclick = () => openCreate('term');
$('#search').addEventListener('input', renderTree);
$('#history-selected').onchange = renderChanges;
$('#scheme').onchange = () => {
  if (!allowLeave()) { $('#scheme').value = schemeId; return; }
  schemeId = $('#scheme').value;
  $('#export-scheme').href = `/api/schemes/${encodeURIComponent(schemeId)}/skos`;
  selectedId = state.terms.find(term => term.scheme === schemeId)?.id ?? '';
  $('#search').value = ''; resetDirty(); renderTree(); renderDetail(); renderChanges();
};
document.addEventListener('click', event => {
  const operation = event.target.closest('[data-operation]');
  if (operation) openOperation(operation.dataset.operation);
  const pick = event.target.closest('[data-pick]');
  if (pick && allowLeave()) {
    selectedId = pick.dataset.pick; schemeId = current().scheme;
    $('#export-scheme').href = `/api/schemes/${encodeURIComponent(schemeId)}/skos`;
    $('#scheme').value = schemeId; resetDirty(); renderTree(); renderDetail(); renderChanges();
  }
  const toggle = event.target.closest('[data-toggle]');
  if (toggle) {
    if (allExpanded) { expanded = new Set(state.terms.map(term => term.id)); allExpanded = false; }
    const id = toggle.dataset.toggle;
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    renderTree();
    [...document.querySelectorAll('[data-toggle]')].find(item => item.dataset.toggle === id)?.focus();
  }
  const remove = event.target.closest('[data-remove-relation]');
  if (remove) { draftRelations.splice(Number(remove.dataset.removeRelation), 1); markDirty(); renderRelations(); }
  const revision = event.target.closest('[data-revision]');
  if (revision) showRevision(Number(revision.dataset.revision));
});
$('#tree').addEventListener('keydown', event => {
  const buttons = [...document.querySelectorAll('.tree-pick')];
  const index = buttons.indexOf(document.activeElement);
  if (index < 0) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
  }
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !document.querySelector('dialog[open]')) {
    event.preventDefault(); $('#search').focus();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 's' && $('#term-form') && !document.querySelector('dialog[open]')) {
    event.preventDefault(); if (dirty && !saving) $('#term-form').requestSubmit();
  }
});
window.addEventListener('beforeunload', event => { if (dirty) event.preventDefault(); });
refresh().catch(error => notice(`Could not load the workspace: ${error.message}`, true));

let operationKind;
let operationPreview;
let operationTerm;
let operationVersion;
let operationGeneration = 0;
let operationApplying = false;
const operationCurrent = generation => generation === operationGeneration && $('#operation-dialog').open;
function invalidateOperation() {
  operationGeneration++;
  operationPreview = null; $('#operation-preview').hidden = true; $('#apply-operation').hidden = true;
  $('#preview-operation').disabled = false;
}
function splitChoices() {
  const rows = [...document.querySelectorAll('.split-term')];
  for (const select of document.querySelectorAll('.split-child')) {
    const selected = [...select.selectedOptions].map(option => option.value);
    select.innerHTML = (scheme()?.hierarchy === 'tree' ? '<option value="">Choose a replacement…</option>' : '') +
      rows.map((row, index) => `<option value="${index}" ${selected.includes(String(index)) ? 'selected' : ''}>${escape(row.querySelector('input').value || `Replacement ${index + 1}`)}</option>`).join('');
  }
}
function addSplitTerm() {
  const row = document.createElement('div'); row.className = 'split-term';
  const index = document.querySelectorAll('.split-term').length + 1;
  row.innerHTML = `<label class="field"><span class="field-label">Replacement ${index} label</span><input required maxlength="200"></label><label class="field"><span class="field-label">Replacement ${index} scope note</span><textarea rows="2" maxlength="20000"></textarea></label>`;
  $('#split-terms').append(row); splitChoices();
}
function openOperation(kind) {
  if (operationApplying || !allowLeave()) return;
  $('#operation-form').inert = false;
  operationKind = kind; operationTerm = current(); operationVersion = state.version;
  const available = state.terms.filter(term => term.scheme === schemeId && term.id !== selectedId && term.status !== 'retired');
  $('#operation-title').textContent = `${kind[0].toUpperCase() + kind.slice(1)} “${operationTerm.label}”`;
  $('#operation-reason').value = ''; $('#operation-error').textContent = ''; invalidateOperation();
  let fields = '';
  if (kind === 'move') fields = `<label class="field"><span class="field-label">New broader terms</span><select id="operation-broader" ${scheme().hierarchy === 'poly' ? 'multiple size="6"' : ''}><option value="">Top level</option>${termOptions(available)}</select></label><p class="help">Old aliases are preserved. Descendant paths and aliases update with this move.</p>`;
  if (kind === 'merge') fields = `<label class="field"><span class="field-label">Merge into</span><select id="operation-target" required><option value="">Choose a term…</option>${termOptions(available)}</select></label><p class="help">The source retires. Its children and incoming relations move to the target. Labels, references, and outgoing relations are carried over.</p>`;
  if (kind === 'retire') fields = `<label class="field"><span class="field-label">Replacement <span class="help">optional</span></span><select id="operation-target"><option value="">No replacement</option>${termOptions(available)}</select></label><p class="help">Children move to this term’s current broader terms. Relations transfer to the replacement; without one, incoming relations are removed. The retired ID and aliases remain available.</p>`;
  if (kind === 'split') fields = `<div id="split-terms"></div><button type="button" id="add-split-term" class="button small">+ Replacement</button><div class="section-line"><span class="field-label">Assign narrower terms</span>${state.terms.filter(term => term.broader.includes(selectedId)).map(term => `<label class="field"><span class="field-label">${escape(term.label)}</span><select class="split-child" data-child="${escape(term.id)}" required ${scheme().hierarchy === 'poly' ? 'multiple size="3"' : ''}></select></label>`).join('') || '<p class="help">There are no direct narrower terms to assign.</p>'}</div><p class="help">The source retires. Its incoming and outgoing relations are copied to every replacement. Assign each narrower term explicitly.</p>`;
  $('#operation-fields').innerHTML = fields;
  if (kind === 'split') { addSplitTerm(); addSplitTerm(); $('#add-split-term').onclick = () => { if (document.querySelectorAll('.split-term').length < 20) { addSplitTerm(); invalidateOperation(); } }; }
  if (kind === 'move') for (const option of $('#operation-broader').options) option.selected = operationTerm.broader.includes(option.value);
  $('#operation-dialog').showModal();
}
$('#operation-form').addEventListener('input', () => { invalidateOperation(); if (operationKind === 'split') splitChoices(); });
$('#operation-form').addEventListener('change', invalidateOperation);
$('#operation-form').addEventListener('submit', async event => {
  event.preventDefault(); invalidateOperation(); $('#operation-error').textContent = '';
  const generation = operationGeneration;
  const termId = operationTerm.id;
  const input = { kind: operationKind, expectedVersion: operationVersion, reason: $('#operation-reason').value };
  if (operationKind === 'move') input.broader = [...$('#operation-broader').selectedOptions].map(option => option.value).filter(Boolean);
  if (operationKind === 'merge') input.target = $('#operation-target').value;
  if (operationKind === 'retire') input.replacements = $('#operation-target').value ? [$('#operation-target').value] : [];
  if (operationKind === 'split') {
    input.newTerms = [...document.querySelectorAll('.split-term')].map(row => ({ label: row.querySelector('input').value, scopeNote: row.querySelector('textarea').value }));
    input.children = [...document.querySelectorAll('.split-child')].map(select => ({ id: select.dataset.child,
      targets: [...select.selectedOptions].map(option => option.value).filter(value => value !== '').map(Number) }));
  }
  $('#preview-operation').disabled = true;
  try {
    input.expectedVersion = (await api('state')).version;
    if (!operationCurrent(generation)) return;
    const preview = await api(`terms/${termId}/operations/preview`, { method: 'POST', body: JSON.stringify(input) });
    if (!operationCurrent(generation)) return;
    operationPreview = { ...preview, termId, input, generation };
    const names = new Map([...state.terms, ...preview.affected.map(row => row.after)].map(term => [term.id, term.label]));
    const parents = term => term.broader.length ? term.broader.map(id => names.get(id) ?? id).join(', ') : 'Top level';
    $('#operation-preview').innerHTML = `<strong>${preview.affected.length} affected terms</strong><p class="help">Subscriber usage unknown. One atomic, breaking change will be recorded.</p><ul>${preview.affected.map(row => {
      const removed = (row.before?.relations ?? []).filter(old => !row.after.relations.some(r => r.type === old.type && r.target === old.target));
      const added = row.after.relations.filter(r => !(row.before?.relations ?? []).some(old => r.type === old.type && r.target === old.target));
      return `<li><strong>${escape(row.after.label)}</strong>${!row.before ? ' · new' : row.after.status === 'retired' ? ' · retired' : ''}<br><span class="help">${row.before ? escape(parents(row.before)) + ' → ' : ''}${escape(parents(row.after))}${row.after.path ? '<br>' + escape(row.after.path) : ''}</span>${[...removed.map(r => `Remove ${r.type}: ${names.get(r.target) ?? r.target}`), ...added.map(r => `Add ${r.type}: ${names.get(r.target) ?? r.target}`)].map(text => `<br><span class="help">${escape(text)}</span>`).join('')}${row.after.replacedBy.length ? `<br><span class="help">Replaced by ${escape(row.after.replacedBy.map(id => names.get(id) ?? id).join(', '))}</span>` : ''}</li>`;
    }).join('')}</ul>${preview.affectedSets?.length ? `<h3>Concept sets affected</h3><ul>${preview.affectedSets.map(set => `<li><strong>${escape(set.label)}</strong>: ${escape(set.note)}</li>`).join('')}</ul>` : ''}`;
    $('#operation-preview').hidden = false; $('#apply-operation').hidden = false;
  } catch (error) { if (operationCurrent(generation)) $('#operation-error').textContent = error.message; }
  finally { if (operationCurrent(generation)) $('#preview-operation').disabled = false; }
});
$('#apply-operation').onclick = async () => {
  if (!operationPreview || !operationCurrent(operationPreview.generation) || operationApplying) return;
  const { termId, input } = operationPreview;
  operationApplying = true;
  $('#operation-form').inert = true;
  try {
    const result = await api(`terms/${termId}/operations/apply`, { method: 'POST', body: JSON.stringify(input) });
    $('#operation-dialog').close(); await refresh(result.term.id);
    notice(`Applied ${input.kind} at #${result.version}.`);
  } catch (error) { $('#operation-error').textContent = error.message; invalidateOperation(); }
  finally { operationApplying = false; $('#operation-form').inert = false; }
};
$('#cancel-operation').onclick = () => $('#operation-dialog').close();
$('#operation-dialog').addEventListener('close', () => { if (!$('#operation-dialog').open) invalidateOperation(); });
$('#operation-dialog').addEventListener('cancel', event => {
  if (operationApplying) event.preventDefault(); else invalidateOperation();
});

let importSource;
let importPreview;
let importGeneration = 0;
let sourceGeneration = 0;
let importApplying = false;
const importCurrent = generation => generation === importGeneration && $('#import-dialog').open;
const sourceCurrent = generation => generation === sourceGeneration && $('#import-dialog').open;
function invalidateImport() {
  importGeneration++; importPreview = null;
  $('#import-preview').hidden = true; $('#apply-import').hidden = true; $('#preview-import').disabled = false;
}
function invalidateImportSource() {
  sourceGeneration++; importSource = null; $('#read-import-source').disabled = false;
  invalidateImport(); $('#import-source-scheme').innerHTML = ''; $('#import-source-scheme').disabled = true;
}
$('#import-scheme').onclick = () => {
  if (importApplying || !allowLeave()) return;
  $('#import-form').inert = false;
  $('#import-error').textContent = ''; invalidateImportSource(); $('#import-dialog').showModal();
};
$('#import-format').onchange = () => {
  $('#import-file-field').hidden = $('#import-format').value !== 'turtle';
  $('#import-sparql-fields').hidden = $('#import-format').value !== 'sparql';
  invalidateImportSource();
};
for (const selector of ['#import-file', '#import-endpoint', '#import-graph']) {
  $(selector).addEventListener('input', invalidateImportSource);
  $(selector).addEventListener('change', invalidateImportSource);
}
$('#import-form').addEventListener('input', invalidateImport);
$('#import-form').addEventListener('change', invalidateImport);
$('#read-import-source').onclick = async () => {
  $('#import-error').textContent = ''; invalidateImportSource(); $('#read-import-source').disabled = true;
  const generation = sourceGeneration;
  try {
    const format = $('#import-format').value;
    const input = { format };
    if (format === 'turtle') {
      const file = $('#import-file').files[0];
      if (!file) throw new Error('Choose a Turtle file first.');
      if (file.size > 5 * 1024 * 1024) throw new Error('Files are limited to 5 MiB.');
      input.data = await file.text();
    } else {
      input.endpoint = $('#import-endpoint').value;
      if ($('#import-graph').value.trim()) input.graph = $('#import-graph').value.trim();
    }
    if (!sourceCurrent(generation)) return;
    const result = await api('imports/schemes', { method: 'POST', body: JSON.stringify(input) });
    if (!sourceCurrent(generation)) return;
    const choices = new Map();
    for (const item of result.schemes) choices.set(item.uri, item.label ?? item.labels?.map(label => label.value).join(' / ') ?? item.uri);
    if (!choices.size) throw new Error('No declared SKOS schemes were found in this source.');
    importSource = input;
    $('#import-source-scheme').innerHTML = [...choices].map(([uri, label]) => `<option value="${escape(uri)}">${escape(label)} · ${escape(uri)}</option>`).join('');
    $('#import-source-scheme').disabled = false;
  } catch (error) { if (sourceCurrent(generation)) $('#import-error').textContent = error.message; }
  finally { if (sourceCurrent(generation)) $('#read-import-source').disabled = false; }
};
$('#import-form').addEventListener('submit', async event => {
  event.preventDefault(); invalidateImport(); $('#import-error').textContent = '';
  const generation = importGeneration;
  if (!importSource || $('#import-source-scheme').disabled) { $('#import-error').textContent = 'Find and select a source scheme first.'; return; }
  const input = { ...importSource, sourceScheme: $('#import-source-scheme').value,
    schemeId: $('#import-id').value, hierarchy: $('#import-hierarchy').value, language: $('#import-language').value };
  if ($('#import-label').value.trim()) input.label = $('#import-label').value.trim();
  $('#preview-import').disabled = true;
  try {
    const preview = await api('imports/preview', { method: 'POST', body: JSON.stringify(input) });
    if (!importCurrent(generation)) return;
    importPreview = { ...preview, generation };
    $('#import-preview').innerHTML = `<strong>${escape(importPreview.plan.scheme.label)} · ${importPreview.count} terms · ${importPreview.sets?.length ?? 0} collections</strong><p class="help">A new scheme will be added. Source IRIs and SKOS mappings are preserved.</p>${importPreview.warnings.length ? `<div class="import-warnings"><strong>Review omitted data</strong><ul>${importPreview.warnings.map(warning => `<li>${escape(warning)}</li>`).join('')}</ul></div>` : '<p class="help">No import warnings.</p>'}<details><summary>Terms to import</summary><ul>${importPreview.terms.map(term => `<li>${escape(term.label)} · ${term.broader} broader</li>`).join('')}</ul></details>`;
    if (importPreview.sets?.length) $('#import-preview').insertAdjacentHTML('beforeend', `<details><summary>Collections to import</summary><ul>${importPreview.sets.map(set => `<li>${escape(set.label)} · ${set.recipe ? 'recipe' : set.ordered ? 'ordered' : 'unordered'} · ${set.members.length} explicit members</li>`).join('')}</ul></details>`);
    $('#import-preview').hidden = false; $('#apply-import').hidden = false;
  } catch (error) { if (importCurrent(generation)) $('#import-error').textContent = error.message; }
  finally { if (importCurrent(generation)) $('#preview-import').disabled = false; }
});
$('#apply-import').onclick = async () => {
  if (!importPreview || !importCurrent(importPreview.generation) || importApplying) return;
  const { plan, expectedVersion } = importPreview;
  importApplying = true;
  $('#import-form').inert = true;
  try {
    const result = await api('imports/apply', { method: 'POST', body: JSON.stringify({ plan, expectedVersion }) });
    $('#import-dialog').close(); $('#search').value = ''; await refresh(result.term.id);
    notice(`Imported “${result.scheme.label}” with ${result.count} terms.`);
  } catch (error) { $('#import-error').textContent = error.message; invalidateImport(); }
  finally { importApplying = false; $('#import-form').inert = false; }
};
$('#cancel-import').onclick = () => $('#import-dialog').close();
$('#import-dialog').addEventListener('close', () => { if (!$('#import-dialog').open) invalidateImportSource(); });
$('#import-dialog').addEventListener('cancel', event => {
  if (importApplying) event.preventDefault(); else invalidateImportSource();
});
