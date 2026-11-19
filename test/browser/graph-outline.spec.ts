import { test, expect } from '@playwright/test';

test('a concept graph is outlined by its broader links, with what the outline imposes marked', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await request.post('/api/schemes', { data: { id: 'go-graph', label: 'Outlined graph', hierarchy: 'graph' } });
  const add = async (data: object) => (await (await request.post('/api/terms', { data: { scheme: 'go-graph', status: 'active', ...data } })).json()).term;
  const work = await add({ label: 'Work' });
  const art = await add({ label: 'Art' });
  const labour = await add({ label: 'Labour', broader: [work.id] });
  await add({ label: 'Craft', broader: [work.id, art.id] });
  const control = await add({ label: 'Control', broader: [work.id] });
  const fear = await add({ label: 'Fear', relations: [{ type: 'related', target: labour.id }] });
  await add({ label: 'Trust', relations: [{ type: 'related', target: fear.id }, { type: 'opposite', target: control.id }] });

  await page.goto('/?scheme=go-graph');
  const tree = page.locator('#tree');
  await expect(page.locator('#scheme-shape')).toHaveText('⑃ polyhierarchy · 1 multi-parent · ⁂ 3 links · ○ 2 unplaced');
  await expect(page.locator('#scheme-shape')).toHaveAttribute('title', /7 active terms; 4 broader links, 1 term with several broader terms; 2 related pairs, 1 opposite pair; 2 concepts/);
  const rows = tree.locator('.tree-item, .tree-group');
  const text = async () => (await rows.allInnerTexts()).map(row => row.replace(/\s+/g, ' ').trim());
  // The broader hierarchy as an outline (alphabetical, with screen-reader text). Craft has two broader terms:
  // its first place is marked ⑃ and its second is a shared reference. Concepts outside the hierarchy come last.
  expect(await text()).toEqual(['▾ Art active', '· Craft ⑃ 2 broader terms active', '▾ Work active', '· Control ↔ 1 active',
    '↗ Craft shared active', '· Labour ↔ 1 active', '▾ ○ Unplaced · 2', '· Fear ↔ 2 active', '· Trust ↔ 2 active']);
  await expect(tree.locator('[data-multi-parent]')).toHaveAttribute('title', /2 broader terms \(Work, Art\)/);

  // Related and opposite terms open beside the hierarchy, marked as associations; a way back up the branch is a cycle.
  await tree.getByRole('button', { name: 'Show 2 related or opposite terms of Trust' }).click();
  await expect(tree.getByRole('button', { name: 'Hide 2 related or opposite terms of Trust' })).toBeFocused();
  const links = tree.locator('.link-item');
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute('data-link-kind', 'related');
  await expect(links.nth(0).locator('.tree-glyph')).toHaveText('↔'); await expect(links.nth(0).locator('.tree-pick')).toHaveText('Fear');
  await expect(links.nth(1)).toHaveAttribute('data-link-kind', 'opposite');
  await expect(links.nth(1).locator('.tree-glyph')).toHaveText('≠'); await expect(links.nth(1).locator('.tree-pick')).toHaveText('Control');
  await links.nth(0).getByRole('button', { name: /Show 2 related or opposite terms of Fear/ }).click();
  // Fear's links open wherever Fear appears, and each branch stops (↺) where it would lead back to a term
  // already open above it. Rows read as level, glyph, label.
  const linkRows = async () => links.evaluateAll(rows => rows.map(row =>
    `${(parseInt((row as HTMLElement).style.paddingLeft) - 7) / 16} ${row.querySelector('.tree-glyph')!.textContent} ${row.querySelector('.tree-pick')!.textContent}`));
  await expect.poll(linkRows).toEqual([
    '1 ↔ Labour', '1 ↔ Trust', '2 ↺ Fear', '2 ≠ Control', // under Fear, in the Unplaced list; Trust's links are open too
    '1 ↔ Fear', '2 ↔ Labour', '2 ↺ Trust', '1 ≠ Control']); // under Trust
  const cycle = links.filter({ has: page.locator('.tree-glyph', { hasText: '↺' }) });
  await expect(cycle.locator('[data-links]')).toHaveCount(0);

  // A link row picks its term like any other row.
  await links.nth(0).getByRole('button', { name: 'Labour', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Labour', exact: true })).toBeVisible();

  await tree.getByRole('button', { name: 'Collapse unplaced concepts' }).click();
  await expect(tree.getByRole('button', { name: 'Expand unplaced concepts' })).toBeFocused();
  await expect(tree.getByRole('button', { name: 'Trust', exact: true })).toHaveCount(0);

  // Filtering still finds an unplaced concept.
  await page.locator('#search').fill('trus');
  await expect(tree.getByRole('button', { name: 'Trust', exact: true })).toHaveCount(0);
  await tree.getByRole('button', { name: 'Expand unplaced concepts' }).click();
  await expect(tree.locator('.tree-item:not(.link-item)').getByRole('button', { name: 'Trust', exact: true })).toBeVisible();
  await expect(tree.getByRole('button', { name: 'Work', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a tree scheme lists childless top-level terms in the outline, not as unplaced, and shows its shape', async ({ page, request }) => {
  await request.post('/api/schemes', { data: { id: 'go-tree', label: 'Outlined tree', hierarchy: 'tree' } });
  const add = async (data: object) => (await (await request.post('/api/terms', { data: { scheme: 'go-tree', status: 'active', ...data } })).json()).term;
  const root = await add({ label: 'Root' });
  await add({ label: 'Leaf', broader: [root.id] });
  await add({ label: 'Alone' });
  await page.goto('/?scheme=go-tree');
  await expect(page.locator('#scheme-shape')).toHaveText('⑂ tree');
  await expect(page.locator('#tree [data-unplaced-group]')).toHaveCount(0);
  await expect(page.locator('#tree').getByRole('button', { name: 'Alone', exact: true })).toBeVisible();
});

test('a concept graph can opt out of the outline in its settings and be listed A–Z', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await request.post('/api/schemes', { data: { id: 'go-list', label: 'Listed graph', hierarchy: 'graph' } });
  const add = async (data: object) => (await (await request.post('/api/terms', { data: { scheme: 'go-list', status: 'active', ...data } })).json()).term;
  const work = await add({ label: 'Work' });
  const art = await add({ label: 'Art' });
  await add({ label: 'Craft', broader: [work.id, art.id] });
  await add({ label: 'Trust', relations: [{ type: 'related', target: work.id }] });

  await page.goto('/?scheme=go-list');
  await expect(page.locator('#tree [data-unplaced-group]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Scheme settings' }).click();
  await expect(page.locator('#scheme-outline')).toHaveValue('hierarchy');
  await page.locator('#scheme-outline').selectOption('list');
  await page.locator('#save-scheme').click();
  await expect(page.locator('#notice')).toContainText('Saved the settings of Listed graph');

  // Every concept once, A–Z, with nothing imposed: no nesting, no ⑃, no shared rows, no Unplaced group.
  await expect(page.locator('#scheme-kind')).toHaveText('CONCEPT GRAPH · A–Z');
  const rows = page.locator('#tree .tree-item');
  await expect(rows.locator('.tree-pick')).toHaveText(['Art', 'Craft', 'Trust', 'Work']);
  await expect(page.locator('#tree [data-unplaced-group], #tree [data-multi-parent], #tree [data-shared-reference]')).toHaveCount(0);
  for (const row of await rows.all()) await expect(row).toHaveAttribute('style', /padding-left:7px/);
  // The shape of the data is still reported, and related terms still open beside each concept.
  await expect(page.locator('#scheme-shape')).toHaveText('⑃ polyhierarchy · 1 multi-parent · ⁂ 1 link · ○ 1 unplaced');
  await page.locator('#tree').getByRole('button', { name: 'Show 1 related or opposite term of Trust' }).click();
  await expect(page.locator('#tree .link-item .tree-pick')).toHaveText('Work');
  expect(errors).toEqual([]);
});

test('the outline setting is offered only for concept graphs', async ({ page, request }) => {
  await request.post('/api/schemes', { data: { id: 'go-poly', label: 'Poly', hierarchy: 'poly' } });
  await request.post('/api/terms', { data: { scheme: 'go-poly', label: 'Only', status: 'active' } });
  await page.goto('/?scheme=go-poly');
  await page.getByRole('button', { name: 'Scheme settings' }).click();
  await expect(page.locator('#scheme-outline-field')).toBeHidden();
  await page.locator('#save-scheme').click();
  await expect(page.locator('#scheme-error')).toHaveText('');
});

test('a pair both related and opposite shows both links, and a shared occurrence opens its links too', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await request.post('/api/schemes', { data: { id: 'go-both', label: 'Both', hierarchy: 'poly' } });
  const add = async (data: object) => (await (await request.post('/api/terms', { data: { scheme: 'go-both', status: 'active', ...data } })).json()).term;
  const work = await add({ label: 'Work' });
  const art = await add({ label: 'Art' });
  const rival = await add({ label: 'Rival' });
  await add({ label: 'Craft', broader: [work.id, art.id], relations: [{ type: 'related', target: rival.id }, { type: 'opposite', target: rival.id }] });

  await page.goto('/?scheme=go-both');
  await expect(page.locator('#scheme-shape')).toHaveText('⑃ polyhierarchy · 1 multi-parent · ⁂ 2 links');
  await expect(page.locator('#scheme-shape')).toHaveAttribute('title', /1 related pair, 1 opposite pair/);
  // Craft under Art (its first place) and under Work (shared): both offer its two links.
  const craft = page.locator('#tree .tree-item:not(.link-item)').filter({ has: page.getByRole('button', { name: 'Craft', exact: true }) });
  await expect(craft).toHaveCount(2);
  await expect(craft.nth(1).locator('[data-shared-reference]')).toHaveCount(1);
  await craft.nth(1).getByRole('button', { name: 'Show 2 related or opposite terms of Craft' }).click();
  const links = page.locator('#tree .link-item');
  await expect(links).toHaveCount(4);
  await expect(links.locator('.tree-glyph')).toHaveText(['↔', '≠', '↔', '≠']);
  await expect(links.locator('.tree-pick')).toHaveText(['Rival', 'Rival', 'Rival', 'Rival']);
  await expect(links.nth(2)).toHaveAttribute('style', /padding-left:39px/); // under the shared occurrence, inside Work
  expect(errors).toEqual([]);
});
