// Exports the graph as drawn: an image of the current view (SVG, PNG), or the concepts and relations on screen with
// their positions, for further layout in Gephi (GEXF), Cytoscape (XGMML), yEd and others (GraphML, GML).
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
// GML is ASCII: other characters travel as numeric entities, as do quotes and ampersands.
const gmlString = value => `"${String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/[^\x20-\x7e]/gu, c => `&#${c.codePointAt(0)};`)}"`;
const colors = { node: '#dce8d2', focus: '#245c46', outline: '#43684c', broader: '#829082', related: '#5d8ca9', opposite: '#b28241' };
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const directed = type => type === 'broader';
const size = n => n.focus ? 18 : 11;
// The page's stylesheet doesn't travel with an exported SVG, so the graph's rules are repeated here.
const style = `.graph-edge{stroke:${colors.broader};stroke-width:1.5}.graph-edge.related{stroke:${colors.related}}
.graph-edge.opposite{stroke:${colors.opposite};stroke-dasharray:6 4}.graph-node circle{fill:${colors.node};stroke:${colors.outline};stroke-width:2}
.graph-node.focus circle{fill:${colors.focus}}.graph-node text{font:13px system-ui,-apple-system,"Segoe UI",sans-serif;fill:#203c2c;paint-order:stroke;stroke:#fafcf7;stroke-width:3px}`;

