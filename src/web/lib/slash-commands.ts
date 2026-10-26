import { UNASSIGNED_SCOPE } from '../../shared/workspace-scope';
import { displayMessage } from '../i18n/messages';
import { errorMessage } from './error-message';
import { t } from '../i18n';
import type {
  Operation,
  Project,
  Settings,
  SystemInfo,
  ThreadView,
  ReviewTarget,
} from '../../shared/types';
import {
  threadNameError as originalThreadNameError,
  MAX_THREAD_NAME_CHARACTERS,
} from '../../shared/thread-name';
function threadNameError(name: string) {
  const problem = originalThreadNameError(name);
  if (!problem) return undefined;
  if (!name.trim()) return t('commands:renameEmpty');
  if ([...name.trim()].length > MAX_THREAD_NAME_CHARACTERS)
    return t('commands:renameLong', { max: MAX_THREAD_NAME_CHARACTERS });
  return t('commands:renameControls');
}
import { isActive } from '../components/Status';
import { compatibilityConfirmationRequired } from './compatibility';
import { blocksTarget, type SavedOperation } from './operations';
import type { ConnectionState } from './realtime';
import { readableError } from './utils';

export type SlashCommandName =
  | 'help'
  | 'new'
  | 'fork'
  | 'resume'
  | 'stop'
  | 'status'
  | 'compact'
  | 'plan'
  | 'init'
  | 'review'
  | 'rename'
  | 'export';

export interface SlashCommandResult {
  message: string;
  error?: boolean;
  draftKey?: string;
}

export interface SlashCommand {
  name: SlashCommandName;
  description: string;
  usage: string;
  unavailableReason?: string;
  run: (argumentsText?: string) => Promise<SlashCommandResult>;
}

/** A double slash escapes command mode; the composer removes one slash when sending. */
export function parseSlashCommand(text: string): { name: string; arguments: string } | null {
  const input = text.trimStart();
  if (!input.startsWith('/') || input.startsWith('//')) return null;
  const match = /^\/([^\s]*)(?:\s+([\s\S]*))?$/.exec(input)!;
  return { name: match[1]!.toLowerCase(), arguments: (match[2] ?? '').trim() };
}

export function filterSlashCommands(commands: SlashCommand[], input: string): SlashCommand[] {
  const parsed = parseSlashCommand(input);
  if (!parsed) return [];
  if (parsed.arguments) return commands.filter((command) => command.name === parsed.name);
  const rank = (command: SlashCommand) =>
    command.name === parsed.name ? 0 : command.name.startsWith(parsed.name) ? 1 : 2;
  return commands
    .filter(
      (command) =>
        command.name.includes(parsed.name) ||
        command.description.toLowerCase().includes(parsed.name),
    )
    .sort((a, b) => rank(a) - rank(b));
}

export function validateSlashCommand(input: string, commands: SlashCommand[]): string | undefined {
  const parsed = parseSlashCommand(input);
  if (!parsed) return undefined;
  const command = commands.find((entry) => entry.name === parsed.name);
  if (!command)
    return parsed.name
      ? t('commands:unknown_command_use_help_for_available_commands_or', { v0: parsed.name })
      : t('commands:select_a_command_or_type_help_for_available');
  if (command.name === 'rename') {
    const problem = threadNameError(parsed.arguments);
    if (problem) return problem;
  } else if (parsed.arguments && command.name !== 'plan' && command.name !== 'review')
    return t('commands:does_not_accept_arguments_usage', { v0: command.name, v1: command.usage });
  return command.unavailableReason;
}

export interface SlashCommandContext {
  project?: Project;
  scopeId?: string;
  selectedId?: string;
  thread?: ThreadView;
  system?: SystemInfo;
  connection: ConnectionState;
  authRequired: boolean;
  settings: Settings;
  openDraft: () => string;
  busy: string[];
  operations: SavedOperation[];
  run: (
    kind: string,
    target: string,
    path: string,
    body?: object,
  ) => Promise<Operation | undefined>;
  onResumeAttempt: () => void;
  refreshThread: () => Promise<unknown>;
  openStatus: () => void;
  exportThread: (threadId: string) => Promise<{ partial: boolean }>;
  selectPlan?: (task: string) => Promise<boolean>;
  initialize?: () => Promise<boolean>;
  chooseReviewTarget?: () => Promise<ReviewTarget | undefined>;
}

