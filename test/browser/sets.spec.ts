import { test, expect } from '@playwright/test';

async function seed(request: import('@playwright/test').APIRequestContext, suffix: string) {
  await request.post('/api/schemes', { data: { id: suffix, label: 'Set test ' + suffix, hierarchy: 'tree' } });
  const a = (await (await request.post('/api/terms', { data: { scheme: suffix, label: 'Alpha', status: 'active' } })).json()).term;
  const b = (await (await request.post('/api/terms', { data: { scheme: suffix, label: 'Beta', status: 'active' } })).json()).term;
  return { a, b };
}

test('create, preview, reorder, save, reload, nested membership and delete a collection', async ({ page, request }) => {
  const { a, b } = await seed(request, 'set-editor');
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/sets'); await page.locator('#set-scheme').selectOption('set-editor');
  await page.getByRole('button', { name: '+ Set', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Reading order');
  await page.getByLabel('Slug', { exact: true }).fill('reading-order');
  await page.getByText('Ordered collection', { exact: true }).check();
  await page.locator('#member-picker').selectOption(b.id); await page.getByRole('button', { name: 'Add member' }).click();
  await page.locator('#member-picker').selectOption(a.id); await page.getByRole('button', { name: 'Add member' }).click();
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.locator('#expansion-version')).toContainText('2 terms');
  await expect(page.locator('#set-expansion .change-card').first()).toContainText('Beta');
  await page.getByRole('button', { name: 'Move Alpha up' }).click();
  await expect(page.getByRole('button', { name: 'Save set', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await page.getByRole('button', { name: 'Save set', exact: true }).click();
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await expect(page.locator('#set-expansion .change-card').first()).toContainText('Alpha');
  const savedId = new URL(page.url()).hash.slice(1);
  await page.reload(); await expect(page.locator('#set-title')).toHaveText('Reading order');
  await page.getByRole('button', { name: '+ Set', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Theme'); await page.getByLabel('Slug', { exact: true }).fill('theme');
  await page.locator('#member-picker').selectOption(savedId); await page.getByRole('button', { name: 'Add member' }).click();
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.locator('#expansion-version')).toContainText('2 terms');
  await page.getByRole('button', { name: 'Save set', exact: true }).click(); await expect(page.locator('#save-state')).toHaveText('Saved');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Delete set', exact: true }).click();
  await expect(page.locator('#set-title')).toHaveText('Reading order');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('a workspace change rejects stale set saves and discard reloads the current version', async ({ page, request }) => {
  await seed(request, 'set-stale');
  await page.goto('/sets'); await page.locator('#set-scheme').selectOption('set-stale');
  await page.getByRole('button', { name: '+ Set', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Stale'); await page.getByLabel('Slug', { exact: true }).fill('stale');
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.getByRole('button', { name: 'Save set', exact: true })).toBeEnabled();
  await request.post('/api/terms', { data: { scheme: 'set-stale', label: 'Concurrent edit' } });
  await page.getByRole('button', { name: 'Save set', exact: true }).click();
  await expect(page.locator('#set-error')).toContainText('workspace changed');
  await expect(page.getByRole('button', { name: 'Save set', exact: true })).toBeDisabled();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('');
});

test('late set previews cannot reenable saving after the draft changes', async ({ page, request }) => {
  await seed(request, 'set-race');
  await page.goto('/sets'); await page.locator('#set-scheme').selectOption('set-race');
  await page.getByRole('button', { name: '+ Set', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('First'); await page.getByLabel('Slug', { exact: true }).fill('first');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/sets/preview', async route => { const response = await route.fetch(); await pending; await route.fulfill({ response }); });
  const started = page.waitForRequest('**/api/sets/preview');
  await page.getByRole('button', { name: 'Preview changes' }).click(); await started;
  await page.getByLabel('Name', { exact: true }).fill('Second'); release();
  await expect(page.getByRole('button', { name: 'Preview changes' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save set', exact: true })).toBeDisabled();
});

test('recipe editor previews descendants and exclusions and persists its definition', async ({ page, request }) => {
  const { a, b } = await seed(request, 'set-recipes');
  const version = (await (await request.get('/api/state')).json()).version;
  await request.post(`/api/terms/${b.id}/operations/apply`, { data: { kind: 'move', broader: [a.id], expectedVersion: version } });
  await page.goto('/sets'); await page.locator('#set-scheme').selectOption('set-recipes');
  await page.getByRole('button', { name: '+ Set', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Live recipe'); await page.getByLabel('Slug', { exact: true }).fill('live-recipe');
  await page.getByRole('combobox', { name: 'Definition', exact: true }).selectOption('recipe');
  await page.getByRole('listbox', { name: /^Include descendants of/ }).selectOption(a.id);
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.locator('#set-expansion')).toContainText('Beta');
  await page.getByRole('button', { name: 'Save set', exact: true }).click(); await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.reload(); await expect(page.getByRole('combobox', { name: 'Definition', exact: true })).toHaveValue('recipe');
  await page.getByRole('listbox', { name: 'Exclude concepts', exact: true }).selectOption(b.id);
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.locator('#expansion-version')).toContainText('0 terms');
  await expect(page.locator('#expansion-version')).toContainText('−1');
  await page.getByRole('button', { name: '+ Related neighbourhood' }).click();
  await page.getByRole('combobox', { name: 'Around concept', exact: true }).selectOption(a.id);
  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.locator('#set-expansion')).toContainText('Alpha');
});

test('Import SKOS from concept sets opens the importer directly', async ({ page }) => {
  await page.goto('/sets');
  await page.getByRole('link', { name: 'Import SKOS', exact: true }).click();
  const dialog = page.locator('#import-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Import a SKOS scheme', exact: true })).toBeVisible();
  await expect(page.locator('#import-format')).toHaveValue('turtle');
  await expect(page.locator('#import-file')).toBeVisible();
  await page.locator('#import-format').selectOption('sparql');
  await expect(page.locator('#import-endpoint')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});
