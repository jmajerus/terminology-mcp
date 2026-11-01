import { viewer, lockForm } from './viewer.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let state, schemeId = new URLSearchParams(location.search).get('scheme') ?? '', selectedId = '', members = [], dirty = false, busy = false, generation = 0, preview = null, baseline = [];
const form = $('#set-form');
const field = name => form.elements.namedItem(name);
async function api(path, options = {}) {
  const response = await fetch('/api/' + path, { ...options, headers: { 'Content-Type': 'application/json' } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function leave() { return !busy && (!dirty || confirm('Discard your unsaved set changes?')); }
function invalidate() {
  generation++; dirty = true; preview = null;
  $('#save-set').disabled = true; $('#save-state').textContent = 'Unsaved changes · preview before saving';
  $('#expansion-version').textContent = 'Definition changed. Preview to update the expansion.';
}
function entity(id) { return [...state.terms, ...state.sets].find(item => item.id === id); }
function renderList() {
  $('#sets-list').innerHTML = ['theme', 'profile', 'map-view'].map(kind => {
    const sets = state.sets.filter(s => s.scheme === schemeId && s.kind === kind && s.label.toLowerCase().includes($('#set-search').value.toLowerCase()));
    return `<h3 class="eyebrow">${escape(kind)}</h3>${sets.map(s => `<div class="tree-item ${s.id === selectedId ? 'selected' : ''}"><button class="tree-pick" data-set="${escape(s.id)}">${escape(s.label)}</button><span class="help">${s.recipe ? 'recipe' : s.members.length}${s.ordered ? ' ↕' : ''}</span></div>`).join('')}`;
  }).join('');
  $('#export-sets').href = `/api/schemes/${encodeURIComponent(schemeId)}/skos`;
  $('#export-sets').hidden = !schemeId;
}
function renderPicker() {
  const query = $('#member-search').value.toLowerCase();
  $('#member-picker').innerHTML = [...state.terms, ...state.sets].filter(item => item.scheme === schemeId && item.id !== selectedId && !members.includes(item.id)
    && item.label.toLowerCase().includes(query)).map(item => `<option value="${escape(item.id)}">${escape(item.label)}${item.id.startsWith('s_') ? ' · collection' : item.status === 'retired' ? ' · retired' : ''}</option>`).join('');
}
function renderMembers() {
  $('#members-list').innerHTML = members.map((id, i) => `<li><span>${escape(entity(id)?.label ?? id)}${entity(id)?.status === 'retired' ? ' · retired' : ''}</span><button type="button" class="text-button" data-up="${i}" aria-label="Move ${escape(entity(id)?.label)} up" ${!i ? 'disabled' : ''}>↑</button><button type="button" class="text-button" data-down="${i}" aria-label="Move ${escape(entity(id)?.label)} down" ${i === members.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="text-button" data-remove="${i}" aria-label="Remove ${escape(entity(id)?.label)}">Remove</button></li>`).join('') || '<p class="help">No members yet.</p>';
  renderPicker();
}
function showExpansion(result, isPreview = false) {
  const ids = new Set(result.terms.map(t => t.id));
  const added = result.terms.filter(t => !baseline.includes(t.id)).length, removed = baseline.filter(id => !ids.has(id)).length;
  $('#expansion-version').textContent = `${result.terms.length} terms · ${isPreview ? `preview (+${added} −${removed})` : 'version #' + result.version}`;
  $('#set-expansion').innerHTML = [...result.warnings.map(w => `<p class="form-error">${escape(w)}</p>`), ...result.terms.map(t => `<article class="change-card"><a href="/#${encodeURIComponent(t.id)}">${escape(t.label)}</a><p class="help">${escape(t.path ?? t.scheme)} · ${escape(t.status)}</p></article>`)].join('') || '<p class="tree-empty">This collection is empty.</p>';
}
async function selectSet(id) {
  const token = ++generation;
  selectedId = id; preview = null; dirty = false; members = []; baseline = [];
  $('#save-set').disabled = true; $('#set-error').textContent = ''; $('#save-state').textContent = id ? 'Saved' : 'New set · preview before saving';
  const set = state.sets.find(s => s.id === id);
  // Visitors can read saved sets but not start a new one.
  form.hidden = !schemeId || (!id && !viewer.canEdit); $('#set-empty').hidden = !form.hidden;
  form.reset();
  for (const name of ['label', 'slug', 'description', 'owner', 'kind']) field(name).value = set?.[name] ?? ({ owner: 'local-editor', kind: 'theme' }[name] ?? '');
  field('ordered').checked = set?.ordered ?? false;
  field('mode').value = set?.recipe ? 'recipe' : 'explicit';
  for (const name of ['concepts', 'narrower', 'exclude']) field(name).innerHTML = recipeOptions(set?.recipe?.[name] ?? []);
  $('#around-rules').innerHTML = '';
  for (const rule of set?.recipe?.around ?? []) addAround(rule);
  definitionMode();
  members = [...set?.members ?? []];
  $('#delete-set').hidden = !id;
  $('#set-title').textContent = set?.label ?? 'New set'; $('#set-identity').textContent = set ? `${set.id} · ${set.owner}` : 'A stable ID is assigned when saved.';
  $('#member-search').value = ''; renderList(); renderMembers(); lockForm(form);
  $('#set-expansion').innerHTML = ''; $('#expansion-version').textContent = 'Preview to see the expansion.';
  history.replaceState(null, '', `?scheme=${encodeURIComponent(schemeId)}${id ? '#' + id : ''}`);
  if (id) {
    try { const result = await api(`sets/${id}/expand`); if (token !== generation) return; baseline = result.terms.map(t => t.id); showExpansion(result); }
    catch (error) { if (token === generation) $('#set-error').textContent = error.message; }
  }
}
async function load(id = selectedId) {
  state = await api('state');
  if (!state.schemes.some(s => s.id === schemeId)) schemeId = state.schemes[0]?.id ?? '';
  const selected = state.sets.find(s => s.id === id); if (selected) schemeId = selected.scheme;
  $('#version').textContent = '#' + state.version;
  $('#set-scheme').innerHTML = state.schemes.map(s => `<option value="${escape(s.id)}">${escape(s.label)}</option>`).join('');
  $('#set-scheme').value = schemeId; $('#new-set').disabled = !schemeId;
  await selectSet(selected?.id ?? state.sets.find(s => s.scheme === schemeId)?.id ?? '');
}
function draft() {
  const previous = state.sets.find(s => s.id === selectedId);
  return { scheme: schemeId, label: field('label').value, slug: field('slug').value, description: field('description').value,
    owner: field('owner').value, kind: field('kind').value, ordered: field('ordered').checked, members,
    ...(field('mode').value === 'recipe' ? { members: [], ordered: false, recipe: { concepts: selected('concepts'), narrower: selected('narrower'), exclude: selected('exclude'), around: [...$('#around-rules').children].map(row => ({ term: row.querySelector('[data-anchor]').value, depth: Number(row.querySelector('[data-depth]').value), types: [...row.querySelector('[data-types]').selectedOptions].map(o => o.value) })) } } : {}),
    ...(previous?.sourceUri ? { sourceUri: previous.sourceUri } : {}), ...(previous?.language ? { language: previous.language } : {}) };
}
form.oninput = event => { if (!['member-search', 'member-picker'].includes(event.target.id)) invalidate(); };
form.onchange = event => { if (!['member-picker'].includes(event.target.id)) invalidate(); };
form.onsubmit = async event => {
  event.preventDefault(); if (busy) return;
  const token = ++generation, input = { set: draft(), expectedVersion: state.version };
  busy = true; $('#preview-set').disabled = true; $('#set-error').textContent = ''; $('#save-set').disabled = true;
  try {
    const result = await api(selectedId ? `sets/${selectedId}/preview` : 'sets/preview', { method: 'POST', body: JSON.stringify(input) });
    if (token !== generation) return;
    preview = input; showExpansion(result, true); $('#save-set').disabled = false;
  } catch (error) { if (token === generation) $('#set-error').textContent = error.message; }
  finally { busy = false; $('#preview-set').disabled = false; }
};
$('#save-set').onclick = async () => {
  if (busy || !preview) return;
  busy = true; form.inert = true; $('#save-set').disabled = true;
  try {
    const result = await api(selectedId ? `sets/${selectedId}` : 'sets', { method: selectedId ? 'PATCH' : 'POST', body: JSON.stringify(preview) });
    dirty = false; await load(result.set.id); $('#save-state').textContent = 'Saved';
  } catch (error) { preview = null; $('#set-error').textContent = error.message; }
  finally { busy = false; form.inert = false; }
};
$('#delete-set').onclick = async () => {
  if (busy || !selectedId || !confirm('Delete this concept set? Its history will be retained.')) return;
  busy = true;
  try { await api(`sets/${selectedId}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: state.version }) }); dirty = false; await load(''); }
  catch (error) { $('#set-error').textContent = error.message; } finally { busy = false; form.inert = false; }
};
$('#members-list').onclick = event => {
  if (busy) return;
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.remove !== undefined) members.splice(Number(button.dataset.remove), 1);
  else { const index = Number(button.dataset.up ?? button.dataset.down), target = index + (button.dataset.up !== undefined ? -1 : 1); [members[index], members[target]] = [members[target], members[index]]; }
  invalidate(); renderMembers();
};
$('#add-member').onclick = () => { const id = $('#member-picker').value; if (busy || !id || members.includes(id)) return; members.push(id); invalidate(); renderMembers(); };
function selected(name) { return [...field(name).selectedOptions].map(option => option.value); }
function recipeOptions(ids = []) {
  return state.terms.filter(t => t.scheme === schemeId).map(t => `<option value="${escape(t.id)}" ${ids.includes(t.id) ? 'selected' : ''}>${escape(t.label)}${t.status === 'retired' ? ' · retired' : ''}</option>`).join('');
}
function addAround(rule = {}) {
  const row = document.createElement('div'); row.className = 'around-rule';
  row.innerHTML = `<label class="field"><span class="field-label">Around concept</span><select data-anchor>${recipeOptions([rule.term])}</select></label><div class="two-columns"><label class="field"><span class="field-label">Depth</span><input data-depth type="number" min="0" max="10" value="${escape(rule.depth ?? 1)}" required></label><label class="field"><span class="field-label">Relation types</span><select data-types multiple size="4"><option value="broader" ${(rule.types ?? []).includes('broader') ? 'selected' : ''}>Broader</option><option value="narrower" ${(rule.types ?? []).includes('narrower') ? 'selected' : ''}>Narrower</option><option value="related" ${(rule.types ?? ['related']).includes('related') ? 'selected' : ''}>Related</option><option value="opposite" ${(rule.types ?? []).includes('opposite') ? 'selected' : ''}>Opposite</option></select></label></div><button type="button" class="text-button" data-remove-rule>Remove neighbourhood</button>`;
  row.querySelector('[data-remove-rule]').onclick = () => { row.remove(); invalidate(); };
  $('#around-rules').append(row);
}
function definitionMode() {
  const recipe = field('mode').value === 'recipe';
  $('#recipe-definition').hidden = !recipe; $('#explicit-definition').hidden = recipe;
  for (const input of $('#recipe-definition').querySelectorAll('input, select')) input.disabled = !recipe;
  for (const input of $('#explicit-definition').querySelectorAll('input, select')) input.disabled = recipe;
}
field('mode').addEventListener('change', definitionMode);
$('#add-around').onclick = () => { if (busy) return; addAround(); invalidate(); };
$('#member-search').oninput = renderPicker;
$('#sets-list').onclick = event => { const id = event.target.closest('[data-set]')?.dataset.set; if (id && leave()) selectSet(id); };
$('#new-set').onclick = () => { if (leave()) selectSet(''); };
$('#discard-set').onclick = () => { if (leave()) load(selectedId); };
$('#set-scheme').onchange = () => { if (!leave()) { $('#set-scheme').value = schemeId; return; } schemeId = $('#set-scheme').value; selectSet(state.sets.find(s => s.scheme === schemeId)?.id ?? ''); };
$('#set-search').oninput = renderList;
window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
load(location.hash.slice(1)).catch(error => { $('#notice').hidden = false; $('#notice').textContent = error.message; });
