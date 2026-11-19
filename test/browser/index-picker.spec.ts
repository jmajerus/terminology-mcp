import { test, expect } from '@playwright/test';

test('an index term leads the term pickers to the specific terms it maps as narrower', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const [id, label] of [['ix-index', 'Index'], ['ix-df', 'Frameworks'], ['ix-essays', 'Essays']])
    await request.post('/api/schemes', { data: { id, label, hierarchy: 'graph' } });
  const add = async (data: object) => (await (await request.post('/api/terms', { data: { status: 'active', ...data } })).json()).term;
  const iri = (term: { id: string }) => `urn:terminology-mcp:term:${term.id}`;
  const mockery = await add({ scheme: 'ix-df', label: 'Celebration or Mockery of Human Death' });
  const dignity = await add({ scheme: 'ix-df', label: 'Conditional Dignity', scopeNote: 'Dignity is earned, not intrinsic.' });
  await add({ scheme: 'ix-df', label: 'Moralized Obedience', scopeNote: 'Obedience becomes a moral virtue.' });
  const target = await add({ scheme: 'ix-df', label: 'Normative Drift' });
  const depravity = await add({ scheme: 'ix-index', label: 'depravity', altLabels: ['wickedness'],
    links: [{ uri: iri(mockery), match: 'narrowMatch' }, { uri: iri(dignity), match: 'narrowMatch' }] });
  // The reverse form: a specific term that names the index term as broader.
  await add({ scheme: 'ix-df', label: 'Inversion of Moral Orientation', links: [{ uri: iri(depravity), match: 'broadMatch' }] });
  const essay = await add({ scheme: 'ix-essays', label: 'On war' });

  // Find… beside the Relations dropdown. Opposite stays within the scheme, so "depravity" is a heading, not a choice.
  await page.goto(`/?scheme=ix-df#${target.id}`);
  await page.locator('#relation-type').selectOption('opposite');
  await page.getByRole('button', { name: 'Find a related term by search' }).click();
  const dialog = page.locator('#term-match-dialog'), results = dialog.locator('#term-match-results');
  await expect(dialog.locator('#term-match-title')).toHaveText('Find a related term');
  await expect(dialog.locator('#term-match-type')).toBeHidden();
  await dialog.getByLabel('Term label').fill('wicked');
  await expect(results.locator('.term-hub')).toContainText('depravity');
  await expect(results.locator('.term-hub')).toContainText('↘ 3 narrower');
  await expect(results.locator('.wordnet-result.under .wordnet-words')).toHaveText([
    /Celebration or Mockery of Human Death/, /Conditional Dignity/, /Inversion of Moral Orientation/]);
  await expect(results.locator('.wordnet-result.under').first()).toContainText('narrower than depravity');
  await results.locator('.wordnet-result.under').first().click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#relation-target')).toHaveValue(mockery.id);
  await expect(page.locator('#relation-target')).toBeFocused();
  await page.locator('#add-relation').click();
  await expect(page.locator('#relations')).toContainText('Celebration or Mockery of Human Death');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('#save-state')).toHaveText(/Saved at/);

  // Scope notes are searched too, after labels.
  await page.getByRole('button', { name: 'Find a related term by search' }).click();
  await dialog.getByLabel('Term label').fill('obedience');
  await expect(results.locator('.wordnet-result .wordnet-words')).toHaveText([/Moralized Obedience/]);
  await dialog.getByLabel('Term label').fill('intrinsic');
  await expect(results.locator('.wordnet-result .wordnet-words')).toHaveText([/Conditional Dignity/]);
  await dialog.getByRole('button', { name: 'Close' }).click();

  // Find… beside Broader terms in a new concept: a multiple select keeps what it had and adds the choice.
  await page.getByRole('button', { name: '+ Concept' }).click();
  await page.getByRole('button', { name: 'Find a broader term by search' }).click();
  await dialog.getByLabel('Term label').fill('depravity');
  await results.getByRole('button', { name: /Conditional Dignity/ }).click();
  const broader = page.locator('#create-fields select[name=broader]');
  await expect(broader).toHaveValues([dignity.id]);
  await page.getByRole('button', { name: 'Find a broader term by search' }).click();
  await dialog.getByLabel('Term label').fill('normative');
  await results.getByRole('button', { name: /Normative Drift/ }).click();
  await expect(broader).toHaveValues([dignity.id, target.id]);
  await page.locator('#create-dialog').getByRole('button', { name: 'Cancel' }).click();

  // + Term from another scheme: the index term and the terms under it can all be linked.
  await page.goto(`/?scheme=ix-essays#${essay.id}`);
  await page.getByRole('button', { name: '+ Term', exact: true }).click();
  await expect(dialog.locator('#term-match-title')).toHaveText('Match a term in another scheme');
  await expect(dialog.locator('#term-match-type')).toBeVisible();
  await dialog.getByLabel('Term label').fill('depravity');
  await expect(results.locator('[data-term-match]')).toHaveCount(4);
  await expect(results.locator('[data-term-match]').first()).toContainText('↘ 3 narrower');
  await dialog.getByLabel('Match type').selectOption('relatedMatch');
  await results.getByRole('button', { name: /Inversion of Moral Orientation/ }).click();
  const row = page.locator('.link-row').nth(0);
  await expect(row.getByLabel('Reference match')).toHaveValue('relatedMatch');
  await expect(row.locator('.link-gloss')).toHaveText('Inversion of Moral Orientation · ix-df');
  expect(errors).toEqual([]);
});
