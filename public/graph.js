import './viewer.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const types = ['broader','narrower','related','opposite'];
let graph = {concepts:[],relations:[],schemes:[],version:0}, selected = decodeURIComponent(location.hash.slice(1)), scheme = new URLSearchParams(location.search).get('scheme') ?? '', generation = 0, busy = false;
let pendingHierarchy = null, connectionEpoch = 0, hierarchyApplying = false;
const hierarchyDialog = $('#graph-hierarchy-dialog');
const node = id => graph.concepts.find(c => c.id === id);
async function api(path, options = {}) {
 const response = await fetch('/api/' + path, {...options,headers:{'Content-Type':'application/json'}}), data = await response.json();
 if (!response.ok) throw new Error(data.error || 'Request failed.'); return data;
}
function error(message) { $('#graph-notice').textContent = message; $('#graph-notice').hidden = !message; }
async function load(preferred = selected) {
 invalidateHierarchy();
 const token = ++generation; busy = true; $('#graph-link-form').inert = true;
 try {
  const state = await api('state'); if (token !== generation) return;
  if (!state.schemes.some(s => s.id === scheme)) scheme = state.terms.find(t => t.id === preferred)?.scheme ?? state.schemes[0]?.id ?? '';
  const result = await api(`graph?scheme=${encodeURIComponent(scheme)}&at=${state.version}`); if (token !== generation) return;
  graph = result; selected = node(preferred)?.id ?? graph.concepts[0]?.id ?? '';
  $('#graph-scheme').innerHTML = state.schemes.map(s => `<option value="${escape(s.id)}">${escape(s.label)}</option>`).join(''); $('#graph-scheme').value = scheme;
  $('#graph-version').textContent = '#' + graph.version;
  $('#graph-new').href = `/?scheme=${encodeURIComponent(scheme)}&create=term`;
  $('#graph-export').href = `/api/graph?scheme=${encodeURIComponent(scheme)}&at=${graph.version}`;
  error(''); render();
 } catch (e) { if (token === generation) error(e.message); }
 finally { if (token === generation) { busy = false; $('#graph-link-form').inert = false; } }
}
function focus(id) { if (busy || !node(id)) return; invalidateHierarchy(); selected = id; render(); }
function renderList() {
 const query = $('#graph-search').value.toLowerCase();
 $('#graph-concepts').innerHTML = graph.concepts.filter(c => [c.label,...c.altLabels,...c.aliases].some(v => v.toLowerCase().includes(query))).map(c => `<div class="tree-item ${c.id === selected ? 'selected' : ''}"><button type="button" class="tree-pick" data-focus="${escape(c.id)}">${escape(c.label)}</button></div>`).join('') || '<p class="tree-empty">No concepts found.</p>';
}
function targets() {
 const previous = $('#graph-target').value;
 const query = $('#graph-target-search').value.toLowerCase();
 $('#graph-target').innerHTML = graph.concepts.filter(c => c.id !== selected && c.label.toLowerCase().includes(query)).map(c => `<option value="${escape(c.id)}">${escape(c.label)}</option>`).join('');
 if ([...$('#graph-target').options].some(option=>option.value===previous)) $('#graph-target').value = previous;
}
function render() {
 renderList(); targets();
 const concept = node(selected); $('#graph-link-form').hidden = !concept;
 if (!concept) { $('#graph-map').innerHTML = ''; $('#graph-links').innerHTML = ''; $('#graph-detail').innerHTML = '<h1>No active concepts</h1><p>Create or import a graph to get started.</p>'; return; }
 history.replaceState(null,'',`?scheme=${encodeURIComponent(scheme)}#${encodeURIComponent(selected)}`);
 $('#graph-detail').innerHTML = `<span class="eyebrow">Concept</span><h1>${escape(concept.label)}</h1>${concept.scopeNote ? `<p>${escape(concept.scopeNote)}</p>` : ''}${concept.altLabels.length ? `<p class="help">Also: ${concept.altLabels.map(escape).join(', ')}</p>` : ''}<a href="/#${encodeURIComponent(selected)}">Edit concept ↗</a>`;
 $('#graph-links').innerHTML = types.map(type => {
  const edges = graph.relations.filter(e => e.from === selected && e.type === type).sort((a,b) => node(a.to).label.localeCompare(node(b.to).label));
  return `<section class="graph-relation-group"><h2>${escape(type)} <span class="help">${edges.length}</span></h2>${edges.map(e => `<div><button type="button" class="text-button" data-focus="${escape(e.to)}">${escape(node(e.to)?.label)}</button><button type="button" class="text-button" data-write data-remove="${escape(e.to)}" data-type="${type}" aria-label="Remove ${type} ${escape(node(e.to)?.label)}">×</button></div>`).join('') || '<p class="help">None</p>'}</section>`;
 }).join('');
 const allowed = new Set([...$('#graph-types').querySelectorAll(':checked')].map(c => c.value)), levels = new Map([[selected,0]]);
 let frontier = [selected];
 for (let depth = 1; depth <= Number($('#graph-depth').value); depth++) {
  const next = [];
  for (const id of frontier) for (const e of graph.relations) if (e.from === id && allowed.has(e.type) && !levels.has(e.to)) { levels.set(e.to,depth); next.push(e.to); }
  frontier = next;
 }
 const all = [...levels.keys()], visible = all.slice(0,150), keep = new Set(visible), positions = new Map([[selected,{x:0,y:0}]]);
 for (let depth = 1; depth <= Number($('#graph-depth').value); depth++) {
  const ring = visible.filter(id => levels.get(id) === depth), radius = 165 + (depth - 1) * 80;
  ring.forEach((id,i) => { const angle = 2*Math.PI*i/ring.length - Math.PI/2; positions.set(id,{x:radius*Math.cos(angle)*1.35,y:radius*Math.sin(angle)}); });
 }
 const edges = new Map();
 for (const edge of graph.relations) if (allowed.has(edge.type) && keep.has(edge.from) && keep.has(edge.to)) {
  const e = edge.type === 'narrower' ? {from:edge.to,to:edge.from,type:'broader'} : edge;
  const pair = ['related','opposite'].includes(e.type) ? [e.from,e.to].sort() : [e.from,e.to];
  edges.set(`${e.type}:${pair.join(':')}`,e);
 }
 $('#graph-size').textContent = `${graph.concepts.length} concepts in scheme · ${visible.length} shown${all.length > visible.length ? ` of ${all.length} in this neighbourhood; reduce depth to see labels clearly` : ''}`;
 $('#graph-map').innerHTML = `<defs><marker id="graph-arrow" markerWidth="9" markerHeight="9" refX="19" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9" fill="#829082"/></marker></defs>${[...edges.values()].map(e => { const a=positions.get(e.from), b=positions.get(e.to); return `<line class="graph-edge ${e.type}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" ${e.type === 'broader' ? 'marker-end="url(#graph-arrow)"' : ''}><title>${escape(node(e.from)?.label)} ${escape(e.type)} ${escape(node(e.to)?.label)}</title></line>`; }).join('')}${visible.map(id => { const p=positions.get(id), c=node(id); return `<g class="graph-node ${id === selected ? 'focus' : ''}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${escape(c.label)}" data-focus="${escape(id)}"><title>${escape(c.label)}</title><circle r="${id === selected ? 18 : 11}"/><text y="${id === selected ? 36 : 29}" text-anchor="middle">${escape(c.label.length > 30 ? c.label.slice(0,29)+'…' : c.label)}</text></g>`; }).join('')}`;
}
async function relation(to,type,enabled) {
 if (['broader','narrower'].includes(type)) { await previewHierarchy(to,type,enabled); return; }
 if (busy) return;
 busy = true; $('#graph-link-form').inert = true;
 try { await api('relations',{method:enabled?'POST':'DELETE',body:JSON.stringify({from:selected,to,type,expectedVersion:graph.version})}); await load(selected); }
 catch(e) { error(e.message + ' Use Refresh to reload the current graph.'); }
 finally {busy=false;$('#graph-link-form').inert=false;}
}
$('#graph-link-form').onsubmit = event => { event.preventDefault(); if ($('#graph-target').value) relation($('#graph-target').value,$('#graph-link-type').value,true); };
$('#graph-links').onclick = event => {
 const remove = event.target.closest('[data-remove]');
 if (remove && (['broader','narrower'].includes(remove.dataset.type) || confirm(`Remove this ${remove.dataset.type} relationship?`))) relation(remove.dataset.remove,remove.dataset.type,false);
};
document.addEventListener('click',event => {const id=event.target.closest('[data-focus]')?.dataset.focus;if(id)focus(id);});
$('#graph-map').addEventListener('keydown',event => {if(['Enter',' '].includes(event.key)){const id=event.target.closest('[data-focus]')?.dataset.focus;if(id){event.preventDefault();focus(id);}}});
function invalidateHierarchy() {
 connectionEpoch++; pendingHierarchy = null;
 if (hierarchyDialog.open && !hierarchyApplying) hierarchyDialog.close();
}
async function previewHierarchy(to,type,enabled) {
 if (busy) return;
 const focusId = selected, child = node(type === 'broader' ? selected : to), parent = node(type === 'broader' ? to : selected);
 if (!child || !parent) return;
 if (enabled && child.broader.includes(parent.id)) { error('This hierarchy relationship already exists.'); return; }
 const tree = graph.schemes.find(s=>s.id===child.scheme)?.hierarchy === 'tree';
 const broader = enabled ? tree ? [parent.id] : [...child.broader,parent.id] : child.broader.filter(id=>id!==parent.id);
 const input = {kind:'move',broader,expectedVersion:graph.version};
 const token = generation, epoch = ++connectionEpoch;
 pendingHierarchy = null; busy = true; $('#graph-link-form').inert = true; error('');
 try {
  const preview = await api(`terms/${child.id}/operations/preview`,{method:'POST',body:JSON.stringify(input)});
  if (token !== generation || epoch !== connectionEpoch) return;
  const labels = new Map([...graph.concepts,...preview.affected.map(row=>row.after)].map(c=>[c.id,c.label]));
  const names = ids => ids.length ? ids.map(id=>labels.get(id)??id).join(', ') : 'None';
  pendingHierarchy = {child:child.id,input,focusId,token,epoch};
  $('#graph-hierarchy-title').textContent = `${enabled ? 'Connect' : 'Disconnect'} ${node(focusId).label} · ${type} · ${node(to).label}`;
  $('#graph-hierarchy-preview').innerHTML = `<strong>${escape(child.label)}</strong><p>Broader concepts: ${escape(names(child.broader))} → ${escape(names(broader))}</p>${tree && enabled && child.broader.length ? '<p>This tree scheme permits one parent. The current parent will be replaced.</p>' : '<p>Other broader relationships are preserved.</p>'}<p>${preview.affected.length} affected concepts. Descendant paths and aliases are updated atomically. Subscriber usage is unknown.</p>${preview.affectedSets?.length ? `<h3>Concept sets affected</h3><ul>${preview.affectedSets.map(set=>`<li><strong>${escape(set.label)}</strong> · ${set.before.length} → ${set.after.length} terms<br>${escape(set.note)}</li>`).join('')}</ul>` : ''}`;
  $('#graph-hierarchy-error').textContent = ''; $('#graph-hierarchy-apply').disabled = false;
  hierarchyDialog.showModal();
 } catch(e) { if (token === generation && epoch === connectionEpoch) error(e.message + ' Use Refresh to reload the current graph.'); }
 finally { if (token === generation) {busy=false;$('#graph-link-form').inert=false;} }
}
$('#graph-hierarchy-apply').onclick = async () => {
 const pending = pendingHierarchy;
 if (!pending || busy || pending.token !== generation || pending.epoch !== connectionEpoch) return;
 busy = true; hierarchyApplying = true; hierarchyDialog.inert = true;
 try {
  await api(`terms/${pending.child}/operations/apply`,{method:'POST',body:JSON.stringify(pending.input)});
  hierarchyDialog.close(); await load(pending.focusId);
 } catch(e) { $('#graph-hierarchy-error').textContent = e.message; $('#graph-hierarchy-apply').disabled = true; }
 finally {busy=false;hierarchyApplying=false;hierarchyDialog.inert=false;}
};
$('#graph-hierarchy-cancel').onclick = () => { if (!hierarchyApplying) hierarchyDialog.close(); };
hierarchyDialog.addEventListener('cancel',event=>{if(hierarchyApplying)event.preventDefault();});
hierarchyDialog.addEventListener('close',()=>{connectionEpoch++;pendingHierarchy=null;});
$('#graph-link-type').onchange = () => {
 invalidateHierarchy();
 const type = $('#graph-link-type').value, hierarchical = ['broader','narrower'].includes(type);
 $('#graph-connect').textContent = hierarchical ? 'Preview relationship' : 'Add relationship';
 $('#graph-relationship-help').textContent = type === 'broader' ? 'The target is broader than the selected concept.' : type === 'narrower' ? 'The target is narrower than the selected concept.' : 'Related and opposite relationships connect both concepts.';
};
$('#graph-target').onchange=invalidateHierarchy;
$('#graph-target-search').addEventListener('input',invalidateHierarchy);
$('#graph-search').oninput=renderList;$('#graph-target-search').oninput=targets;
$('#graph-scheme').onchange=()=>{scheme=$('#graph-scheme').value;load('');};
$('#graph-depth').onchange=()=>{invalidateHierarchy();render();};$('#graph-types').onchange=()=>{invalidateHierarchy();render();};$('#graph-refresh').onclick=()=>load(selected);
load();
