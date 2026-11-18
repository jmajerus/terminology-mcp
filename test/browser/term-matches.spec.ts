import { test, expect } from '@playwright/test';

test('+ Term links a term to one in another scheme, names it, and shows the match on the other side', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const [id, label] of [['tm-mine', 'Mine'], ['tm-theirs', 'Theirs']])
    await request.post('/api/schemes', { data: { id, label, hierarchy: 'tree' } });
  const add = async (data: object) => (await (await request.post('/api/terms', { data })).json()).term;
  const mine = await add({ scheme: 'tm-mine', label: 'Depression', status: 'active' });
  const imported = await add({ scheme: 'tm-theirs', label: 'Depression', status: 'active', sourceUri: 'https://example.org/mh#Depression',
    scopeNote: 'A mood disorder.' });
  const native = await add({ scheme: 'tm-theirs', label: 'Depression, major', status: 'active', altLabels: ['Low mood'] });
  await add({ scheme: 'tm-mine', label: 'Depressed', status: 'active' }); // same scheme: never offered

  await page.goto(`/#${mine.id}`);
  await page.locator('#scheme').selectOption('tm-mine');
  await page.locator('#tree').getByRole('button', { name: 'Depression', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Depression', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '+ Term', exact: true }).click();
  const dialog = page.locator('#term-match-dialog');
  await expect(dialog.getByLabel('Term label')).toHaveValue('Depression');
  await expect(dialog.getByLabel('Match type')).toHaveValue('exactMatch');
  const results = dialog.locator('.wordnet-result');
  // The exact label first, then labels that start with it; nothing from this scheme.
  await expect(results).toHaveCount(2);
  await expect(results.nth(0)).toContainText('Depression');
  await expect(results.nth(0)).toContainText('A mood disorder.');
  await expect(results.nth(1)).toContainText('Depression, major');
  await dialog.getByLabel('Term label').fill('low mood');
  await expect(results).toHaveCount(1);
  await dialog.getByLabel('Term label').fill('Depression');
  await results.nth(0).click();
  await expect(dialog).toBeHidden();

  const row = page.locator('.link-row').nth(0);
  await expect(row.getByLabel('Reference URL')).toHaveValue('https://example.org/mh#Depression');
  await expect(row.getByLabel('Reference match')).toHaveValue('exactMatch');
  await expect(row.locator('.link-gloss')).toHaveText('Depression · tm-theirs');

  // A native term (no source IRI) is linked by its URN; the one already linked can't be picked again.
  await page.getByRole('button', { name: '+ Term', exact: true }).click();
  await dialog.getByLabel('Match type').selectOption('closeMatch');
  await expect(results.nth(0)).toBeDisabled();
  await expect(results.nth(0)).toContainText('already linked');
  await results.nth(1).click();
  const second = page.locator('.link-row').nth(1);
  await expect(second.getByLabel('Reference URL')).toHaveValue(`urn:terminology-mcp:term:${native.id}`);
  await expect(second.getByLabel('Reference match')).toHaveValue('closeMatch');
  await expect(second.locator('.link-gloss')).toHaveText('Depression, major · tm-theirs');

  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('#save-state')).toHaveText(/Saved at/);
  const saved = (await (await request.get(`/api/terms/${mine.id}`)).json()).term;
  expect(saved.links).toEqual([{ uri: 'https://example.org/mh#Depression', match: 'exactMatch' },
    { uri: `urn:terminology-mcp:term:${native.id}`, match: 'closeMatch' }]);

  // The gloss jumps to the matched term, which lists the match as incoming.
  await page.locator('.link-row').nth(0).locator('.link-gloss').getByRole('button', { name: 'Depression' }).click();
  await expect(page.locator('#scheme')).toHaveValue('tm-theirs');
  await expect(page.locator('#incoming-links')).toContainText('exactMatch');
  await expect(page.locator('#incoming-links')).toContainText('Depression · tm-mine');
  await expect(page.locator('#incoming-links')).toContainText('matched from');
  expect(new URL(page.url()).hash).toBe(`#${imported.id}`);
  expect(errors).toEqual([]);
});
