import type { PendingAction, ActionOption } from '../../shared/types';
import { t } from '../i18n';

export function actionTitle(action: PendingAction) {
  if (action.requiresHumanApproval) return t('approvals:humanCommandApproval');
  switch (action.kind) {
    case 'command':
      return t('approvals:commandApproval');
    case 'file':
      return t('approvals:fileApproval');
    case 'permissions':
      return t('approvals:permissionsApproval');
    case 'questions':
      return t(
        action.status === 'pending' || action.status === 'responding'
          ? 'workspace:your_answer_is_needed'
          : 'workspace:questions_from_codex',
      );
    case 'network':
      return t('approvals:networkApproval', {
        target: action.title.slice(action.title.indexOf('：') + 1),
      });
    case 'elicitation':
      return t(
        action.elicitation?.approval ? 'approvals:mcpApproval' : 'approvals:mcpInteraction',
        { server: action.elicitation?.serverName ?? '' },
      );
    case 'unsupported':
      return t('approvals:unsupported');
  }
}

export function actionOptionLabel(action: PendingAction, option: ActionOption) {
  switch (option.id) {
    case 'accept':
      return t(action.kind === 'permissions' ? 'approvals:allowTask' : 'approvals:allow_once');
    case 'acceptForSession':
    case 'acceptSession':
      return t('approvals:allow_for_this_session');
    case 'decline':
      return t('approvals:denyDecision');
    case 'cancel':
      return t(
        action.kind === 'command' || action.kind === 'network' || action.kind === 'file'
          ? 'approvals:cancelTask'
          : 'common:cancel',
      );
    case 'acceptWithRule':
      return t('approvals:commandRule', {
        rule: option.label.slice(option.label.indexOf('：') + 1),
      });
    default:
      return option.id.startsWith('networkRule:')
        ? t('approvals:networkRule', { rule: option.label.slice(option.label.indexOf('：') + 1) })
        : option.label;
  }
}
