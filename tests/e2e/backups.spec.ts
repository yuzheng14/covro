import { openSidebarSettings, selectInterfaceLocale } from './helpers';
import { readFileSync } from 'node:fs';
import { supportedLocales } from '../../src/web/i18n/locales';
import { verifyDatabaseContract } from '../../scripts/verify-database-contract';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/server/config';
import { startGateway } from '../../src/server/main';
import type { BackupManager } from '../../src/backups/manager';
import { DomainCodex } from '../integration/domain-helpers';

let root: string, config: string, origin: string;
let runtime: Awaited<ReturnType<typeof startGateway>>;
let codex: DomainCodex;
const dialog = (page: Page) => page.locator('.backup-dialog');
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'covro-backup-browser-'));
  config = join(root, 'config.json');
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  await new Promise<void>((done) => probe.close(() => done()));
  origin = `http://127.0.0.1:${address.port}`;
  await writeFile(
    config,
    JSON.stringify({
      port: address.port,
      publicOrigin: [origin],
      dataDir: './data',
      projects: [{ id: 'project', name: 'Backup verification', path: root }],
    }),
  );
  codex = new DomainCodex();
  runtime = await startGateway(await loadConfig({ configPath: config, development: false }), {
    codex,
    staticDir: resolve('dist/web'),
  });
  (runtime.backups as BackupManager).store.options.directory = join(root, 'backups');
});
test.afterEach(async () => {
  await runtime?.close();
  await rm(root, { recursive: true, force: true });
});
async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled', fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
  if (process.env.COVRO_SCREENSHOTS) {
    await mkdir(process.env.COVRO_SCREENSHOTS, { recursive: true });
    await page.screenshot({
      path: join(process.env.COVRO_SCREENSHOTS, `${name}.png`),
      animations: 'disabled',
      fullPage: true,
    });
  }
}
for (const locale of supportedLocales) {
  const catalog = (namespace: string): Record<string, string> =>
    JSON.parse(readFileSync(`src/web/i18n/locales/${locale}/${namespace}.json`, 'utf8'));
  const messages = catalog('backups');
  const tr = (key: string) => messages[key]!;
  for (const viewport of [
    { name: 'desktop', width: 1440, height: 1100 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    test(`${locale} ${viewport.name}: actual manual backup waits, succeeds, verifies and reports invalid configuration`, async ({
      page,
    }, info) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((value) => localStorage.setItem('covro.locale', value), locale);
      await page.goto(origin);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      if (viewport.name === 'mobile')
        await page
          .getByRole('button', {
            name: catalog('workspace').open_projects_and_sessions,
          })
          .click();
      await openSidebarSettings(page, 'service');
      await expect(page.getByRole('button', { name: tr('title'), exact: true })).toBeVisible();
      const footer = page.locator('.sidebar-footer');
      expect(await footer.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await capture(page, info, `backup-${locale}-${viewport.name}-entry`);
      await page.getByRole('button', { name: tr('title'), exact: true }).click();
      await expect(dialog(page).getByText(tr('empty'))).toBeVisible();
      await capture(page, info, `backup-${locale}-${viewport.name}-empty`);
      const created = await runtime.service.createThread('project', {
        clientOperationId: randomUUID(),
      });
      const threadId = (created.result as { threadId: string }).threadId;
      const turn = await runtime.service.startTurn(threadId, {
        clientOperationId: randomUUID(),
        text: 'A running task',
      });
      await dialog(page)
        .getByRole('button', { name: tr('create'), exact: true })
        .click();
      const progress = dialog(page).locator('.backup-progress');
      await expect(progress).toContainText(tr('phase_waiting'));
      await expect(
        dialog(page).getByRole('button', { name: tr('create'), exact: true }),
      ).toBeDisabled();
      await capture(page, info, `backup-${locale}-${viewport.name}-waiting`);
      if (locale === 'zh-Hans' && viewport.name === 'desktop') {
        const before = await (runtime.backups as BackupManager).status();
        const other = await page.context().newPage();
        // A genuine storage event from another tab changes an open dialog without resubmitting.
        await other.goto(origin);
        await selectInterfaceLocale(other, 'en');
        await expect(
          dialog(page).getByRole('heading', { name: 'Backups and recovery' }),
        ).toBeVisible();
        await expect(progress).toContainText('Waiting for a safe point');
        const after = await (runtime.backups as BackupManager).status();
        expect(after.active?.id).toBe(before.active?.id);
        expect(after.records).toHaveLength(before.records.length);
        await selectInterfaceLocale(other, locale);
        await expect(progress).toContainText(tr('phase_waiting'));
        await other.close();
      }
      codex.complete(threadId, turn.execution!.turnId!);
      await expect(dialog(page).locator('.backup-record[data-phase="succeeded"]')).toHaveCount(1);
      await expect(progress).toHaveCount(0);
      const record = dialog(page).locator('.backup-record[data-phase="succeeded"]');
      const date = await record.locator('time').getAttribute('datetime');
      expect(date).toBeTruthy();
      await expect(record.locator('time')).toHaveText(
        new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }).format(
          new Date(date!),
        ),
      );
      await expect(dialog(page)).toContainText(`Schema ${verifyDatabaseContract().schemaVersion}`);
      await capture(page, info, `backup-${locale}-${viewport.name}-success`);
      await dialog(page)
        .getByRole('button', { name: tr('verify'), exact: true })
        .click();
      await expect(dialog(page)).toContainText(tr('verified'));
      await dialog(page).getByText(tr('recovery'), { exact: true }).click();
      await expect(dialog(page).locator('.backup-restore code')).toContainText(
        'covro backup restore',
      );
      await writeFile(config, 'invalid configuration');
      await dialog(page)
        .getByRole('button', { name: tr('create'), exact: true })
        .click();
      await expect(dialog(page).locator('.backup-record[data-phase="failed"]')).toHaveCount(1);
      const failed = dialog(page).locator('.backup-record[data-phase="failed"]');
      await expect(failed.getByRole('alert')).toHaveText(tr('description_failed'));
      await failed.locator('.backup-technical-details summary').click();
      await expect(failed.locator('pre')).toContainText('服务配置无效');
      await failed.locator('.backup-technical-details summary').click();
      await expect(dialog(page).locator('.backup-record[data-phase="succeeded"]')).toHaveCount(1);
      await page.locator('.settings-heading button').focus();
      await expect(page.locator('.settings-heading')).toBeInViewport();
      await capture(page, info, `backup-${locale}-${viewport.name}-failure`);
      expect(await dialog(page).evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
        true,
      );
      await page.locator('.settings-heading button').click();
      await expect(dialog(page)).toHaveCount(0);
    });
  }
}
