import { useEffect, useRef, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import type { SystemInfo } from '../../shared/types';
import type { UsageGroup, UsageWindow } from '../../shared/account-usage';
import { currentLocale, formatDate, t } from '../i18n';
import { api } from '../lib/api';
import { Button } from './ui/button';
import { Icon } from './Icon';

function percentage(value: number) {
  return new Intl.NumberFormat(currentLocale(), {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value / 100);
}

function ResetTime({ seconds, now }: { seconds: number | null; now: number }) {
  if (seconds === null) return <span>{t('account:resetUnknown')}</span>;
  const date = new Date(seconds * 1000);
  return (
    <span className="account-reset">
      <span>
        {t('account:resetsAt', {
          time: formatDate(date, {
            dateStyle: 'medium',
            timeStyle: 'long',
          }),
        })}
      </span>
      {seconds * 1000 <= now && <span>{t('account:resetPassed')}</span>}
    </span>
  );
}

function Window({ value, label, now }: { value: UsageWindow; label: string; now: number }) {
  const minutes = value.windowDurationMins;
  const unit =
    minutes !== null && minutes > 0 && minutes % 1440 === 0
      ? 'day'
      : minutes !== null && minutes > 0 && minutes % 60 === 0
        ? 'hour'
        : 'minute';
  const duration =
    minutes === null
      ? null
      : new Intl.NumberFormat(currentLocale(), {
          style: 'unit',
          unit,
          unitDisplay: 'long',
          maximumFractionDigits: 1,
        }).format(minutes / (unit === 'day' ? 1440 : unit === 'hour' ? 60 : 1));
  const used = value.usedPercent;
  return (
    <div className="account-window">
      <strong>
        {label}
        {duration !== null && ` · ${duration}`}
      </strong>
      {used === null ? (
        <span>{t('account:usageUnknown')}</span>
      ) : (
        <>
          <div className="account-window-values">
            <span>{t('account:used', { value: percentage(used) })}</span>
            <span>{t('account:remaining', { value: percentage(Math.max(0, 100 - used)) })}</span>
          </div>
          <progress aria-label={label} value={Math.max(0, Math.min(100, used))} max={100} />
          {used >= 100 && (
            <strong className="account-limit-reached">{t('account:exhausted')}</strong>
          )}
        </>
      )}
      <ResetTime seconds={value.resetsAt} now={now} />
    </div>
  );
}

const reachedKeys: Record<string, string> = {
  rate_limit_reached: 'account:exhausted',
  workspace_owner_credits_depleted: 'account:ownerCreditsDepleted',
  workspace_member_credits_depleted: 'account:memberCreditsDepleted',
  workspace_owner_usage_limit_reached: 'account:ownerUsageReached',
  workspace_member_usage_limit_reached: 'account:memberUsageReached',
};

function Group({ group, now }: { group: UsageGroup; now: number }) {
  const name = group.limitName || group.limitId || t('account:quota');
  return (
    <section className="account-group" aria-label={name}>
      <div className="account-group-heading">
        <h3>{name}</h3>
        {group.planType && <span>{group.planType}</span>}
      </div>
      {group.limitName && group.limitId && group.limitId !== group.limitName && (
        <span className="account-metadata">{group.limitId}</span>
      )}
      {group.normalModelSlug && <span className="account-metadata">{group.normalModelSlug}</span>}
      {group.primary && <Window value={group.primary} label={t('account:primary')} now={now} />}
      {group.secondary && (
        <Window value={group.secondary} label={t('account:secondary')} now={now} />
      )}
      {group.credits && (
        <div className="account-window">
          <strong>{t('account:credits')}</strong>
          {group.credits.unlimited === true ? (
            <span>{t('account:unlimited')}</span>
          ) : (
            <>
              <span>
                {group.credits.balance === null
                  ? t('account:balanceUnknown')
                  : t('account:balance', { value: group.credits.balance })}
              </span>
              {group.credits.hasCredits !== null && (
                <span>
                  {t(
                    group.credits.hasCredits
                      ? 'account:creditsAvailable'
                      : 'account:creditsDepleted',
                  )}
                </span>
              )}
            </>
          )}
        </div>
      )}
      {group.individualLimit && (
        <div className="account-window">
          <strong>{t('account:individualLimit')}</strong>
          {group.individualLimit.used !== null && (
            <span>{t('account:reportedUsed', { value: group.individualLimit.used })}</span>
          )}
          {group.individualLimit.limit !== null && (
            <span>{t('account:reportedLimit', { value: group.individualLimit.limit })}</span>
          )}
          {group.individualLimit.remainingPercent !== null && (
            <span>
              {t('account:remaining', {
                value: percentage(group.individualLimit.remainingPercent),
              })}
            </span>
          )}
          <ResetTime seconds={group.individualLimit.resetsAt} now={now} />
        </div>
      )}
      {group.spendControlReached !== null && (
        <p>
          {t(
            group.spendControlReached
              ? 'account:spendControlReached'
              : 'account:spendControlNotReached',
          )}
        </p>
      )}
      {group.rateLimitReachedType && (
        <p className="account-limit-reached">
          {reachedKeys[group.rateLimitReachedType]
            ? t(reachedKeys[group.rateLimitReachedType]!)
            : group.rateLimitReachedType}
        </p>
      )}
      {!group.primary &&
        !group.secondary &&
        !group.credits &&
        !group.individualLimit &&
        !group.rateLimitReachedType && <p>{t('account:noWindows')}</p>}
    </section>
  );
}

export function AccountUsage({
  system,
  offline,
  onClose,
}: {
  system?: SystemInfo;
  offline: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const usage = system?.accountUsage;
  const scope = `${system?.codexEpoch}:${usage?.scope}`;
  const [request, setRequest] = useState<{ scope: string; busy: boolean; failed: boolean }>();
  const [now, setNow] = useState(Date.now());
  const unavailable = offline || !system?.ready;
  const refresh = () => {
    setRequest({ scope, busy: true, failed: false });
    void api.accountUsage().then(
      () => setRequest({ scope, busy: false, failed: false }),
      () => setRequest({ scope, busy: false, failed: true }),
    );
  };
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      element?.close();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!unavailable) refresh();
    // Re-read when the gateway or app-server reconnects. Snapshot events do not loop reads.
  }, [system?.codexEpoch, unavailable]);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  const status = unavailable ? 'offline' : (usage?.status ?? 'unsupported');
  const busy = !unavailable && (usage?.refreshing || (request?.scope === scope && request.busy));
  const failed =
    !unavailable && (status === 'error' || (request?.scope === scope && request.failed));
  return (
    <dialog
      ref={dialog}
      className="project-dialog account-dialog"
      aria-labelledby="account-usage-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="project-dialog-heading">
        <div>
          <Gauge size={20} aria-hidden="true" />
          <h2 id="account-usage-title">{t('account:title')}</h2>
        </div>
        <Button variant="ghost" size="icon" aria-label={t('common:close')} onClick={close}>
          <Icon name="close" size={17} />
        </Button>
      </div>
      <p className="account-scope">{t('account:scope')}</p>
      <div className="account-refresh">
        <Button variant="secondary" size="sm" disabled={unavailable || busy} onClick={refresh}>
          <RefreshCw size={14} aria-hidden="true" />
          {t(busy ? 'account:refreshing' : 'account:refresh')}
        </Button>
        {!unavailable && usage?.updatedAt !== null && usage?.updatedAt !== undefined && (
          <span>
            {t('account:updatedAt', {
              time: formatDate(new Date(usage.updatedAt), {
                dateStyle: 'medium',
                timeStyle: 'medium',
              }),
            })}
          </span>
        )}
      </div>
      <div role="status" aria-live="polite">
        {status !== 'ready' && status !== 'error' && <p>{t(`account:${status}`)}</p>}
        {failed && <p className="inline-error">{t('account:refreshFailed')}</p>}
      </div>
      {!unavailable && (status === 'ready' || status === 'error') && (
        <>
          {usage?.ordinaryUsageAllowed !== null && usage?.ordinaryUsageAllowed !== undefined && (
            <p>{t(usage.ordinaryUsageAllowed ? 'account:usageAllowed' : 'account:usageBlocked')}</p>
          )}
          {usage?.groups.map((group, index) => (
            <Group key={group.limitId ?? index} group={group} now={now} />
          ))}
          {status === 'ready' && !usage?.groups.length && <p>{t('account:noWindows')}</p>}
          {usage?.resetCreditsAvailable !== null && usage?.resetCreditsAvailable !== undefined && (
            <p>{t('account:resetCredits', { count: usage.resetCreditsAvailable })}</p>
          )}
        </>
      )}
    </dialog>
  );
}
