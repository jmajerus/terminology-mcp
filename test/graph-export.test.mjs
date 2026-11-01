import test from 'node:test';
import assert from 'node:assert/strict';
import { graphml, gexf, gml, xgmml } from '../public/graph-export.js';

const drawing = {
  title: 'Café & “Bar” · subjects',
  nodes: [
    { id: 't_a', label: 'Café <Bar> & "Grill"', depth: 0, focus: true, x: 0, y: 0 },
    { id: 't_b', label: 'Ελληνικά', depth: 1, focus: false, x: 12.345, y: -67.8 },
    { id: 't_c', label: 'Plain', depth: 1, focus: false, x: -40, y: 25 },
  ],
  links: [{ source: 't_b', target: 't_a', type: 'broader' }, { source: 't_b', target: 't_c', type: 'related' }],
};

test('XML exports escape labels and keep positions and relation direction', () => {
  for (const text of [graphml(drawing), gexf(drawing), xgmml(drawing)]) {
    assert.match(text, /Café &lt;Bar&gt; &amp; &quot;Grill&quot;/);
    assert.ok(!text.includes('<Bar>'));
  }
  assert.match(graphml(drawing), /<edge id="e0" source="t_b" target="t_a" directed="true">/);
  assert.match(graphml(drawing), /<edge id="e1" source="t_b" target="t_c" directed="false">/);
  assert.match(graphml(drawing), /<data key="x">12.35<\/data><data key="y">-67.80<\/data>/);
  // Gephi draws y upward, so GEXF flips it.
  assert.match(gexf(drawing), /<viz:position x="12.35" y="67.80" z="0"\/>/);
  assert.match(gexf(drawing), /type="undirected" label="related"/);
  assert.match(xgmml(drawing), /<node id="2" label="Ελληνικά"><att name="concept" type="string" value="t_b"\/>/);
});

test('GML is ASCII, numbers its nodes and keeps the concept ID', () => {
  const text = gml(drawing);
  assert.ok(/^[\x00-\x7f]*$/.test(text));
  assert.match(text, /label "Caf&#233; <Bar> &amp; &quot;Grill&quot;"/);
  assert.match(text, /label "&#917;&#955;/);
  assert.match(text, /id 1\n    label "&#917;[^"]*"\n    concept "t_b"/);
  assert.match(text, /source 1\n    target 0\n    label "broader"/);
});
