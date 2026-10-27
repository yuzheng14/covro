import { CODEX_COMPATIBILITY } from '../../src/codex/compatibility.js';
import { assessCodexCompatibility } from '../../src/shared/codex-compatibility.js';
import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReleaseChannel, UpdateStatus } from '../../src/shared/updates';
import {
  chooseSelectOption,
  confirmCompatibility,
  controlRuntime,
  selectInterfaceLocale,
} from './helpers';
const currentVersion = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const [major, minor] = currentVersion.split('.').map(Number);
const nextVersion = `${major}.${minor! + 1}.0`;
const developmentVersion = `${nextVersion}-dev.123`;

async function screenshot(page: Page, name: string) {
  if (!process.env.COVRO_SCREENSHOTS) return;
  await mkdir(process.env.COVRO_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.COVRO_SCREENSHOTS, name), fullPage: true });
}
async function updatesFixture(page: Page) {
  const state: UpdateStatus = {
    version: currentVersion,
    source: 'npm',
    codex: assessCodexCompatibility(CODEX_COMPATIBILITY, CODEX_COMPATIBILITY.recommended),
    supported: true,
    commit: '2a7c9d1e5432',
    settings: { channel: 'stable', automatic: false },
  };
  let candidateMetadata: unknown = CODEX_COMPATIBILITY;
  let candidateRelease: { version: string; channel: ReleaseChannel } | undefined;
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let reload = false;
  await page.route('**/api/updates**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body =
      request.method() === 'POST' ? (request.postDataJSON() as Record<string, unknown>) : {};
    requests.push({ path, body });
    if (path.endsWith('/release-notes')) {
      const version = new URL(request.url()).searchParams.get('version');
      await route.fulfill({
        json: {
          version,
          state: 'missing',
          url: `https://github.com/yuzheng14/covro/releases/tag/v${version}`,
        },
      });
      return;
    }
    if (path.endsWith('/check'))
      state.available = {
        version: body.channel === 'dev' ? developmentVersion : nextVersion,
        channel: body.channel as ReleaseChannel,
        ...candidateRelease,
        requestedChannel: body.channel as ReleaseChannel,
        downgrade: false,
        commit: '8fb09cabcdef',
        codex: assessCodexCompatibility(candidateMetadata, state.codex.version),
      };
    if (path.endsWith('/settings')) state.settings = body as unknown as UpdateStatus['settings'];
    if (path.endsWith('/run'))
      state.run = {
        id: String(body.clientOperationId),
        from: currentVersion,
        target: state.available!.version,
        channel: body.channel as ReleaseChannel,
        sourceChannel: state.available!.channel,
        phase: 'waiting',
        message: '等待执行中的任务、审批或输入结束',
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
    const result =
      reload && request.method() === 'GET' ? { ...state, version: nextVersion } : state;
    reload = false;
    await route.fulfill({ json: result });
  });
  return {
    state,
    requests,
    setCandidate: (metadata: unknown) => {
      candidateMetadata = metadata;
    },
    setRelease: (release: typeof candidateRelease) => {
      candidateRelease = release;
    },
    setCodex: (version: string | null) => {
      state.codex = assessCodexCompatibility(CODEX_COMPATIBILITY, version);
      if (state.available)
        state.available.codex = assessCodexCompatibility(candidateMetadata, version);
    },
    triggerReload: () => {
      reload = true;
    },
  };
}

