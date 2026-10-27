import { displayMessage } from '../i18n/messages';
import { t, formatList } from '../i18n';
import type { CodexCompatibility } from '../../shared/codex-compatibility';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, ExternalLink } from 'lucide-react';
import { releaseChannels, updateActive, type ReleaseChannel } from '../../shared/updates';
import { compareVersions, validVersion } from '../../shared/versions';
import type { Updates } from '../hooks/useUpdates';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Icon } from './Icon';
import { UpdateReleaseNotes } from './UpdateReleaseNotes';
import { releasesUrl } from '../../shared/release-notes';

const labels: Record<ReleaseChannel, string> = {
  get stable() {
    return t('updates:stable');
  },
  get beta() {
    return t('updates:beta');
  },
  get dev() {
    return t('updates:development');
  },
};
const phaseLabels = {
  get installing() {
    return t('updates:installing_candidate_version');
  },
  get waiting() {
    return t('updates:waiting_for_tasks_to_finish');
  },
  get stopping() {
    return t('updates:backing_up_and_restarting');
  },
  get verifying() {
    return t('updates:verifying_new_version');
  },
  get succeeded() {
    return t('updates:update_successful');
  },
  get rolledBack() {
    return t('updates:previous_version_restored');
  },
  get failed() {
    return t('updates:update_failed');
  },
};
const compatibilityLabels = {
  get verified() {
    return t('updates:verified');
  },
  get unverified() {
    return t('updates:unverified');
  },
  get unsupported() {
    return t('updates:explicitly_unsupported');
  },
  get unknown() {
    return t('updates:cannot_confirm');
  },
};
function CodexCompatibilityDetails({ title, value }: { title: string; value: CodexCompatibility }) {
  return (
    <section className="update-codex" aria-label={title} data-state={value.status}>
      <h3>{title}</h3>
      <div>
        <span>Codex CLI</span>
        <strong>{value.version ?? t('updates:unrecognized')}</strong>
        <span className="update-codex-status">{compatibilityLabels[value.status]}</span>
      </div>
      {value.manifest && (
        <p className="subtle">
          {t('updates:recommended_verified', {
            v0: value.manifest.recommended,
            v1: formatList(value.manifest.verified),
          })}
        </p>
      )}
      {value.reason && <p>{value.reason}</p>}
    </section>
  );
}
export function UpdateSettings({ updates, onClose }: { updates: Updates; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { status, busy, error, reloadError } = updates;
  const [selectedChannel, setChannel] = useState<ReleaseChannel>();
  const channel = selectedChannel ?? status?.settings.channel ?? 'stable';
  const [allowDowngrade, setAllowDowngrade] = useState(false);
  const selected =
    (status?.available?.requestedChannel ?? status?.available?.channel) === channel
      ? status?.available
      : undefined;
  const active = updateActive(status?.run);
  const migration = Boolean(status?.runtime?.migration);
  const current =
    selected &&
    status &&
    validVersion(status.version) &&
    compareVersions(selected.version, status.version) === 0;
  const [codexConsent, setCodexConsent] = useState<string>();
  const identity = JSON.stringify([
    channel,
    selected?.version,
    selected?.codex,
    status?.runtime?.target,
  ]);
  const confirmedCodex = codexConsent === identity;
  const compatibility = selected?.codex;
  const needsCodexConsent = (!current || migration) && compatibility?.status === 'unverified';
  const codexBlocked =
    (!current || migration) &&
    selected &&
    (!compatibility ||
      compatibility.status === 'unknown' ||
      compatibility.status === 'unsupported' ||
      (needsCodexConsent && !confirmedCodex));
  useEffect(() => {
    setCodexConsent(undefined);
  }, [identity]);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="project-dialog update-dialog"
      aria-labelledby="update-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="project-dialog-heading">
        <div>
          <ArrowUpCircle size={20} aria-hidden="true" />
          <h2 id="update-title">{t('common:covro_updates')}</h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('updates:close_update_settings')}
          onClick={onClose}
        >
          <Icon name="close" size={17} />
        </Button>
      </div>
      {status?.runtime && (
        <section className="update-runtime" aria-label={t('updates:runtime')}>
          <div className="update-version">
            <span>Node.js</span>
            <strong>{status.runtime.current.nodeVersion}</strong>
            {migration && status.runtime.target && (
              <strong>→ {status.runtime.target.nodeVersion}</strong>
            )}
          </div>
          <details>
            <summary>{t('updates:installation_source')}</summary>
            <pre>
              {status.runtime.current.node}
              {'\n'}
              {status.runtime.current.entry}
            </pre>
            {migration && status.runtime.target && (
              <pre>
                → {status.runtime.target.node}
                {'\n'}
                {status.runtime.target.entry}
              </pre>
            )}
          </details>
          {status.runtime.error && (
            <div className="inline-error" role="alert">
              <p>{t('updates:runtime_unavailable')}</p>
              <details>
                <summary>{t('common:technical_details')}</summary>
                <pre>{status.runtime.error}</pre>
              </details>
            </div>
          )}
        </section>
      )}
      <div className="update-version">
        <span>{t('updates:current_covro')}</span>
        <strong>{status?.version ?? t('common:loading_2')}</strong>
        {status?.commit && <code>{status.commit.slice(0, 8)}</code>}
      </div>
      {status?.codex && (
        <CodexCompatibilityDetails title={t('updates:current_codex')} value={status.codex} />
      )}
      <label className="update-channel">
        {t('updates:release_channel')}
        <Select
          value={channel}
          disabled={busy || active}
          onValueChange={(value) => {
            const next = value as ReleaseChannel;
            setChannel(next);
            setAllowDowngrade(false);
            setCodexConsent(undefined);
            void updates.check(next);
          }}
        >
          <SelectTrigger aria-label={t('updates:release_channel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {releaseChannels.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {labels[entry]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <p className="subtle">
        {channel === 'stable'
          ? t('updates:verified_releases_for_everyday_use')
          : channel === 'beta'
            ? t('updates:try_features_being_prepared_for_release')
            : t('updates:follows_checked_main_commits_for_developers_testing_new')}
      </p>
      <div className="update-control">
        <div>
          <strong>{t('updates:auto_update_when_idle')}</strong>
          <p className="subtle">
            {t('updates:periodically_check_this_channel_and_install_verified_codex')}
          </p>
        </div>
        <Button
          role="switch"
          aria-label={t('updates:auto_update_when_idle')}
          aria-checked={status?.settings.automatic ?? false}
          variant="secondary"
          size="sm"
          disabled={busy || active || !status?.supported}
          onClick={() =>
            status &&
            void updates.configure({ ...status.settings, automatic: !status.settings.automatic })
          }
        >
          {status?.settings.automatic ? t('common:on') : t('updates:disabled')}
        </Button>
      </div>
      {status && channel !== status.settings.channel && (
        <p className="subtle">
          {t('updates:subscribed_to_switches_to_after_a_successful_update', {
            v0: labels[status.settings.channel],
            v1: labels[channel],
          })}
        </p>
      )}
      {selected && (
        <div className="update-available">
          <span>
            {current
              ? t('updates:this_channel_is_already_at_the_current_version')
              : selected.downgrade
                ? t('updates:target_version')
                : t('updates:available_version')}
          </span>
          <strong>{selected.version}</strong>
          <span>{labels[selected.channel]}</span>
          {selected.commit && <code>{selected.commit.slice(0, 8)}</code>}
        </div>
      )}
      {selected && (
        <UpdateReleaseNotes key={`${channel}:${selected.version}`} version={selected.version} />
      )}
      {selected?.codex && (
        <CodexCompatibilityDetails
          title={t('updates:target_version_compatibility')}
          value={selected.codex}
        />
      )}
      {needsCodexConsent && (
        <label className="update-downgrade update-codex-consent">
          <input
            type="checkbox"
            aria-label={t('updates:allow_trying_an_unverified_codex_combination')}
            checked={confirmedCodex}
            disabled={busy || active}
            onChange={(event) => setCodexConsent(event.target.checked ? identity : undefined)}
          />
          {t('updates:i_agree_to_try_the_unverified_combination_of', {
            v0: compatibility?.version,
            v1: selected?.version,
          })}
        </label>
      )}
      {selected &&
        !current &&
        channel === status?.settings.channel &&
        status.settings.automatic &&
        compatibility?.status !== 'verified' && (
          <p className="update-notice" role="status">
            {compatibility?.status === 'unverified'
              ? t('updates:auto_update_is_paused_adjust_the_codex_version')
              : t('updates:auto_update_is_paused_restore_the_codex_connection')}
          </p>
        )}
      <div className="update-buttons">
        <Button
          variant="secondary"
          disabled={busy || active}
          onClick={() => void updates.check(channel)}
        >
          {busy ? t('updates:processing') : t('updates:check_for_updates')}
        </Button>
        <Button
          disabled={
            busy ||
            active ||
            !selected ||
            !status?.supported ||
            Boolean(status?.runtime?.error) ||
            Boolean(codexBlocked) ||
            (selected.downgrade && !allowDowngrade) ||
            (current && !migration && channel === status.settings.channel)
          }
          onClick={() =>
            void updates.start(
              channel,
              allowDowngrade,
              needsCodexConsent && confirmedCodex && selected?.codex.version
                ? { version: selected.codex.version, target: selected.version }
                : undefined,
            )
          }
        >
          {current && migration
            ? t('updates:migrate_and_restart')
            : current
              ? t('updates:use_this_channel')
              : selected?.downgrade
                ? t('updates:switch_and_restart')
                : t('updates:update_and_restart')}
        </Button>
      </div>
      {selected?.downgrade && (
        <label className="update-downgrade">
          <input
            type="checkbox"
            checked={allowDowngrade}
            onChange={(event) => setAllowDowngrade(event.target.checked)}
          />
          {t('updates:allow_downgrade_incompatible_databases_still_block_switching')}
        </label>
      )}
      {status?.run && (
        <section className="update-progress" data-phase={status.run.phase} role="status">
          <strong>{phaseLabels[status.run.phase]}</strong>
          <span>
            {status.run.from} → {status.run.target}
            {status.run.sourceChannel && ` · ${labels[status.run.sourceChannel]}`}
          </span>
          <p>{t(`updates:${status.run.phase}Description`)}</p>
          <details>
            <summary>{t('common:technical_details')}</summary>
            <pre>{status.run.message}</pre>
            {status.run.runtime && <pre>{JSON.stringify(status.run.runtime, null, 2)}</pre>}
          </details>
          {active && <progress aria-label={t('updates:update_progress')} />}
        </section>
      )}
      {(error || status?.checkError || reloadError) && (
        <div className="inline-error" role="alert">
          <p>{displayMessage(reloadError ?? error) ?? t('updates:checkFailed')}</p>
          {status?.checkError && (
            <details>
              <summary>{t('common:technical_details')}</summary>
              <pre>{status.checkError}</pre>
            </details>
          )}
        </div>
      )}
      {!status?.supported && status?.unsupportedReason && (
        <div className="update-notice">
          <p>{t('updates:manualUpdate')}</p>
          <details>
            <summary>{t('common:technical_details')}</summary>
            <pre>{status.unsupportedReason}</pre>
          </details>
        </div>
      )}
      <p className="update-source">
        {t('updates:version_source_official_npm_registry', {
          v0: selected
            ? selected.channel === 'stable'
              ? 'latest'
              : selected.channel
            : channel === 'stable'
              ? 'latest'
              : `latest / ${channel}`,
        })}
        <a href={releasesUrl} target="_blank" rel="noreferrer">
          {t('updates:update_history')}
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      </p>
      <p className="subtle">
        {t('updates:updates_preserve_configuration_projects_and_session_history_processing')}
      </p>
    </dialog>
  );
}
