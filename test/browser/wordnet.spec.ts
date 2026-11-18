import { test, expect, type Page } from '@playwright/test';

const ID = 'https://en-word.net/id/';
const ANGER = ID + 'oewn-07531593-n', UNKNOWN = ID + 'oewn-99999999-n', SLOW = ID + 'oewn-00000001-n';

// The WordNet server isn't reachable from tests, so the browser's /api/wordnet requests are answered here.
// SLOW answers after a second (slowDone resolves then; it's wrapped so awaiting the setup doesn't wait for it), to check that a late answer for an old URL never lands on the row.
async function fakeWordnet(page: Page) {
  let slowAnswered!: () => void;
  const slowDone = new Promise<void>(resolve => { slowAnswered = resolve; });
  await page.route('**/api/wordnet?*', async route => {
    const uri = new URL(route.request().url()).searchParams.get('uri');
    const synset = uri === ANGER ? { uri, found: true, words: ['anger', 'choler', 'ire'], pos: 'noun', definition: 'a strong emotion' }
      : uri === SLOW ? { uri, found: true, words: ['stale'], pos: 'noun', definition: 'an answer for an old URL' }
      : uri === UNKNOWN ? { uri, found: false } : null;
    if (uri === SLOW) await new Promise(resolve => setTimeout(resolve, 1000));
    await route.fulfill({ json: { synset } });
    if (uri === SLOW) slowAnswered();
  });
  return { slowDone };
}

test('WordNet links show their synset gloss, flag unknown ids, and ignore late answers for old URLs', async ({ page, request }) => {
  await request.post('/api/schemes', { data: { id: 'wordnet-ui', label: 'WordNet', hierarchy: 'tree' } });
  const { term } = await (await request.post('/api/terms', { data: { scheme: 'wordnet-ui', label: 'Anger', links: [
    { uri: ANGER, match: 'closeMatch' }, { uri: UNKNOWN, match: 'closeMatch' }, { uri: 'https://example.org/anger', match: 'relatedMatch' }] } })).json();
  let { slowDone } = await fakeWordnet(page);
  await page.goto(`/#${term.id}`);
  await page.locator('#scheme').selectOption('wordnet-ui');
  const rows = page.locator('.link-row'), gloss = (i: number) => rows.nth(i).locator('.link-gloss');
  await expect(gloss(0)).toHaveText('anger, choler, ire (noun): a strong emotion');
  await expect(gloss(1)).toHaveText('Open English WordNet has no synset with this id.');
  await expect(gloss(1)).toHaveClass(/form-error/);
  await expect(gloss(2)).toBeHidden();
  const open = (i: number) => rows.nth(i).getByRole('link', { name: 'Open reference in a new tab' });
  await expect(open(0)).toHaveAttribute('href', ANGER);
  await expect(open(0)).toHaveAttribute('target', '_blank');
  await expect(open(2)).toHaveAttribute('href', 'https://example.org/anger');

  // Changed to a slow id and then away from WordNet before it answers: the row stays without a gloss.
  const url = rows.nth(0).getByLabel('Reference URL');
  await url.fill(SLOW); await url.press('Tab');
  await url.fill('https://example.org/elsewhere'); await url.press('Tab');
  await expect(open(0)).toHaveAttribute('href', 'https://example.org/elsewhere');
  await url.fill('javascript:alert(1)');
  await expect(rows.nth(0).locator('.link-open')).toBeHidden();
  await url.fill('https://example.org/elsewhere'); await url.press('Tab');
  await expect(gloss(0)).toBeHidden();
  await slowDone;
  await expect(gloss(0)).toBeHidden();

  // Changed to a slow id and then to a fast one: the fast one's gloss stays after the slow answer arrives.
  ({ slowDone } = await fakeWordnet(page));
  await url.fill(SLOW); await url.press('Tab');
  await url.fill(ANGER); await url.press('Tab');
  await expect(gloss(0)).toHaveText('anger, choler, ire (noun): a strong emotion');
  await slowDone;
  await expect(gloss(0)).toHaveText('anger, choler, ire (noun): a strong emotion');

  // The gloss is display only: saving stores just the links.
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('#save-state')).toHaveText(/Saved at/);
  const saved = (await (await request.get(`/api/terms/${term.id}`)).json()).term;
  expect(saved.links.map((link: { uri: string }) => link.uri)).toEqual([ANGER, UNKNOWN, 'https://example.org/anger']);
});

test('the WordNet picker searches by the term label and adds the chosen meaning as a close match', async ({ page, request }) => {
  await request.post('/api/schemes', { data: { id: 'wordnet-pick', label: 'WordNet picker', hierarchy: 'tree' } });
  const { term } = await (await request.post('/api/terms', { data: { scheme: 'wordnet-pick', label: 'Anger',
    links: [{ uri: ANGER, match: 'closeMatch' }] } })).json();
  const STATE = ID + 'oewn-14060021-n';
  const searched: string[] = [];
  await page.route('**/api/wordnet/search?*', async route => {
    const q = new URL(route.request().url()).searchParams.get('q')!;
    searched.push(q);
    const results = q === 'Anger' ? [
      { uri: STATE, found: true, words: ['anger', 'angriness'], pos: 'noun', definition: 'the state of being angry' },
      { uri: ANGER, found: true, words: ['anger', 'choler', 'ire'], pos: 'noun', definition: 'a strong emotion' }]
      : q === 'down' ? null : [];
    await route.fulfill({ json: { results } });
  });
  await page.route('**/api/wordnet?*', route => route.fulfill({ json: { synset: {
    uri: STATE, found: true, words: ['anger', 'angriness'], pos: 'noun', definition: 'the state of being angry' } } }));
  await page.goto(`/#${term.id}`);
  await page.locator('#scheme').selectOption('wordnet-pick');
  await page.getByRole('button', { name: '+ WordNet', exact: true }).click();
  const dialog = page.locator('#wordnet-dialog');
  await expect(dialog.getByLabel('Word or phrase')).toHaveValue('Anger');
  await expect(dialog.locator('#wordnet-status')).toHaveText('2 meanings of “Anger”');
  const results = dialog.locator('.wordnet-result');
  await expect(results.nth(1)).toBeDisabled();
  await expect(results.nth(1)).toContainText('already linked');

  await dialog.getByLabel('Word or phrase').fill('zzz'); await dialog.getByRole('button', { name: 'Search' }).click();
  await expect(dialog.locator('#wordnet-status')).toHaveText('WordNet has no word “zzz”. Try another form, such as the singular.');
  await dialog.getByLabel('Word or phrase').fill('down'); await dialog.getByRole('button', { name: 'Search' }).click();
  await expect(dialog.locator('#wordnet-status')).toContainText('unavailable');
  await dialog.getByLabel('Word or phrase').fill('Anger'); await dialog.getByRole('button', { name: 'Search' }).click();
  await results.nth(0).click();
  await expect(dialog).toBeHidden();

  const row = page.locator('.link-row').nth(1);
  await expect(row.getByLabel('Reference URL')).toHaveValue(STATE);
  await expect(row.getByLabel('Reference match')).toHaveValue('closeMatch');
  await expect(row.locator('.link-gloss')).toHaveText('anger, angriness (noun): the state of being angry');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('#save-state')).toHaveText(/Saved at/);
  const saved = (await (await request.get(`/api/terms/${term.id}`)).json()).term;
  expect(saved.links).toEqual([{ uri: ANGER, match: 'closeMatch' }, { uri: STATE, match: 'closeMatch' }]);
  expect(searched).toEqual(['Anger', 'zzz', 'down', 'Anger']);
});