for (const channel of ['beta', 'dev'] as const) {
  for (const viewport of [
    { name: 'desktop', width: 1440, height: 1100 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    test(`${viewport.name}: ${channel} displays and installs a stable candidate while keeping its subscription`, async ({
      page,
    }) => {
      const fixture = await updatesFixture(page);
      fixture.state.settings.channel = channel;
      fixture.state.settings.automatic = true;
      fixture.setRelease({ version: nextVersion, channel: 'stable' });
      await page.setViewportSize(viewport);
      await page.goto('/');
      await confirmCompatibility(page);
      if (viewport.name === 'mobile')
        await page.getByRole('button', { name: '打开项目与会话', exact: true }).click();
      await page.getByRole('button', { name: 'Covro 更新', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Covro 更新', exact: true });
      const selector = dialog.getByRole('combobox', { name: '版本渠道' });
      await expect(selector).toHaveText(channel === 'beta' ? '预览版' : '开发版');
      await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
      await expect(dialog.locator('.update-available')).toContainText(nextVersion);
      await expect(dialog.locator('.update-available')).toContainText('稳定版');
      await expect(dialog.locator('.update-source')).toContainText('latest');
      await expect(dialog).toContainText(channel === 'dev' ? '不接收预览版' : '保留预览版订阅');
      await screenshot(page, `issue-207-${channel}-${viewport.name}.png`);
      // Stable candidates retain the same Codex gates as channel-specific candidates.
      fixture.setCandidate({ recommended: '99.0.0', verified: ['99.0.0'], unsupported: [] });
      await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
      await expect(dialog).toContainText('自动升级已暂停');
      const upgrade = dialog.getByRole('button', { name: '升级并重启', exact: true });
      await expect(upgrade).toBeDisabled();
      await dialog.getByRole('checkbox', { name: '允许尝试未验证的 Codex 组合' }).check();
      await upgrade.click();
      await expect(dialog).toContainText('等待任务空闲');
      await expect(selector).toHaveText(channel === 'beta' ? '预览版' : '开发版');
      await expect(dialog.locator('.update-progress')).toContainText('稳定版');
      const runs = fixture.requests.filter((request) => request.path.endsWith('/run'));
      expect(runs).toHaveLength(1);
      expect(runs[0]!.body.channel).toBe(channel);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
    });
  }
}
test.beforeEach(async ({ request }) => {
  await controlRuntime(request, { reset: true });
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name}: channel, automatic updates and persistent waiting/rollback results`, async ({
    page,
  }) => {
    const fixture = await updatesFixture(page);
    await page.setViewportSize(viewport);
    await page.goto('/');
    await confirmCompatibility(page);
    if (viewport.name === 'mobile')
      await page.getByRole('button', { name: '打开项目与会话', exact: true }).click();
    await page.getByRole('button', { name: 'Covro 更新', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Covro 更新', exact: true });
    await expect(dialog).toBeVisible();
    const channel = dialog.getByRole('combobox', { name: '版本渠道' });
    await channel.click();
    await expect(page.getByRole('option', { name: '稳定版', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await screenshot(page, `select-updates-${viewport.name}-menu.png`);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(channel).toBeFocused();
    await chooseSelectOption(page, channel, '开发版');
    await expect(dialog).toContainText(developmentVersion);
    await dialog.getByRole('switch', { name: '空闲时自动升级' }).click();
    await expect(dialog.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await screenshot(page, `update-${viewport.name}-available.png`);
    await dialog.getByRole('button', { name: '升级并重启', exact: true }).click();
    await expect(dialog).toContainText('等待任务空闲');
    expect(fixture.requests.filter((request) => request.path.endsWith('/run'))).toHaveLength(1);
    await screenshot(page, `update-${viewport.name}-waiting.png`);
    fixture.state.run = {
      ...fixture.state.run!,
      phase: 'rolledBack',
      message: '新版启动验证失败，已恢复上一版本，配置和操作记录保持完整',
    };
    await expect(dialog).toContainText('已恢复上一版本', { timeout: 10_000 });
    await screenshot(page, `update-${viewport.name}-rollback.png`);
    expect(fixture.requests.filter((request) => request.path.endsWith('/run'))).toHaveLength(1);
    if (viewport.name === 'mobile')
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
  });
}

test('new server version reloads the UI once and restores the tab draft and pasted image without submitting it', async ({
  page,
}) => {
  const fixture = await updatesFixture(page);
  let submissions = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(turns|steer)$/.test(new URL(request.url()).pathname))
      submissions++;
  });
  await page.goto('/');
  await confirmCompatibility(page);
  const input = page.locator('.composer-box textarea');
  await expect(input).toBeEnabled();
  await input.fill('升级后继续处理这份草稿，保留图片。');
  await input.evaluate((element) => {
    const bytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      ),
      (value) => value.charCodeAt(0),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'draft.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.locator('.composer-images img')).toHaveCount(1);
  const loaded = page.waitForEvent('load');
  fixture.triggerReload();
  await loaded;
  await expect(input).toHaveValue('升级后继续处理这份草稿，保留图片。');
  await expect(page.locator('.composer-images img')).toHaveCount(1);
  expect(submissions).toBe(0);
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1100 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name}: compatibility blocks unknown/unsupported candidates and requires a fresh exact confirmation`, async ({
    page,
  }) => {
    const fixture = await updatesFixture(page);
    fixture.state.settings.automatic = true;
    await page.setViewportSize(viewport);
    await page.goto('/');
    await confirmCompatibility(page);
    if (viewport.name === 'mobile')
      await page.getByRole('button', { name: '打开项目与会话', exact: true }).click();
    await page.getByRole('button', { name: 'Covro 更新', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Covro 更新', exact: true });
    const currentCodex = dialog.getByRole('region', { name: '当前 Codex', exact: true });
    await expect(currentCodex).toContainText(CODEX_COMPATIBILITY.recommended);
    await expect(currentCodex).toContainText('已验证');
    fixture.setCandidate(undefined);
    await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
    const candidate = dialog.getByRole('region', { name: '目标版本兼容性', exact: true });
    const upgrade = dialog.getByRole('button', { name: '升级并重启', exact: true });
    await expect(candidate).toContainText('缺少有效的 Codex 兼容声明');
    await expect(upgrade).toBeDisabled();
    await screenshot(page, `codex-${viewport.name}-missing-metadata.png`);
    const unsupported = {
      recommended: '99.0.0',
      verified: ['99.0.0'],
      unsupported: [
        { version: CODEX_COMPATIBILITY.recommended, reason: '示例：该组合明确不受支持' },
      ],
    };
    fixture.setCandidate(unsupported);
    await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect(candidate).toContainText('明确不支持');
    await expect(upgrade).toBeDisabled();
    await expect(dialog.getByRole('checkbox', { name: '允许尝试未验证的 Codex 组合' })).toHaveCount(
      0,
    );
    await candidate.scrollIntoViewIfNeeded();
    await screenshot(page, `codex-${viewport.name}-unsupported.png`);
    const unverified = { ...unsupported, unsupported: [] };
    fixture.setCandidate(unverified);
    await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect(candidate).toContainText('尚未验证');
    const consent = dialog.getByRole('checkbox', { name: '允许尝试未验证的 Codex 组合' });
    await expect(upgrade).toBeDisabled();
    await consent.check();
    await expect(upgrade).toBeEnabled();
    fixture.setCodex('0.162.1');
    await expect(candidate).toContainText('0.162.1', { timeout: 10_000 });
    await expect(consent).not.toBeChecked();
    await expect(upgrade).toBeDisabled();
    fixture.setCodex('0.163.0');
    await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect(candidate).toContainText('当前 Codex 0.163.0');
    await expect(consent).not.toBeChecked();
    await consent.check();
    await expect(upgrade).toBeEnabled();
    await screenshot(page, `codex-${viewport.name}-confirmed.png`);
    expect(fixture.requests.filter((request) => request.path.endsWith('/run'))).toHaveLength(0);
    await upgrade.click();
    await expect(dialog).toContainText('等待任务空闲');
    const runs = fixture.requests.filter((request) => request.path.endsWith('/run'));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.body.codexConfirmation).toEqual({ version: '0.163.0', target: nextVersion });
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  });
}

test('unknown configured Codex blocks managed upgrades even when the candidate declares compatible versions', async ({
  page,
}) => {
  const fixture = await updatesFixture(page);
  fixture.setCodex(null);
  await page.goto('/');
  await confirmCompatibility(page);
  await page.getByRole('button', { name: 'Covro 更新', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Covro 更新', exact: true });
  await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '目标版本兼容性', exact: true })).toContainText(
    '无法确认当前 Codex CLI 版本',
  );
  await expect(dialog.getByRole('button', { name: '升级并重启', exact: true })).toBeDisabled();
  await screenshot(page, 'codex-desktop-unknown-runtime.png');
  expect(fixture.requests.filter((request) => request.path.endsWith('/run'))).toHaveLength(0);
});

async function openReleaseNotes(page: Page, mobile = false) {
  await page.goto('/');
  await confirmCompatibility(page);
  if (mobile) await page.getByRole('button', { name: '打开项目与会话', exact: true }).click();
  await page.getByRole('button', { name: 'Covro 更新', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Covro 更新', exact: true });
  await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
  return dialog;
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1100 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name}: release notes render Markdown safely with a scrollable long description`, async ({
    page,
  }) => {
    await updatesFixture(page);
    await page.setViewportSize(viewport);
    await page.route('**/api/updates/release-notes?**', async (route) => {
      const version = new URL(route.request().url()).searchParams.get('version');
      await route.fulfill({
        json: {
          version,
          state: 'available',
          url: `https://github.com/yuzheng14/covro/releases/tag/v${version}`,
          body:
            '## New features\n\n- **Read release notes** before updating.\n- Keep notes matched to the selected version.\n\n[Read the guide](docs/releases.md) · [Issue #225](https://github.com/yuzheng14/covro/issues/225)\n\n### Fixes\n\n' +
            Array.from(
              { length: 20 },
              (_, i) => `- Improvement ${i + 1}: ${'Long release description. '.repeat(8)}`,
            ).join('\n') +
            '\n\n| Area | Change |\n| --- | --- |\n| Updates | Version-specific notes |\n\n```sh\ncovro update\n```\n\n<script>window.releaseUnsafe = true</script>\n\n[Unsafe](javascript:alert%281%29)',
        },
      });
    });
    const dialog = await openReleaseNotes(page, viewport.name === 'mobile');
    const notes = dialog.getByRole('region', { name: '发布说明', exact: true });
    const content = notes.getByRole('region', { name: '发布说明正文', exact: true });
    await expect(content.getByRole('heading', { name: 'New features', exact: true })).toBeVisible();
    await expect(content.locator('strong')).toContainText('Read release notes');
    await expect(notes.getByRole('link', { name: '在 GitHub 查看' })).toHaveAttribute(
      'href',
      `https://github.com/yuzheng14/covro/releases/tag/v${nextVersion}`,
    );
    await expect(content.getByRole('link', { name: 'Read the guide' })).toHaveAttribute(
      'href',
      `https://github.com/yuzheng14/covro/blob/v${nextVersion}/docs/releases.md`,
    );
    await expect(content.locator('script')).toHaveCount(0);
    await expect(content.getByRole('link', { name: 'Unsafe', exact: true })).toHaveAttribute(
      'href',
      '',
    );
    await expect(content.getByRole('table')).toBeAttached();
    expect(await content.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await notes.scrollIntoViewIfNeeded();
    await screenshot(page, `release-notes-${viewport.name}.png`);
    await expect(dialog.getByRole('button', { name: '升级并重启', exact: true })).toBeEnabled();
  });
}