const definitions: { name: SlashCommandName; description: string }[] = [
  {
    name: 'help',
    get description() {
      return t('commands:view_supported_commands_and_usage');
    },
  },
  {
    name: 'new',
    get description() {
      return t('commands:open_a_new_session_draft_in_the_current');
    },
  },
  {
    name: 'fork',
    get description() {
      return t('commands:copy_saved_session_history_into_a_new_session');
    },
  },
  {
    name: 'resume',
    get description() {
      return t('commands:resume_the_selected_session_not_the_cli_session');
    },
  },
  {
    name: 'plan',
    get description() {
      return t('commands:planDescription');
    },
  },
  {
    name: 'review',
    get description() {
      return t('commands:reviewDescription');
    },
  },
  {
    name: 'init',
    get description() {
      return t('commands:initDescription');
    },
  },
  {
    name: 'rename',
    get description() {
      return t('commands:rename_this_session_spaces_are_allowed');
    },
  },
  {
    name: 'stop',
    get description() {
      return t('commands:request_interruption_of_the_current_task_web_shortcut');
    },
  },
  {
    name: 'status',
    get description() {
      return t('commands:open_connection_runtime_and_submission_diagnostics');
    },
  },
  {
    name: 'compact',
    get description() {
      return t('commands:compact_context_and_continue_in_this_session');
    },
  },
  {
    name: 'export',
    get description() {
      return t('commands:download_saved_session_history_as_markdown');
    },
  },
];