function svgText(svg) {
  const copy = svg.cloneNode(true), [, , w, h] = svg.getAttribute('viewBox').split(' ').map(Number);
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', Math.round(w)); copy.setAttribute('height', Math.round(h));
  for (const element of copy.querySelectorAll('[tabindex],[role],[data-focus]')) for (const name of ['tabindex', 'role', 'data-focus']) element.removeAttribute(name);
  const [x, y] = svg.getAttribute('viewBox').split(' ').map(Number);
  copy.insertAdjacentHTML('afterbegin', `<style>${style}</style><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fafcf7"/>`);
  return new XMLSerializer().serializeToString(copy);
}
function png(svg) {
  const [, , w, h] = svg.getAttribute('viewBox').split(' ').map(Number), scale = 2;
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(w * scale), height: Math.round(h * scale) });
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The image could not be rendered.')), 'image/png');
    };
    image.onerror = () => reject(new Error('The image could not be rendered.'));
    // A data URL, because the page's content security policy allows images only from itself and data:.
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText(svg));
  });
}
function graphml({ nodes, links }) {
  const keys = [['label', 'node', 'string'], ['depth', 'node', 'int'], ['focus', 'node', 'boolean'], ['x', 'node', 'double'], ['y', 'node', 'double'], ['type', 'edge', 'string']];
  return `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
${keys.map(([id, scope, type]) => `  <key id="${id}" for="${scope}" attr.name="${id}" attr.type="${type}"/>`).join('\n')}
  <graph id="G" edgedefault="directed">
${nodes.map(n => `    <node id="${xml(n.id)}"><data key="label">${xml(n.label)}</data><data key="depth">${n.depth}</data><data key="focus">${n.focus}</data><data key="x">${n.x.toFixed(2)}</data><data key="y">${n.y.toFixed(2)}</data></node>`).join('\n')}
${links.map((l, i) => `    <edge id="e${i}" source="${xml(l.source)}" target="${xml(l.target)}" directed="${directed(l.type)}"><data key="type">${l.type}</data></edge>`).join('\n')}
  </graph>
</graphml>
`;
}
// Gephi draws y upward, so positions are flipped to match the screen.
function gexf({ nodes, links, title }) {
  const color = hex => { const [r, g, b] = rgb(hex); return `<viz:color r="${r}" g="${g}" b="${b}"/>`; };
  return `<?xml version="1.0" encoding="UTF-8"?>
<gexf xmlns="http://www.gexf.net/1.2draft" xmlns:viz="http://www.gexf.net/1.2draft/viz" version="1.2">
  <meta><creator>terminology-mcp</creator><description>${xml(title)}</description></meta>
  <graph defaultedgetype="directed" mode="static">
    <attributes class="node"><attribute id="depth" title="depth" type="integer"/><attribute id="focus" title="focus" type="boolean"/></attributes>
    <attributes class="edge"><attribute id="type" title="type" type="string"/></attributes>
    <nodes>
${nodes.map(n => `      <node id="${xml(n.id)}" label="${xml(n.label)}"><attvalues><attvalue for="depth" value="${n.depth}"/><attvalue for="focus" value="${n.focus}"/></attvalues><viz:size value="${size(n)}"/><viz:position x="${n.x.toFixed(2)}" y="${(-n.y).toFixed(2)}" z="0"/>${color(n.focus ? colors.focus : colors.node)}</node>`).join('\n')}
    </nodes>
    <edges>
${links.map((l, i) => `      <edge id="${i}" source="${xml(l.source)}" target="${xml(l.target)}" type="${directed(l.type) ? 'directed' : 'undirected'}" label="${l.type}"><attvalues><attvalue for="type" value="${l.type}"/></attvalues>${color(colors[l.type])}</edge>`).join('\n')}
    </edges>
  </graph>
</gexf>
`;
}
// GML numbers its nodes; the concept's stable ID travels as an attribute.
function gml({ nodes, links, title }) {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  return `graph [
  comment ${gmlString(title)}
  directed 1
${nodes.map((n, i) => `  node [
    id ${i}
    label ${gmlString(n.label)}
    concept ${gmlString(n.id)}
    depth ${n.depth}
    focus ${n.focus ? 1 : 0}
    graphics [ x ${n.x.toFixed(2)} y ${n.y.toFixed(2)} w ${size(n) * 2} h ${size(n) * 2} type "ellipse" fill "${n.focus ? colors.focus : colors.node}" ]
  ]`).join('\n')}
${links.map(l => `  edge [
    source ${index.get(l.source)}
    target ${index.get(l.target)}
    label ${gmlString(l.type)}
    graphics [ fill "${colors[l.type]}" ]
  ]`).join('\n')}
]
`;
}
function xgmml({ nodes, links, title }) {
  const index = new Map(nodes.map((n, i) => [n.id, i + 1]));
  return `<?xml version="1.0" encoding="UTF-8"?>
<graph label="${xml(title)}" directed="1" xmlns="http://www.cs.rpi.edu/XGMML" xmlns:xlink="http://www.w3.org/1999/xlink">
${nodes.map(n => `  <node id="${index.get(n.id)}" label="${xml(n.label)}"><att name="concept" type="string" value="${xml(n.id)}"/><att name="depth" type="integer" value="${n.depth}"/><att name="focus" type="boolean" value="${n.focus}"/><graphics type="ELLIPSE" x="${n.x.toFixed(2)}" y="${n.y.toFixed(2)}" w="${size(n) * 2}" h="${size(n) * 2}" fill="${n.focus ? colors.focus : colors.node}" outline="${colors.outline}"/></node>`).join('\n')}
${links.map((l, i) => `  <edge id="e${i}" source="${index.get(l.source)}" target="${index.get(l.target)}" label="${l.type}"><att name="type" type="string" value="${l.type}"/><att name="directed" type="boolean" value="${directed(l.type)}"/><graphics fill="${colors[l.type]}" width="1.5"/></edge>`).join('\n')}
</graph>
`;
}

const formats = {
  svg: [drawing => new Blob([svgText(drawing.svg)], { type: 'image/svg+xml' }), 'svg'],
  png: [drawing => png(drawing.svg), 'png'],
  gexf: [drawing => new Blob([gexf(drawing)], { type: 'application/xml' }), 'gexf'],
  graphml: [drawing => new Blob([graphml(drawing)], { type: 'application/xml' }), 'graphml'],
  gml: [drawing => new Blob([gml(drawing)], { type: 'text/plain' }), 'gml'],
  xgmml: [drawing => new Blob([xgmml(drawing)], { type: 'application/xml' }), 'xgmml'],
};
/** drawing: {svg, nodes: [{id, label, depth, focus, x, y}], links: [{source, target, type}], title, name}. */
export async function exportGraph(format, drawing) {
  const [make, extension] = formats[format];
  const url = URL.createObjectURL(await make(drawing));
  const link = Object.assign(document.createElement('a'), { href: url, download: `${drawing.name}.${extension}` });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export { graphml, gexf, gml, xgmml };