test('release-note failures and empty releases can retry without blocking an upgrade', async ({
  page,
}) => {
  const fixture = await updatesFixture(page);
  let state: 'missing' | 'empty' | 'rateLimited' | 'network' | 'available' = 'missing';
  const queries: URLSearchParams[] = [];
  await page.route('**/api/updates/release-notes?**', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    if (state === 'network') {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      json: {
        version: query.get('version'),
        url: `https://github.com/yuzheng14/covro/releases/tag/v${nextVersion}`,
        ...(state === 'rateLimited'
          ? { state: 'error', reason: 'rateLimited' }
          : { state, body: '## Recovered release notes' }),
      },
    });
  });
  const dialog = await openReleaseNotes(page);
  const notes = dialog.getByRole('region', { name: '发布说明', exact: true });
  const upgrade = dialog.getByRole('button', { name: '升级并重启', exact: true });
  for (const [next, text] of [
    ['empty', '暂无发布说明'],
    ['rateLimited', '尚未填写说明'],
    ['network', '已被限流'],
    ['available', '加载失败'],
  ] as const) {
    await expect(notes).toContainText(text);
    await expect(upgrade).toBeEnabled();
    await notes.scrollIntoViewIfNeeded();
    await screenshot(page, `release-notes-${state}.png`);
    state = next;
    await notes.getByRole('button', { name: '重试', exact: true }).click();
  }
  await expect(
    notes.getByRole('heading', { name: 'Recovered release notes', exact: true }),
  ).toBeVisible();
  expect(queries).toHaveLength(5);
  expect(queries.slice(1).every((query) => query.get('refresh') === '1')).toBe(true);
  await upgrade.click();
  expect(fixture.requests.filter((request) => request.path.endsWith('/run'))).toHaveLength(1);
});

