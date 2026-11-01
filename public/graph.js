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
 const all = [...levels.keys()], visible = all.slice(0,150), keep = new Set(visible);
 const edges = new Map();
 for (const edge of graph.relations) if (allowed.has(edge.type) && keep.has(edge.from) && keep.has(edge.to)) {
  const e = edge.type === 'narrower' ? {from:edge.to,to:edge.from,type:'broader'} : edge;
  const pair = ['related','opposite'].includes(e.type) ? [e.from,e.to].sort() : [e.from,e.to];
  edges.set(`${e.type}:${pair.join(':')}`,e);
 }
 $('#graph-size').textContent = `${graph.concepts.length} concepts in scheme · ${visible.length} shown${all.length > visible.length ? ` of ${all.length} in this neighbourhood; reduce depth to see labels clearly` : ''}`;
 draw(visible,[...edges.values()],levels);
}
// Force-directed layout: the focus stays at the centre, each depth is drawn toward its own ring, and links, repulsion
// and label-sized collision untangle the rest. The layout is settled before drawing, then the view glides to it from
// the previous positions; dragging a node re-settles the graph live around it.
let simulation = null, placed = new Map(), view = null, glide = 0;
const shortLabel = c => c.label.length > 30 ? c.label.slice(0,29)+'…' : c.label;
function draw(ids,relations,levels) {
 simulation?.stop(); cancelAnimationFrame(glide);
 const svg = $('#graph-map'), reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
 const nodes = ids.map(id => ({id,depth:levels.get(id),width:shortLabel(node(id)).length*7+16}));
 const byId = new Map(nodes.map(n => [n.id,n])), links = relations.map(e => ({source:e.from,target:e.to,type:e.type}));
 // Start from a radial tree, each branch given a sector sized by the concepts under it, so the forces refine an
 // untangled arrangement. Concepts drawn before keep their place, shifted so the new focus sits at the centre.
 const shift = placed.get(selected) ?? {x:0,y:0}, children = new Map(nodes.map(n => [n.id,[]]));
 for (const n of nodes.slice(1)) {
  const parent = relations.map(e => e.from === n.id ? e.to : e.to === n.id ? e.from : null).find(id => byId.get(id)?.depth === n.depth-1);
  children.get(parent ?? selected).push(n.id);
 }
 const leaves = id => children.get(id).length ? children.get(id).reduce((sum,child) => sum+leaves(child),0) : 1, angles = new Map();
 const sector = (id,from,to) => {
  angles.set(id,(from+to)/2); let at = from;
  for (const child of children.get(id)) { const span = (to-from)*leaves(child)/leaves(id); sector(child,at,at+span); at += span; }
 };
 sector(selected,-Math.PI/2,Math.PI*1.5);
 for (const n of nodes) {
  const known = placed.get(n.id), a = angles.get(n.id) ?? 0;
  Object.assign(n,known ? {x:known.x-shift.x,y:known.y-shift.y} : {x:Math.cos(a)*n.depth*125*1.3,y:Math.sin(a)*n.depth*125});
 }
 Object.assign(nodes[0],{fx:0,fy:0});
 simulation = d3.forceSimulation(nodes)
  .force('link',d3.forceLink(links).id(n => n.id).distance(l => l.type === 'broader' ? 75 : 100).strength(0.8))
  .force('charge',d3.forceManyBody().strength(-200).distanceMax(500))
  .force('ring',d3.forceRadial(n => n.depth*125,0,0).strength(n => n.depth ? 0.05 : 0))
  .force('collide',d3.forceCollide(n => 14+n.width*0.27).strength(0.9))
  .stop();
 for (let i = 0; i < 300; i++) simulation.tick();
 // The glide starts from the previous drawing in the new frame; new concepts emerge from the focus.
 const start = new Map(nodes.map(n => { const p = placed.get(n.id); return [n.id,p ? {x:p.x-shift.x,y:p.y-shift.y} : {x:0,y:0}]; }));
 const from = view && view.map((v,i) => i === 0 ? v-shift.x : i === 1 ? v-shift.y : v);
 placed = new Map([...placed].map(([id,p]) => [id,{x:p.x-shift.x,y:p.y-shift.y}]));
 for (const n of nodes) placed.set(n.id,{x:n.x,y:n.y});
 svg.innerHTML = `<defs><marker id="graph-arrow" markerWidth="9" markerHeight="9" refX="19" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9" fill="#829082"/></marker></defs>${links.map(l => `<line class="graph-edge ${l.type}" ${l.type === 'broader' ? 'marker-end="url(#graph-arrow)"' : ''}><title>${escape(node(l.source.id)?.label)} ${escape(l.type)} ${escape(node(l.target.id)?.label)}</title></line>`).join('')}${nodes.map(n => `<g class="graph-node ${n.id === selected ? 'focus' : ''}" tabindex="0" role="button" aria-label="${escape(node(n.id).label)}" data-focus="${escape(n.id)}"><title>${escape(node(n.id).label)}</title><circle r="${n.id === selected ? 18 : 11}"/><text y="${n.id === selected ? 36 : 29}" text-anchor="middle">${escape(shortLabel(node(n.id)))}</text></g>`).join('')}`;
 const lines = [...svg.querySelectorAll('.graph-edge')], groups = [...svg.querySelectorAll('.graph-node')];
 const paint = at => {
  links.forEach((l,i) => { const a = at(l.source), b = at(l.target); lines[i].setAttribute('x1',a.x); lines[i].setAttribute('y1',a.y); lines[i].setAttribute('x2',b.x); lines[i].setAttribute('y2',b.y); });
  nodes.forEach((n,i) => { const p = at(n); groups[i].setAttribute('transform',`translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`); });
 };
 // Labels sit on the outward side of each concept, along its branch rather than across it; the focus keeps its label below.
 const side = () => nodes.forEach((n,i) => {
  const text = groups[i].querySelector('text'), out = n.id === selected || Math.abs(n.x) < 30 ? 0 : Math.sign(n.x);
  text.setAttribute('text-anchor',out > 0 ? 'start' : out < 0 ? 'end' : 'middle');
  text.setAttribute('x',out*16); text.setAttribute('y',out ? 4 : n.id === selected ? 36 : 29);
 });
 side();
 const fit = () => {
  const xs = nodes.flatMap(n => Math.abs(n.x) < 30 || n.id === selected ? [n.x-n.width/2,n.x+n.width/2] : n.x > 0 ? [n.x-15,n.x+n.width+10] : [n.x-n.width-10,n.x+15]), ys = nodes.flatMap(n => [n.y-30,n.y+45]);
  const x0 = Math.min(...xs)-30, x1 = Math.max(...xs)+30, y0 = Math.min(...ys)-20, y1 = Math.max(...ys)+20;
  // The map grows taller for a round neighbourhood (up to square) and never draws text larger than its set size.
  const w = Math.max(x1-x0,y1-y0,svg.clientWidth || 720), h = Math.max(y1-y0,w/1.6);
  return [(x0+x1-w)/2,(y0+y1-h)/2,w,h];
 };
 const to = fit(), setView = box => { view = box; svg.setAttribute('viewBox',box.map(v => v.toFixed(1)).join(' ')); };
 if (reduced || !from) { paint(n => n); setView(to); }
 else {
  const began = performance.now(), ease = t => 1-(1-t)**3;
  const frame = now => {
   const t = ease(Math.min(1,(now-began)/650)), mix = (a,b) => a+(b-a)*t;
   paint(n => { const s0 = start.get(n.id); return {x:mix(s0.x,n.x),y:mix(s0.y,n.y)}; });
   setView(from.map((v,i) => mix(v,to[i])));
   if (t < 1) glide = requestAnimationFrame(frame);
  };
  glide = requestAnimationFrame(frame);
 }
 drag(svg,groups,nodes,() => { paint(n => n); for (const n of nodes) placed.set(n.id,{x:n.x,y:n.y}); });
}
// Dragging pins a node under the pointer while the simulation re-settles the rest; a drag doesn't count as a click.
let dragged = false;
function drag(svg,groups,nodes,paint) {
 groups.forEach((g,i) => g.addEventListener('pointerdown',event => {
  if (event.button !== 0) return;
  const n = nodes[i], point = e => new DOMPoint(e.clientX,e.clientY).matrixTransform(svg.getScreenCTM().inverse()), origin = point(event);
  let moved = false; dragged = false;
  g.setPointerCapture(event.pointerId);
  const move = e => {
   const p = point(e);
   if (!moved && Math.hypot(p.x-origin.x,p.y-origin.y) < 4) return;
   if (!moved) { moved = true; cancelAnimationFrame(glide); simulation.on('tick',paint).alphaTarget(0.3).restart(); }
   n.fx = p.x; n.fy = p.y;
  };
  const up = () => {
   g.removeEventListener('pointermove',move); g.removeEventListener('pointerup',up); g.removeEventListener('pointercancel',up);
   if (!moved) return;
   dragged = true; simulation.alphaTarget(0);
   if (n.id !== selected) { n.fx = null; n.fy = null; }
  };
  g.addEventListener('pointermove',move); g.addEventListener('pointerup',up); g.addEventListener('pointercancel',up);
 }));
}
$('#graph-map').addEventListener('click',event => { if (dragged) { dragged = false; event.stopPropagation(); } },true);
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
