import { test, expect } from '@playwright/test';

test('scheme name and description save, reload and clear through settings', async ({ page, request }) => {
  const response = await request.post('/api/schemes', {
    data: { id: 'metadata-ui', label: 'Metadata example', hierarchy: 'tree' },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto('/');
  await page.locator('#scheme').selectOption('metadata-ui');
  await page.getByRole('button', { name: 'Scheme settings', exact: true }).click();
  const dialog = page.locator('#scheme-dialog');
  await dialog.getByLabel('Scheme name').fill('Renamed scheme');
  await dialog.getByLabel('Description', { exact: true }).fill('A description with <markup> & punctuation.');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#scheme option:checked')).toHaveText('Renamed scheme');
  await page.reload();
  await page.locator('#scheme').selectOption('metadata-ui');
  await page.getByRole('button', { name: 'Scheme settings', exact: true }).click();
  await expect(dialog.getByLabel('Scheme name')).toHaveValue('Renamed scheme');
  await expect(dialog.getByLabel('Description', { exact: true })).toHaveValue('A description with <markup> & punctuation.');
  await dialog.getByLabel('Description', { exact: true }).fill('');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Scheme settings', exact: true }).click();
  await expect(dialog.getByLabel('Description', { exact: true })).toHaveValue('');
});
