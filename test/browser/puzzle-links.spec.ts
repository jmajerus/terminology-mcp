import { test, expect, type Page } from '@playwright/test';

const P = 'urn:concept-clusters:puzzle:moral-inversion', CLUSTER = `${P}#inverting-moral-value`, GONE = `${P}#gone`;
const URL_ = 'https://cc.example/?puzzle=moral-inversion';
const puzzle = { id: 'moral-inversion', uri: P, title: 'Moral disengagement and moral inversion', url: URL_ };
const cluster = { uri: CLUSTER, found: true, kind: 'cluster', label: 'Inverting moral value', puzzle,
  text: 'Moral inversion treats cruelty or domination as admirable.', terms: ['cruelty as strength', 'empathy as weakness'] };
const term = { uri: `${P}#term/cruelty-as-strength`, found: true, kind: 'term', label: 'cruelty as strength', puzzle,
  text: 'Treats willingness to inflict suffering as resolve.', cluster: { uri: CLUSTER, label: 'Inverting moral value' } };

// Concept Clusters' graph server isn't reachable from tests, so the browser's requests are answered here.
async function fakeConceptClusters(page: Page, searches: string[] = []) {
  await page.route('**/api/concept-clusters?*', route => {
    const uri = new URL(route.request().url()).searchParams.get('uri');
    return route.fulfill({ json: { item: uri === CLUSTER ? cluster : uri === GONE ? { uri, found: false } : null } });
  });
  await page.route('**/api/concept-clusters/search?*', route => {
    const q = new URL(route.request().url()).searchParams.get('q')!;
    searches.push(q);
    return route.fulfill({ json: { results: q === 'down' ? null : q.toLowerCase().includes('moral') ? [cluster, term] : [] } });
  });
}

test('a Concept Clusters link names its item and links to the puzzle; one no longer published is flagged', async ({ page, request }) => {
  await request.post('/api/schemes', { data: { id: 'cc-ui', label: 'Frameworks', hierarchy: 'graph' } });
  const { term: saved } = await (await request.post('/api/terms', { data: { scheme: 'cc-ui', label: 'Inversion', links: [
    { uri: CLUSTER, match: 'closeMatch' }, { uri: GONE, match: 'relatedMatch' }] } })).json();
  await fakeConceptClusters(page);
  await page.goto(`/?scheme=cc-ui#${saved.id}`);
  const rows = page.locator('.link-row'), gloss = (i: number) => rows.nth(i).locator('.link-gloss');
  await expect(gloss(0)).toHaveText('Cluster “Inverting moral value” in Moral disengagement and moral inversion ↗: Moral inversion treats cruelty or domination as admirable.');
  const link = gloss(0).getByRole('link', { name: 'Moral disengagement and moral inversion ↗' });
  await expect(link).toHaveAttribute('href', URL_);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(gloss(1)).toHaveText('Concept Clusters doesn\'t publish this puzzle or item, or no longer does.');
  await expect(gloss(1)).toHaveClass(/form-error/);
});

test('+ Puzzle searches from the term label, adds the chosen item with the chosen match, and marks what is already linked', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await request.post('/api/schemes', { data: { id: 'cc-pick', label: 'Picker', hierarchy: 'graph' } });
  const { term: saved } = await (await request.post('/api/terms', { data: { scheme: 'cc-pick', label: 'Inversion of Moral Orientation' } })).json();
  const searches: string[] = [];
  await fakeConceptClusters(page, searches);
  await page.goto(`/?scheme=cc-pick#${saved.id}`);
  await page.getByRole('button', { name: '+ Puzzle', exact: true }).click();
  const dialog = page.locator('#puzzle-dialog'), results = dialog.locator('.wordnet-result');
  await expect(dialog.locator('#puzzle-text')).toHaveValue('Inversion of Moral Orientation');
  await expect(results).toHaveCount(2);
  expect(searches).toEqual(['Inversion of Moral Orientation']);
  await expect(dialog.locator('#puzzle-status')).toHaveText('2 matches for “Inversion of Moral Orientation”, closest first');
  await expect(results.nth(0)).toContainText('Inverting moral value');
  await expect(results.nth(0)).toContainText('Cluster');
  await expect(results.nth(0)).toContainText('Moral disengagement and moral inversion');
  await expect(results.nth(1)).toContainText('in Inverting moral value');
  await dialog.locator('#puzzle-match-type').selectOption('relatedMatch');
  await results.nth(0).click();
  await expect(dialog).toBeHidden();
  const row = page.locator('.link-row').nth(0);
  await expect(row.getByLabel('Reference URL')).toHaveValue(CLUSTER);
  await expect(row.getByLabel('Reference match')).toHaveValue('relatedMatch');
  await expect(row.locator('.link-gloss')).toContainText('Cluster “Inverting moral value”');

  await page.getByRole('button', { name: '+ Puzzle', exact: true }).click();
  await expect(results.nth(0)).toBeDisabled();
  await expect(results.nth(0)).toContainText('already linked');
  await dialog.locator('#puzzle-text').fill('down');
  await dialog.getByRole('button', { name: 'Search' }).click();
  await expect(dialog.locator('#puzzle-status')).toContainText('unavailable');
  await dialog.locator('#puzzle-text').fill('nothing here');
  await dialog.getByRole('button', { name: 'Search' }).click();
  await expect(dialog.locator('#puzzle-status')).toContainText('No cluster, term or bridge');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('#save-state')).toHaveText(/Saved at/);
  const stored = await (await request.get('/api/state')).json();
  expect(stored.terms.find((t: { id: string }) => t.id === saved.id).links).toEqual([{ uri: CLUSTER, match: 'relatedMatch' }]);
  expect(errors).toEqual([]);
});