test('channel and same-channel target changes discard late release-note responses', async ({
  page,
}) => {
  const fixture = await updatesFixture(page);
  let releaseOld: (() => void) | undefined;
  const oldResponse = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const requested: string[] = [];
  await page.route('**/api/updates/release-notes?**', async (route) => {
    const version = new URL(route.request().url()).searchParams.get('version')!;
    requested.push(version);
    if (version === nextVersion) await oldResponse;
    await route
      .fulfill({
        json: {
          version,
          state: 'available',
          url: `https://github.com/yuzheng14/covro/releases/tag/v${version}`,
          body: `## Notes for ${version}`,
        },
      })
      .catch(() => {});
  });
  const dialog = await openReleaseNotes(page);
  const notes = dialog.getByRole('region', { name: '发布说明', exact: true });
  await expect(notes).toContainText('正在加载发布说明');
  await expect(dialog.getByRole('button', { name: '升级并重启', exact: true })).toBeEnabled();
  await notes.scrollIntoViewIfNeeded();
  await screenshot(page, 'release-notes-loading.png');
  await chooseSelectOption(page, dialog.getByRole('combobox', { name: '版本渠道' }), '开发版');
  await expect(
    notes.getByRole('heading', { name: `Notes for ${developmentVersion}`, exact: true }),
  ).toBeVisible();
  releaseOld!();
  const changed = `${nextVersion}-dev.124`;
  fixture.state.available = { ...fixture.state.available!, version: changed };
  await expect(
    notes.getByRole('heading', { name: `Notes for ${changed}`, exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    notes.getByRole('heading', { name: `Notes for ${nextVersion}`, exact: true }),
  ).toHaveCount(0);
  await expect(notes.getByRole('link', { name: '在 GitHub 查看' })).toHaveAttribute(
    'href',
    `https://github.com/yuzheng14/covro/releases/tag/v${changed}`,
  );
  expect(requested).toEqual([nextVersion, developmentVersion, changed]);
  await screenshot(page, 'release-notes-changed-target.png');
});

for (const locale of ['zh-Hans', 'en', 'ja', 'ko']) {
  for (const viewport of [
    { name: 'desktop', width: 1440, height: 1100 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    test(`${viewport.name}: ${locale} same-version Node migration, actual source and diagnostics`, async ({
      page,
    }) => {
      const strings = JSON.parse(
        readFileSync(
          new URL(`../../src/web/i18n/locales/${locale}/updates.json`, import.meta.url),
          'utf8',
        ),
      ) as Record<string, string>;
      const common = JSON.parse(
        readFileSync(
          new URL(`../../src/web/i18n/locales/${locale}/common.json`, import.meta.url),
          'utf8',
        ),
      ) as Record<string, string>;
      const fixture = await updatesFixture(page);
      fixture.setRelease({ version: currentVersion, channel: 'stable' });
      const current = {
        node: '/opt/node-a/bin/node',
        nodeVersion: '24.19.0',
        root: '/opt/node-a/lib/node_modules/@covro/covro',
        entry: '/opt/node-a/lib/node_modules/@covro/covro/bin/covro.mjs',
      };
      const target = {
        node: '/opt/node-b/bin/node',
        nodeVersion: '24.22.1',
        root: '/opt/node-b/lib/node_modules/@covro/covro',
        entry: '/opt/node-b/lib/node_modules/@covro/covro/bin/covro.mjs',
      };
      fixture.state.runtime = { current, target, migration: true };
      await page.setViewportSize(viewport);
      await page.goto('/');
      await confirmCompatibility(page);
      await selectInterfaceLocale(page, locale);
      await page.getByRole('button', { name: common.covro_updates, exact: true }).click();
      const dialog = page.locator('.update-dialog');
      await dialog.getByRole('button', { name: strings.check_for_updates, exact: true }).click();
      const migrate = dialog.getByRole('button', {
        name: strings.migrate_and_restart,
        exact: true,
      });
      await expect(migrate).toBeEnabled();
      await dialog.getByText(strings.installation_source!, { exact: true }).click();
      await expect(dialog.locator('.update-runtime')).toContainText(target.entry);
      await screenshot(page, `node-${locale}-${viewport.name}-migration.png`);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await migrate.scrollIntoViewIfNeeded();
      await screenshot(page, `node-${locale}-${viewport.name}-action.png`);
      await migrate.click();
      expect(fixture.requests.filter((request) => request.path.endsWith('/run'))).toHaveLength(1);
      fixture.state.run = {
        ...fixture.state.run!,
        phase: 'succeeded',
        committed: true,
        runtime: { from: current, target, actual: target },
      };
      fixture.state.runtime = { current: target, migration: false };
      await expect(dialog.locator('.update-progress')).toContainText(strings.update_successful!, {
        timeout: 10_000,
      });
      await expect(dialog.locator('.update-runtime')).toContainText('24.22.1');
      await dialog.locator('.update-progress').scrollIntoViewIfNeeded();
      await screenshot(page, `node-${locale}-${viewport.name}-succeeded.png`);
      fixture.state.runtime.error =
        '目标 npm 的全局 Covro 入口缺失；请在目标终端执行 npm install -g @covro/covro。';
      await expect(dialog.getByRole('alert')).toContainText(strings.runtime_unavailable!, {
        timeout: 10_000,
      });
      await expect(
        dialog.getByRole('button', { name: strings.use_this_channel, exact: true }),
      ).toBeDisabled();
      await dialog.locator('.update-runtime').scrollIntoViewIfNeeded();
      await screenshot(page, `node-${locale}-${viewport.name}-diagnostic.png`);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
    });
  }
}