function unavailableReason(name: SlashCommandName, context: SlashCommandContext) {
  if (name === 'help' || name === 'status') return undefined;
  if (context.authRequired || context.connection === 'authenticationRequired')
    return t('commands:your_login_expired_log_in_again_and_retry');
  if (context.connection !== 'connected')
    return t('commands:you_are_offline_wait_for_the_connection_to');
  if (context.system?.authenticated === false)
    return t('commands:codex_is_not_logged_in_authenticate_first');
  if (!context.system?.ready) return t('commands:codex_is_unavailable_check_diagnostics_first');
  if (name === 'export') {
    if (!context.thread)
      return context.selectedId
        ? t('commands:session_loading_try_again_shortly')
        : t('commands:select_a_session_first');
    if (!context.system.capabilities.includes('thread/read'))
      return t('commands:this_codex_does_not_provide_thread_read');
    return undefined;
  }
  if (name !== 'stop' && compatibilityConfirmationRequired(context.system))
    return t('commands:confirm_the_codex_version_compatibility_notice_first');
  const capabilities = {
    init: 'turn/start',
    plan: 'turn/start',
    fork: 'thread/fork',
    resume: 'thread/resume',
    review: 'review/start',
    rename: 'thread/name/set',
    stop: 'turn/interrupt',
    compact: 'thread/compact/start',
  };
  if (name !== 'new' && !context.system.capabilities.includes(capabilities[name]))
    return t('commands:this_codex_does_not_provide', { v0: capabilities[name] });
  const busy = (kind: string, target: string) => context.busy.includes(`${kind}:${target}`);
  const unsettled = (target: string, kind?: string) =>
    context.operations.some(
      (entry) => (!kind || entry.kind === kind) && blocksTarget(entry, target),
    );
  const scope = context.scopeId ?? context.project?.id;
  if (name !== 'stop') {
    if (!context.project && scope !== UNASSIGNED_SCOPE) return t('commands:select_a_project_first');
    if (context.project && !context.project.available)
      return t('commands:the_project_directory_is_unavailable_check_project_configuration');
  }
  if (name === 'new') {
    if (context.busy.some((entry) => entry.startsWith('saveModelDefaults:')))
      return t('common:model_defaults_are_being_saved_wait_before_proceeding');
    if (busy('create', scope!)) return t('commands:creating_a_session_wait_for_the_receipt');
    if (unsettled(scope!)) return t('commands:session_creation_is_unconfirmed_use_status_to_check');
    return undefined;
  }
  const thread = context.thread;
  if (name === 'plan' || name === 'init') {
    const blocked = t(name === 'plan' ? 'commands:planUnavailable' : 'commands:initUnavailable');
    if ((name === 'plan' && !context.selectPlan) || (name === 'init' && !context.initialize))
      return blocked;
    if (context.busy.some((entry) => entry.startsWith('saveModelDefaults:'))) return blocked;
    if (busy('create', scope!) || unsettled(scope!)) return blocked;
    if (!thread)
      return context.selectedId ? t('commands:session_loading_try_again_shortly') : undefined;
    if (
      thread.archived ||
      !thread.managed ||
      thread.status === 'unknown' ||
      unsettled(thread.id) ||
      isActive(thread.status) ||
      thread.turns.some((turn) => isActive(turn.status)) ||
      (thread.execution && !thread.execution.ended)
    )
      return blocked;
    return undefined;
  }
  if (!thread)
    return context.selectedId
      ? t('commands:session_loading_try_again_shortly')
      : t('commands:select_a_session_first');
  if (name === 'compact') {
    if (thread.archived) return t('commands:unarchive_before_compacting_context');
    if (!thread.managed) return t('commands:resume_this_session_before_compacting_context');
    if (!thread.turns.length) return t('commands:this_session_is_empty_there_is_no_context');
    if (busy('compact', thread.id)) return t('commands:submitting_compaction_wait_for_the_receipt');
    if (isActive(thread.status) || thread.turns.some((turn) => isActive(turn.status)))
      return t('commands:wait_for_this_task_to_finish_before_compacting');
    if (
      thread.status === 'unknown' ||
      (thread.execution && !thread.execution.ended) ||
      unsettled(thread.id)
    )
      return t('commands:an_execution_still_needs_checking_use_status_to');
    return undefined;
  }
  if (name === 'review') {
    if (thread.archived) return t('commands:this_session_is_archived_unarchive_it_first');
    if (!thread.managed) return t('commands:resume_this_session_before_starting_code_review');
    if (busy('review', thread.id)) return t('commands:submitting_code_review_wait_for_the_receipt');
    if (unsettled(thread.id) || thread.status === 'unknown')
      return t('commands:this_session_has_an_unconfirmed_request_use_status');
    if (isActive(thread.status) || thread.turns.some((turn) => isActive(turn.status)))
      return t('commands:wait_for_this_task_to_finish_before_starting');
    if (thread.execution && !thread.execution.ended)
      return t('commands:this_session_is_still_occupied_by_an_execution');
    return undefined;
  }
  if (name === 'rename') {
    if (thread.archived) return t('commands:unarchive_and_resume_this_session_before_renaming');
    if (!thread.managed)
      return t('commands:resume_this_session_before_renaming_sessions_occupied_by');
    if (busy('rename', thread.id)) return t('commands:renaming_wait_for_the_receipt');
    if (unsettled(thread.id, 'rename'))
      return t('commands:rename_is_unconfirmed_use_status_to_check_the');
    if (busy('archive', thread.id) || unsettled(thread.id, 'archive'))
      return t('commands:archiving_is_unconfirmed_use_status_to_check_the');
    return undefined;
  }
  if (name === 'fork') {
    if (!thread.turns.length) return t('commands:this_session_is_empty_send_the_first_message');
    if (busy('fork', thread.id)) return t('commands:forking_session_wait_for_the_receipt');
    if (unsettled(thread.id, 'fork'))
      return t('commands:fork_request_unconfirmed_use_status_to_check_the');
    return undefined;
  }
  if (name === 'resume') {
    if (busy('resume', thread.id)) return t('commands:resuming_session_wait_for_the_receipt');
    if (unsettled(thread.id))
      return t('commands:this_session_has_an_unconfirmed_request_use_status');
    if (
      thread.managed &&
      (thread.turns.some((turn) => isActive(turn.status)) || isActive(thread.status))
    )
      return t('commands:this_session_is_running_wait_for_it_to');
    if (thread.execution && !thread.execution.ended)
      return t('commands:this_session_is_still_occupied_by_an_execution');
    if (thread.managed) return t('commands:this_session_is_already_resumed');
    // A previous writer conflict is retryable: Codex checks whether the owner has since released it.
    return undefined;
  }
  if (!thread.managed)
    return thread.resumeError?.code === 'THREAD_IN_USE'
      ? t('commands:another_process_is_using_this_session_its_task')
      : t('commands:this_session_has_not_been_resumed_tasks_in');
  if (busy('interrupt', thread.id))
    return t('commands:submitting_interrupt_request_wait_for_the_receipt');
  if (unsettled(thread.id, 'interrupt'))
    return t('commands:interrupt_request_unconfirmed_use_status_to_check_the');
  if (!thread.turns.some((turn) => isActive(turn.status)))
    return thread.status === 'unknown' || (thread.execution && !thread.execution.ended)
      ? t('commands:task_state_is_unconfirmed_use_status_to_check')
      : t('commands:this_session_has_no_task_to_interrupt');
  return undefined;
}

