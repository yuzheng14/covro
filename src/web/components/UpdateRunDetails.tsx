import type { RuntimeIdentity, UpdateRun } from '../../shared/updates';
import { t } from '../i18n';
import { CopyableTechnicalDetails } from './CopyableTechnicalDetails';

function runtimeIdentity({
  node,
  nodeVersion,
  root,
  entry,
  npm,
  npmVersion,
  globalRoot,
}: RuntimeIdentity) {
  // The server's runtime target can also carry environment data outside this display contract.
  return { node, nodeVersion, root, entry, npm, npmVersion, globalRoot };
}

function formatFailure(run: UpdateRun) {
  const lines = [
    `Update ID: ${run.id}`,
    `Phase: ${run.phase}`,
    `Covro: ${run.from} → ${run.target}`,
  ];
  if (run.sourceChannel) lines.push(`Source channel: ${run.sourceChannel}`);
  if (run.commit) lines.push(`Target commit: ${run.commit}`);
  if (run.codex?.version) lines.push(`Target Codex: ${run.codex.version}`);
  if (run.message) lines.push('', 'Error:', run.message);
  if (run.runtime) {
    const { from, target, actual } = run.runtime;
    const runtime = {
      from: runtimeIdentity(from),
      target: runtimeIdentity(target),
      actual: actual && runtimeIdentity(actual),
    };
    lines.push('', 'Runtime:', JSON.stringify(runtime, null, 2));
  }
  return lines.join('\n');
}

export function UpdateRunDetails({ run }: { run: UpdateRun }) {
  if (run.phase === 'failed' || run.phase === 'rolledBack') {
    const text = formatFailure(run);
    return (
      <CopyableTechnicalDetails key={JSON.stringify([run.id, run.updatedAt, text])} text={text} />
    );
  }
  return (
    <details>
      <summary>{t('common:technical_details')}</summary>
      <pre>{run.message}</pre>
      {run.runtime && <pre>{JSON.stringify(run.runtime, null, 2)}</pre>}
    </details>
  );
}
