import { test, expect, type Page, type Route, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = readFileSync(new URL('../fixtures/research.ttl', import.meta.url), 'utf8');

// Let the server compute a real response, then hold it until the test has
// changed the form/session. Later requests run normally, allowing out-of-order replies.
async function holdNextResponse(page: Page, pattern: string) {
  let markReady!: () => void, releaseResponse!: () => void;
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const released = new Promise<void>(resolve => { releaseResponse = resolve; });
  let claimed = false, heldUrl = '';
  const handler = async (route: Route) => {
    if (claimed) { await route.continue(); return; }
    claimed = true; heldUrl = route.request().url();
    const response = await route.fetch();
    markReady(); await released; await route.fulfill({ response });
  };
  await page.route(pattern, handler);
  return { ready, release: async () => {
    const response = page.waitForResponse(response => response.url() === heldUrl);
    releaseResponse(); await (await response).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.unroute(pattern, handler);
  } };
}
async function terms(request: APIRequestContext, id: string) {
  expect((await request.post('/api/schemes', { data: { id, label: id, hierarchy: 'tree' } })).ok()).toBe(true);
  const add = async (label: string) => {
    const response = await request.post('/api/terms', { data: { scheme: id, label } });
    expect(response.ok()).toBe(true); return (await response.json()).term;
  };
  return { a: await add('A'), b: await add('B') };
}
async function selectFile(page: Page, host: string) {
  await page.locator('#import-file').setInputFiles({ name: 'source.ttl', mimeType: 'text/turtle',
    buffer: Buffer.from(fixture.replaceAll('example.org', host)) });
}
async function openImport(page: Page, host: string, id: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Import SKOS…', exact: true }).click();
  await selectFile(page, host);
  await page.locator('#read-import-source').click();
  await expect(page.locator('#import-source-scheme')).toBeEnabled();
  await page.locator('#import-id').fill(id);
}

test('a layered polyhierarchy renders shared descendants once rather than every root-to-term path', async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json();
  const terms = Array.from({ length: 15 }, (_, level) => ['left', 'right'].map(side => ({
    key: `urn:layer:${level}:${side}`, label: `Level ${level} ${side}`,
    broader: level ? ['left', 'right'].map(parent => `urn:layer:${level - 1}:${parent}`) : [],
  }))).flat();
  const result = await request.post('/api/imports/apply', { data: { expectedVersion: state.version,
    plan: { scheme: { id: 'layered', label: 'Layered', hierarchy: 'poly' }, terms } } });
  expect(result.ok()).toBe(true);
  const { term } = await result.json();
  await page.goto(`/#${term.id}`);
  await expect(page.locator('#tree .tree-item')).toHaveCount(58);
  await expect(page.locator('[data-shared-reference]')).toHaveCount(28);
  await page.locator('#tree .tree-pick').filter({ hasText: /^Level 14 left$/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Level 14 left', exact: true })).toBeVisible();
  await page.locator('#search').fill('Level 14 left');
  await expect(page.locator('#tree .tree-item')).toHaveCount(56);
});

test('editing a structural form prevents a delayed preview from restoring Apply', async ({ page, request }) => {
  const { a, b } = await terms(request, 'review-operation-edit');
  await page.goto(`/#${a.id}`);
  await page.getByRole('button', { name: 'Move…', exact: true }).click();
  await page.locator('#operation-broader').selectOption(b.id);
  const held = await holdNextResponse(page, '**/api/terms/*/operations/preview');
  await page.locator('#preview-operation').click(); await held.ready;
  await page.locator('#operation-reason').fill('Edited while request was pending');
  await held.release();
  await expect(page.locator('#apply-operation')).toBeHidden();
  await expect(page.locator('#operation-preview')).toBeHidden();
  await page.locator('#preview-operation').click();
  await expect(page.locator('#apply-operation')).toBeVisible();
  await page.locator('#apply-operation').click();
  await expect(page.locator('#operation-dialog')).not.toBeVisible();
  const history = await (await request.get(`/api/changes?term=${a.id}`)).json();
  expect(history.changes.at(-1).reason).toBe('Edited while request was pending');
});

test('a delayed preview from a closed structural dialog cannot replace another term’s newer preview', async ({ page, request }) => {
  const { a, b } = await terms(request, 'review-operation-session');
  await page.goto(`/#${a.id}`);
  await page.getByRole('button', { name: 'Move…', exact: true }).click();
  await page.locator('#operation-broader').selectOption(b.id);
  const held = await holdNextResponse(page, '**/api/terms/*/operations/preview');
  await page.locator('#preview-operation').click(); await held.ready;
  await page.locator('#cancel-operation').click();
  await page.locator('#tree .tree-pick').filter({ hasText: /^B$/ }).click();
  await page.getByRole('button', { name: 'Move…', exact: true }).click();
  await page.locator('#operation-broader').selectOption(a.id);
  await page.locator('#preview-operation').click();
  await expect(page.locator('#apply-operation')).toBeVisible();
  await held.release();
  await page.locator('#apply-operation').click();
  await expect(page.locator('#operation-dialog')).not.toBeVisible();
  const resultA = await (await request.get(`/api/terms/${a.id}`)).json();
  const resultB = await (await request.get(`/api/terms/${b.id}`)).json();
  expect(resultA.term.broader).toEqual([]); expect(resultB.term.broader).toEqual([a.id]);
});

test('source discovery from a closed import session cannot replace a newly selected file or its cached payload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Import SKOS…', exact: true }).click();
  await selectFile(page, 'old-source.example');
  const held = await holdNextResponse(page, '**/api/imports/schemes');
  await page.locator('#read-import-source').click(); await held.ready;
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Import SKOS…', exact: true }).click();
  await selectFile(page, 'new-source.example');
  await page.locator('#read-import-source').click();
  await expect(page.locator('#import-source-scheme')).toHaveValue('https://new-source.example/scheme');
  await held.release();
  await expect(page.locator('#import-source-scheme')).toHaveValue('https://new-source.example/scheme');
  await page.locator('#import-id').fill('review-new-source');
  await page.locator('#preview-import').click();
  await expect(page.locator('#apply-import')).toBeVisible();
  await page.locator('#apply-import').click();
  await expect(page.locator('#scheme')).toHaveValue('review-new-source');
  await expect(page.locator('#detail')).toContainText('https://new-source.example/');
});

for (const reopen of [false, true]) {
  test(`import previews are discarded after ${reopen ? 'closing and reopening the dialog' : 'settings change'}`, async ({ page, request }) => {
    const suffix = reopen ? 'session' : 'settings';
    await openImport(page, `preview-${suffix}.example`, `review-${suffix}-old`);
    const held = await holdNextResponse(page, '**/api/imports/preview');
    await page.locator('#preview-import').click(); await held.ready;
    if (reopen) {
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Import SKOS…', exact: true }).click();
      await page.locator('#read-import-source').click();
      await expect(page.locator('#import-source-scheme')).toBeEnabled();
    }
    await page.locator('#import-id').fill(`review-${suffix}-new`);
    await held.release();
    await expect(page.locator('#apply-import')).toBeHidden();
    await expect(page.locator('#import-preview')).toBeHidden();
    await page.locator('#preview-import').click();
    await expect(page.locator('#apply-import')).toBeVisible();
    await page.locator('#apply-import').click();
    await expect(page.locator('#scheme')).toHaveValue(`review-${suffix}-new`);
    const state = await (await request.get('/api/state')).json();
    expect(state.schemes.some((scheme: { id: string }) => scheme.id === `review-${suffix}-old`)).toBe(false);
  });
}