function operationResult(name: SlashCommandName, operation?: Operation): SlashCommandResult {
  if (!operation)
    return {
      error: true,
      get message() {
        return displayMessage(t('commands:no_confirmed_success_receipt_received_check_errors_or'));
      },
    };
  if (operation.status === 'failed')
    return {
      error: true,
      get message() {
        return displayMessage(
          (operation.error ? errorMessage(operation.error) : undefined) ??
            t('commands:operation_failed_check_diagnostics'),
        );
      },
    };
  if (operation.status !== 'acknowledged')
    return {
      error: true,
      get message() {
        return displayMessage(
          t('commands:submission_result_unconfirmed_use_status_before_submitting_again'),
        );
      },
    };
  if (name === 'compact')
    return {
      get message() {
        return displayMessage(t('commands:context_compaction_requested_follow_task_status_in_the'));
      },
    };
  if (name === 'rename') {
    const result = operation.result as { name?: unknown } | undefined;
    return typeof result?.name === 'string' && result.name
      ? {
          get message() {
            return displayMessage(t('commands:session_renamed_to', { v0: result.name }));
          },
        }
      : {
          error: true,
          get message() {
            return displayMessage(t('commands:rename_accepted_but_the_name_is_unconfirmed_use'));
          },
        };
  }
  if (name === 'fork') {
    const result = operation.result as
      { threadId?: unknown; id?: unknown; thread?: { id?: unknown } } | undefined;
    const id = result?.threadId ?? result?.thread?.id;
    if (typeof id !== 'string' || !id)
      return {
        error: true,
        get message() {
          return displayMessage(t('commands:request_accepted_but_no_new_session_id_received'));
        },
      };
    return {
      get message() {
        return displayMessage(t('commands:forked_into_a_new_session'));
      },
      draftKey: id,
    };
  }
  return {
    get message() {
      return displayMessage(
        name === 'review'
          ? t('commands:code_review_submitted_view_progress_and_results_in')
          : name === 'stop'
            ? t('commands:interrupt_requested_wait_for_task_status_to_update')
            : t('commands:selected_session_resumed'),
      );
    },
  };
}

function commandUsage(name: SlashCommandName): string {
  if (name === 'rename') return t('commands:rename_name');
  if (name === 'plan') return t('commands:planUsage');
  if (name === 'review') return t('commands:reviewUsage');
  return t('commands:no_arguments', { v0: name });
}

