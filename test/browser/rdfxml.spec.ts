import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

test('an OWL file in RDF/XML imports as a scheme, with what was left out listed for review', async ({ page, request }) => {
  await page.goto('/?import=turtle');
  const dialog = page.locator('#import-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#import-file-field .field-label')).toHaveText('RDF file');
  await page.locator('#import-file').setInputFiles(fileURLToPath(new URL('../fixtures/feelings.owl', import.meta.url)));
  await dialog.getByRole('button', { name: 'Find schemes', exact: true }).click();
  await expect(page.locator('#import-source-scheme')).toBeEnabled();
  await expect(page.locator('#import-source-scheme')).toHaveValue('https://example.org/feelings');
  await page.locator('#import-id').fill('feelings-ui');
  await dialog.getByRole('button', { name: 'Preview import', exact: true }).click();
  await expect(page.locator('#import-preview')).toContainText('Feelings · 3 terms');
  await expect(page.locator('#import-preview')).toContainText('Read as an OWL class hierarchy: 3 classes became concepts');
  await expect(page.locator('#import-preview')).toContainText('1 class restriction (anonymous superclasses) omitted.');
  await dialog.getByRole('button', { name: 'Import scheme', exact: true }).click();
  await expect(page.locator('#scheme')).toHaveValue('feelings-ui');
  const state = await (await request.get('/api/state')).json();
  const terms = state.terms.filter((t: { scheme: string }) => t.scheme === 'feelings-ui');
  const anger = terms.find((t: { label: string }) => t.label === 'anger');
  expect(terms.find((t: { id: string }) => t.id === anger.broader[0]).label).toBe('feeling');
});