/** Menu availability and execution share guards; re-read state before each dispatch. */
export function createSlashCommands(getContext: () => SlashCommandContext): SlashCommand[] {
  const initial = getContext();
  return definitions.map(({ name, description }) => ({
    name,
    description,
    usage: commandUsage(name),
    unavailableReason: unavailableReason(name, initial),
    run: async (argumentsText = '') => {
      const context = getContext();
      if (name === 'help')
        return {
          get message() {
            return displayMessage(
              t('commands:rename_requires_a_name_other_commands_take_no', {
                v0: definitions
                  .map((entry) =>
                    t('commands:commandLine', {
                      name: commandUsage(entry.name).slice(1),
                      arguments: '',
                      description: entry.description,
                    }),
                  )
                  .join('\n'),
              }),
            );
          },
        };
      if (name === 'status') {
        context.openStatus();
        return {
          get message() {
            return displayMessage(
              t('commands:diagnostics_opened_refresh_status_or_reconcile_submissions_in'),
            );
          },
        };
      }
      if (
        (context.scopeId ?? context.project?.id) !== (initial.scopeId ?? initial.project?.id) ||
        context.selectedId !== initial.selectedId
      )
        return {
          error: true,
          get message() {
            return displayMessage(t('commands:the_project_or_session_changed_select_the_command'));
          },
        };
      const reason = unavailableReason(name, context);
      if (reason)
        return {
          error: true,
          get message() {
            return displayMessage(reason);
          },
        };
      if (name === 'rename') {
        const problem = threadNameError(argumentsText);
        if (problem)
          return {
            error: true,
            get message() {
              return displayMessage(problem);
            },
          };
      }
      const thread = context.thread;
      const path = `/api/threads/${encodeURIComponent(thread?.id ?? '')}`;
      try {
        if (name === 'init') {
          const submitted = await context.initialize!();
          return {
            error: !submitted,
            get message() {
              return t(submitted ? 'commands:initSubmitted' : 'commands:planNotSubmitted');
            },
          };
        }
        if (name === 'plan') {
          const selected = await context.selectPlan!(argumentsText);
          return {
            error: !selected,
            get message() {
              return displayMessage(
                t(
                  !selected
                    ? 'commands:planNotSubmitted'
                    : argumentsText
                      ? 'commands:planSubmitted'
                      : 'commands:planSelected',
                ),
              );
            },
          };
        }
        if (name === 'export') {
          const { partial } = await context.exportThread(thread!.id);
          return {
            get message() {
              return displayMessage(
                partial
                  ? t('commands:markdown_download_started_some_content_is_unfinished_unconfirmed')
                  : t('commands:saved_history_download_started_the_file_describes_omitted'),
              );
            },
          };
        }
        let operation: Operation | undefined;
        if (name === 'new') {
          return {
            draftKey: context.openDraft(),
            get message() {
              return displayMessage(t('commands:new_session_draft_opened_a_session_will_be'));
            },
          };
        } else if (name === 'fork') {
          operation = await context.run('fork', thread!.id, `${path}/fork`, {
            settings: context.settings,
          });
        } else if (name === 'review') {
          const target: ReviewTarget | undefined = argumentsText
            ? { type: 'custom', instructions: argumentsText }
            : context.chooseReviewTarget
              ? await context.chooseReviewTarget()
              : { type: 'uncommittedChanges' };
          if (!target) return { error: true, message: t('commands:reviewCancelled') };
          const current = getContext();
          if (
            current.selectedId !== context.selectedId ||
            (current.scopeId ?? current.project?.id) !== (context.scopeId ?? context.project?.id) ||
            unavailableReason('review', current)
          )
            return {
              error: true,
              message: t('commands:the_project_or_session_changed_select_the_command'),
            };
          operation = await current.run('review', thread!.id, `${path}/review`, { target });
        } else if (name === 'rename') {
          operation = await context.run('rename', thread!.id, `${path}/rename`, {
            name: argumentsText.trim(),
          });
        } else if (name === 'resume') {
          context.onResumeAttempt();
          operation = await context.run('resume', thread!.id, `${path}/resume`);
          await context.refreshThread();
        } else if (name === 'compact') {
          operation = await context.run('compact', thread!.id, `${path}/compact`);
        } else {
          const turn = thread!.turns.findLast((entry) => isActive(entry.status))!;
          operation = await context.run('interrupt', thread!.id, `${path}/interrupt`, {
            expectedTurnId: turn.id,
          });
        }
        return operationResult(name, operation);
      } catch (error) {
        return {
          error: true,
          get message() {
            return displayMessage(readableError(error));
          },
        };
      }
    },
  }));
}
