import { filterSkills, type SkillMetadata, type SkillReference } from '../../shared/skills';
import {
  skillTrigger,
  editBindings,
  selectedReferences,
  removeSkillBinding,
  replaceSkillRange,
  skillSourceLabel,
} from '../lib/skill-references';
import { SkillReferenceMenu } from './SkillReferenceMenu';
import { useSkills } from '../lib/skills';
import { SkillsBrowser } from './SkillsBrowser';
import { UNASSIGNED_SCOPE } from '../../shared/workspace-scope';
import { errorMessage } from '../lib/error-message';
import { message, displayMessage } from '../i18n/messages';
import { t } from '../i18n';
import { useEffect, useLayoutEffect, useId, useRef, useState, type ClipboardEvent } from 'react';
import { emptyDraft, imagePasteError, readImage, type MessageDraft } from '../lib/image-paste';
import type {
  ModelDefaults,
  ModelDefaultsResult,
  ModelInfo,
  Settings,
  ThreadView,
} from '../../shared/types';
import { isActive } from './Status';
import { Button } from './ui/button';
import { Icon } from './Icon';
import { SettingsPanel } from './SettingsPanel';
import { SlashCommandMenu } from './SlashCommandMenu';
import {
  filterSlashCommands,
  parseSlashCommand,
  validateSlashCommand,
  type SlashCommand,
  type SlashCommandResult,
} from '../lib/slash-commands';
import { ControlHint } from './ControlHint';
import type { SentDraft } from '../lib/conversation-drafts';
import { useUpgradeReloadState } from '../lib/upgrade-reload';
import { ComposerResizeHandle } from './ComposerResizeHandle';
import { usesMobileInput } from '../lib/mobile-input';
import { IMAGE_TYPES } from '../../shared/images';

interface Props {
  focusRequest?: number;
  skillsRequest?: number;
  commands: SlashCommand[];
  thread?: ThreadView;
  threadLoading?: boolean;
  draftKey: string;
  draftCreationId: string;
  skillsUnavailable?: string;
  sentDrafts: Record<string, SentDraft>;
  projectName?: string;
  projectId?: string;
  runtimeKey?: string;
  settings: Settings;
  models: ModelInfo[];
  onSettings: (settings: Settings) => void;
  onSaveModelDefaults: (settings: ModelDefaults) => Promise<ModelDefaultsResult | undefined>;
  savingModelDefaults: boolean;
  onSend: (
    text: string,
    steer: boolean,
    images?: string[],
    skills?: SkillReference[],
  ) => Promise<boolean>;
  onInterrupt: () => void;
  onResume: () => void;
  canResume: boolean;
  resumeAttempted: boolean;
  disabled: boolean;
  canInterrupt: boolean;
  submitting: boolean;
  interrupting: boolean;
  resuming: boolean;
  canFork: boolean;
  forking: boolean;
  onFork: () => void;
}
export function Composer(props: Props) {
  const mobileInput = usesMobileInput(navigator);
  const [drafts, setDrafts] = useState<Record<string, MessageDraft>>({});
  const draftsRef = useRef(drafts);
  const shortcutId = useId();
  const composingRef = useRef(false);
  useUpgradeReloadState(
    'composer',
    () => {
      if (
        composingRef.current ||
        Object.values(draftsRef.current).some((draft) =>
          draft.images.some((image) => !image.dataUrl),
        )
      )
        throw new Error(t('composer:an_update_will_load_automatically_once_typing_or'));
      return draftsRef.current;
    },
    (saved) => {
      draftsRef.current = { ...saved, ...draftsRef.current };
      setDrafts(draftsRef.current);
    },
  );
  const compositionEndedAtRef = useRef(-Infinity);
  const sendingRef = useRef(new Set<string>());
  const submittedDrafts = useRef(new Map<string, MessageDraft>());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickerDraftKey = useRef<string | undefined>(undefined);
  const imageFiles = useRef(new Map<string, File>());
  useEffect(() => {
    if (props.focusRequest) textareaRef.current?.focus();
  }, [props.focusRequest]);
  const inputId = useId();
  const menuId = useId();
  const [focused, setFocused] = useState(false);
  const [menu, setMenu] = useState({ key: '', text: '', selectedIndex: 0, dismissed: false });
  const [feedback, setFeedback] = useState<Record<string, SlashCommandResult>>({});
  const [commandPending, setCommandPending] = useState<string[]>([]);
  const [caret, setCaret] = useState({ key: '', start: 0, end: 0 });
  const [skillMenu, setSkillMenu] = useState({ identity: '', selected: 0, dismissed: false });
  const skillMenuId = useId();
  const skillCaret = useRef<{ key: string; text: string; position: number } | undefined>(undefined);
  const key = props.draftKey;
  const skillsScope = JSON.stringify([props.projectId, props.thread?.id, key]);
  const [skillsOpen, setSkillsOpen] = useState<string>();
  useEffect(() => {
    if (props.skillsRequest) setSkillsOpen(skillsScope);
  }, [props.skillsRequest]);
  const draft = drafts[key] ?? emptyDraft;
  useLayoutEffect(() => {
    const pending = skillCaret.current;
    if (!pending || pending.key !== key || pending.text !== draft.text) return;
    skillCaret.current = undefined;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(pending.position, pending.position);
  }, [key, draft.text]);
  const trigger = caret.key === key ? skillTrigger(draft.text, caret.start, caret.end) : undefined;
  const skillIdentity = JSON.stringify([skillsScope, draft.text, caret.start, caret.end]);
  const skillMenuOpen = Boolean(
    trigger &&
    focused &&
    !parseSlashCommand(draft.text) &&
    !(skillMenu.identity === skillIdentity && skillMenu.dismissed),
  );
  const skills = useSkills(
    (skillsOpen === skillsScope || skillMenuOpen) && props.projectId && !props.threadLoading
      ? {
          projectId: props.projectId === UNASSIGNED_SCOPE ? null : props.projectId,
          ...(props.thread ? { threadId: props.thread.id } : { draftId: props.draftCreationId }),
        }
      : undefined,
    props.runtimeKey,
  );
  const consumedReceipts = useRef(new WeakSet<SentDraft>());
  useEffect(() => {
    for (const sent of Object.values(props.sentDrafts)) {
      if (consumedReceipts.current.has(sent)) continue;
      consumedReceipts.current.add(sent);
      if (
        submittedDrafts.current.get(sent.key)?.text.replace(/^(\s*)\/\//, '$1/') === sent.text &&
        JSON.stringify(selectedReferences(submittedDrafts.current.get(sent.key)?.skills)) ===
          JSON.stringify(sent.skills ?? [])
      )
        clearSubmittedDraft(sent.key);
    }
  }, [props.sentDrafts]);
  useEffect(() => {
    composingRef.current = false;
    compositionEndedAtRef.current = -Infinity;
    setMenu({ key: '', text: '', selectedIndex: 0, dismissed: false });
  }, [key]);
  const skillMatches = filterSkills(
    skills.catalog?.skills.filter(
      (skill) =>
        skill.enabled && !skills.catalog?.errors.some((error) => error.path === skill.path),
    ) ?? [],
    trigger?.search ?? '',
  );
  const skillSelected = Math.min(
    skillMenu.identity === skillIdentity ? skillMenu.selected : 0,
    Math.max(0, skillMatches.length - 1),
  );
  function chooseSkill(skill: SkillMetadata) {
    if (!trigger || !skills.catalog || composingRef.current) return;
    const token = `$${skill.name}`;
    const next = draft.text.slice(0, trigger.start) + token + ' ' + draft.text.slice(trigger.end);
    if (next.length > 100000) return;
    skillCaret.current = { key, text: next, position: trigger.start + token.length + 1 };
    updateDraft(key, (previous) => ({
      ...previous,
      text: next,
      skills: [
        ...replaceSkillRange(
          previous.text,
          trigger.start,
          trigger.end,
          token + ' ',
          previous.skills,
        ).skills,
        {
          name: skill.name,
          path: skill.path,
          cwd: skills.catalog!.cwd,
          start: trigger.start,
          end: trigger.start + token.length,
        },
      ],
    }));
    const position = trigger.start + token.length + 1;
    setCaret({ key, start: position, end: position });
    setSkillMenu({ identity: skillIdentity, selected: 0, dismissed: true });
  }
  const { text, images } = draft;
  const slash = parseSlashCommand(text);
  const matches = filterSlashCommands(props.commands, text);
  const currentMenu = menu.key === key && menu.text === text ? menu : undefined;
  const selectedIndex = Math.min(currentMenu?.selectedIndex ?? 0, Math.max(0, matches.length - 1));
  const menuOpen = Boolean(slash && focused && !currentMenu?.dismissed);
  const selectedCommand = menuOpen
    ? matches[selectedIndex]
    : props.commands.find((command) => command.name === slash?.name);
  const executingCommand = commandPending.includes(key);
  const inputHint = mobileInput
    ? slash
      ? t('composer:tap_to_run_command_enter_for_new_line')
      : t('composer:tap_to_send_enter_for_new_line')
    : slash
      ? t('composer:enter_to_run_command_esc_to_close_menu')
      : t('composer:enter_to_send_shift_enter_for_a_new');
  function selectCommand(index: number) {
    setMenu({ key, text, selectedIndex: index, dismissed: false });
  }
  function dismissMenu() {
    setMenu({ key, text, selectedIndex, dismissed: true });
  }
  async function executeCommand(command?: SlashCommand) {
    if (sendingRef.current.has(key) || composingRef.current) return;
    const current = draftsRef.current[key] ?? emptyDraft;
    const parsed = parseSlashCommand(current.text);
    if (!parsed) return;
    // Selection completes the name only. Arguments must still be validated and never discarded.
    const input = command
      ? `/${command.name}${parsed.arguments ? ` ${parsed.arguments}` : ''}`
      : current.text;
    const problem = current.skills?.length
      ? t('composer:skills_slash')
      : current.images.length
        ? t('composer:slash_commands_cannot_include_images_remove_the_images')
        : validateSlashCommand(input, props.commands);
    if (problem) {
      setFeedback((previous) => ({ ...previous, [key]: { message: problem, error: true } }));
      return;
    }
    const chosen = props.commands.find((entry) => entry.name === parseSlashCommand(input)?.name);
    if (!chosen) return;
    sendingRef.current.add(key);
    setCommandPending((previous) => [...previous, key]);
    setFeedback((previous) => ({
      ...previous,
      [key]: { message: message('composer:running', { v0: chosen.name }) },
    }));
    dismissMenu();
    try {
      const result = await chosen.run(parseSlashCommand(input)?.arguments);
      setFeedback((previous) => ({ ...previous, [key]: result, [result.draftKey ?? key]: result }));
      if (!result.error) {
        updateDraft(key, (previous) => ({
          ...previous,
          text: previous.text === current.text ? '' : previous.text,
        }));
      }
    } catch (error) {
      setFeedback((previous) => ({
        ...previous,
        [key]: {
          error: true,
          message:
            error instanceof Error
              ? error.message
              : message('composer:command_failed_please_try_again'),
        },
      }));
    } finally {
      sendingRef.current.delete(key);
      setCommandPending((previous) => previous.filter((entry) => entry !== key));
    }
  }
  const readingImages = images.some((image) => !image.dataUrl);
  function updateDraft(draftKey: string, update: (draft: MessageDraft) => MessageDraft) {
    const next = {
      ...draftsRef.current,
      [draftKey]: update(draftsRef.current[draftKey] ?? emptyDraft),
    };
    draftsRef.current = next;
    setDrafts(next);
  }
  function clearSubmittedDraft(draftKey: string) {
    const sent = submittedDrafts.current.get(draftKey);
    if (!sent) return;
    submittedDrafts.current.delete(draftKey);
    sent.images.forEach((image) => imageFiles.current.delete(image.id));
    updateDraft(draftKey, (previous) => ({
      text: previous.text === sent.text && previous.skills === sent.skills ? '' : previous.text,
      skills: previous.text === sent.text && previous.skills === sent.skills ? [] : previous.skills,
      images: previous.images.filter(
        (image) => !sent.images.some((entry) => entry.id === image.id),
      ),
      error: previous.error === sent.error ? undefined : previous.error,
    }));
  }
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (event.defaultPrevented) return;
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
    // Plain text continues through the browser's native paste and IME handling.
    event.preventDefault();
    addImages(files, key, {
      text: event.clipboardData.getData('text/plain'),
      start: event.currentTarget.selectionStart,
      end: event.currentTarget.selectionEnd,
    });
  }
  function addImages(
    files: File[],
    draftKey: string,
    pasted?: { text: string; start: number; end: number },
  ) {
    if (!files.length) return;
    const current = draftsRef.current[draftKey] ?? emptyDraft;
    const error = imagePasteError(files, current.images);
    if (error) {
      updateDraft(draftKey, (previous) => ({ ...previous, error }));
      return;
    }
    const added = files.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name || t('composer:pasted_image'),
      size: file.size,
    }));
    updateDraft(draftKey, (previous) => ({
      ...previous,
      skills: pasted?.text
        ? editBindings(
            previous.text,
            (
              previous.text.slice(0, pasted.start) +
              pasted.text +
              previous.text.slice(pasted.end)
            ).slice(0, 100000),
            previous.skills,
            Math.min(pasted.start + pasted.text.length, 100000),
          )
        : previous.skills,
      text: pasted?.text
        ? (
            previous.text.slice(0, pasted.start) +
            pasted.text +
            previous.text.slice(pasted.end)
          ).slice(0, 100000)
        : previous.text,
      images: [...previous.images, ...added],
    }));
    files.forEach((file, index) => {
      const id = added[index]!.id;
      imageFiles.current.set(id, file);
      loadImage(draftKey, id, file);
    });
  }
  function loadImage(draftKey: string, id: string, file: File) {
    updateDraft(draftKey, (previous) => ({
      ...previous,
      error: undefined,
      images: previous.images.map((image) =>
        image.id === id ? { ...image, failed: false } : image,
      ),
    }));
    void readImage(file).then(
      (dataUrl) => {
        imageFiles.current.delete(id);
        updateDraft(draftKey, (previous) => ({
          ...previous,
          images: previous.images.map((image) => (image.id === id ? { ...image, dataUrl } : image)),
        }));
      },
      () =>
        updateDraft(draftKey, (previous) =>
          previous.images.some((image) => image.id === id)
            ? {
                ...previous,
                images: previous.images.map((image) =>
                  image.id === id ? { ...image, failed: true } : image,
                ),
                error: t('composer:image_read_failed'),
              }
            : previous,
        ),
    );
  }
  const active = Boolean(
    props.thread?.managed &&
    isActive(props.thread.status) &&
    props.thread.capacityRetry?.status !== 'waiting',
  );
  const skillSteeringBlocked = active && Boolean(draft.skills?.length);
  const external = props.thread && !props.thread.managed && !props.thread.archived;
  const resumeError = external ? props.thread?.resumeError : undefined;
  const occupied = resumeError?.code === 'THREAD_IN_USE';
  const canSend = Boolean(
    (props.thread || props.projectId) &&
    !props.threadLoading &&
    !external &&
    (text.trim() || images.length) &&
    !readingImages &&
    !skillSteeringBlocked &&
    !props.disabled &&
    !props.submitting,
  );
  async function send() {
    if (composingRef.current) return;
    // Every submission path, including the button and a dismissed menu, uses this dispatcher.
    if (slash) {
      await executeCommand(menuOpen ? matches[selectedIndex] : undefined);
      return;
    }
    if (!canSend || sendingRef.current.has(key)) return;
    const current = draftsRef.current[key] ?? emptyDraft;
    if (!current.text.trim() && !current.images.length) return;
    if (current.images.some((image) => !image.dataUrl)) return;
    sendingRef.current.add(key);
    submittedDrafts.current.set(key, current);
    const sent = current.text;
    const sentImages = current.images;
    try {
      if (
        await props.onSend(
          sent.replace(/^(\s*)\/\//, '$1/'),
          active,
          sentImages.length ? sentImages.map((image) => image.dataUrl!) : undefined,
          current.skills?.length ? selectedReferences(current.skills) : undefined,
        )
      )
        clearSubmittedDraft(key);
    } finally {
      sendingRef.current.delete(key);
    }
  }
  return (
    <div className="composer-region" data-mobile-input={mobileInput || undefined}>
      {skillsOpen === skillsScope && (
        <SkillsBrowser
          key={skillsScope}
          skills={skills}
          unavailable={props.skillsUnavailable}
          onClose={() => setSkillsOpen(undefined)}
        />
      )}
      {props.submitting && (
        <p className="composer-resume-status" role="status">
          <Icon name="refresh" size={14} />
          {props.thread
            ? t('composer:submitting_message')
            : t('composer:creating_a_session_and_sending_the_first_message')}
        </p>
      )}
      {external && props.resuming && (
        <p className="composer-resume-status" role="status">
          <Icon name="refresh" size={14} />
          {t('composer:resuming_session')}
        </p>
      )}
      {external && props.resumeAttempted && !props.resuming && !resumeError && props.canResume && (
        <Button size="sm" variant="secondary" onClick={props.onResume}>
          {t('composer:retry_resume')}
        </Button>
      )}
      {resumeError && !props.resuming && (
        <div className="session-resume-notice" role="status">
          <strong>
            {occupied
              ? t('composer:this_session_is_in_use_by_another_process')
              : t('composer:unable_to_resume_session')}
          </strong>
          <p>
            {occupied
              ? t('composer:fork_saved_history_to_continue_or_retry_once')
              : displayMessage(errorMessage(resumeError))}
          </p>
          {!occupied && (
            <details className="raw-details">
              <summary>{t('common:technical_details')}</summary>
              <pre>{resumeError.message}</pre>
            </details>
          )}
          {occupied && (
            <Button size="sm" variant="secondary" disabled={!props.canFork} onClick={props.onFork}>
              <Icon name="fork" size={14} />
              {props.forking ? t('common:confirming_fork') : t('common:fork_into_a_new_session')}
            </Button>
          )}
          <Button size="sm" disabled={!props.canResume} onClick={props.onResume}>
            {t('composer:retry_resume')}
          </Button>
        </div>
      )}
      <div className="composer-box">
        <ComposerResizeHandle textareaRef={textareaRef} inputId={inputId} />
        {feedback[key] && (
          <p className="slash-feedback" role={feedback[key].error ? 'alert' : 'status'}>
            {displayMessage(feedback[key].message)}
          </p>
        )}
        {menuOpen && (
          <SlashCommandMenu
            mobileInput={mobileInput}
            id={menuId}
            commands={matches}
            selectedIndex={selectedIndex}
            onSelect={selectCommand}
            onExecute={(command) => {
              textareaRef.current?.focus();
              void executeCommand(command);
            }}
          />
        )}
        {skillMenuOpen && (
          <SkillReferenceMenu
            id={skillMenuId}
            skills={skills}
            matches={skillMatches}
            selected={skillSelected}
            unavailable={props.skillsUnavailable}
            onSelect={(selected) =>
              setSkillMenu({ identity: skillIdentity, selected, dismissed: false })
            }
            onChoose={chooseSkill}
          />
        )}
        {!!draft.skills?.length && (
          <ul className="composer-skills" aria-label={t('composer:skills_selected')}>
            {selectedReferences(draft.skills).map((skill) => (
              <li key={JSON.stringify([skill.name, skill.path])}>
                <details>
                  <summary title={skill.path} aria-label={`$${skill.name} · ${skill.path}`}>
                    <Icon name="code" size={14} />
                    <strong>${skill.name}</strong>
                    <span className="skill-chip-source">
                      {skillSourceLabel(skill, skill.cwd, selectedReferences(draft.skills))}
                    </span>
                    <Icon name="down" size={11} />
                  </summary>
                  <p className="skills-path">{skill.path}</p>
                </details>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t('composer:skills_remove', { name: skill.name })}
                  onClick={() =>
                    updateDraft(key, (previous) => ({
                      ...previous,
                      ...removeSkillBinding(previous.text, previous.skills ?? [], skill),
                    }))
                  }
                >
                  <Icon name="close" size={13} />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {skillSteeringBlocked && (
          <p className="slash-feedback" role="status">
            {t('composer:skills_steer_unsupported')}
          </p>
        )}
        {images.length > 0 && (
          <ul className="composer-images" aria-label={t('composer:images_to_send')}>
            {images.map((image, index) => (
              <li key={image.id}>
                {image.dataUrl ? (
                  <img src={image.dataUrl} alt={t('composer:image_to_send', { v0: index + 1 })} />
                ) : image.failed ? (
                  <button
                    type="button"
                    className="composer-image-retry"
                    onClick={() => {
                      const file = imageFiles.current.get(image.id);
                      if (file) loadImage(key, image.id, file);
                    }}
                  >
                    {t('composer:retry_image')}
                  </button>
                ) : (
                  <span role="status">{t('common:loading_2')}</span>
                )}
                <ControlHint asChild content={image.name}>
                  <span className="composer-image-name">{image.name}</span>
                </ControlHint>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={t('composer:remove_image', { v0: index + 1 })}
                  onClick={() => {
                    imageFiles.current.delete(image.id);
                    updateDraft(key, (previous) => ({
                      ...previous,
                      error: undefined,
                      images: previous.images.filter((entry) => entry.id !== image.id),
                    }));
                  }}
                >
                  <Icon name="close" size={13} />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {draft.error && (
          <p className="composer-image-error" role="alert">
            {displayMessage(draft.error)}
          </p>
        )}
        <textarea
          id={inputId}
          ref={textareaRef}
          enterKeyHint={mobileInput ? 'enter' : undefined}
          aria-describedby={shortcutId}
          aria-label={active ? t('composer:additional_instructions') : t('composer:task_content')}
          aria-haspopup="listbox"
          aria-controls={skillMenuOpen ? skillMenuId : menuOpen ? menuId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            skillMenuOpen && skillMatches[skillSelected]
              ? `${skillMenuId}-${skillSelected}`
              : menuOpen && matches[selectedIndex]
                ? `${menuId}-${matches[selectedIndex].name}`
                : undefined
          }
          value={text}
          readOnly={Boolean(props.thread?.archived)}
          placeholder={
            props.thread?.archived
              ? t('composer:unarchive_to_continue_the_conversation')
              : active
                ? t('composer:add_requirements_or_adjust_direction')
                : t('composer:describe_a_task_paste_an_image_or_type')
          }
          maxLength={100000}
          onChange={(event) => {
            updateDraft(key, (previous) => ({
              ...previous,
              text: event.target.value,
              skills: editBindings(
                previous.text,
                event.target.value,
                previous.skills,
                event.target.selectionStart,
              ),
            }));
            setCaret({ key, start: event.target.selectionStart, end: event.target.selectionEnd });
            setSkillMenu({ identity: '', selected: 0, dismissed: false });
            setMenu({ key, text: event.target.value, selectedIndex: 0, dismissed: false });
            setFeedback((previous) => {
              const next = { ...previous };
              delete next[key];
              return next;
            });
          }}
          onSelect={(event) =>
            setCaret({
              key,
              start: event.currentTarget.selectionStart,
              end: event.currentTarget.selectionEnd,
            })
          }
          onPaste={paste}
          onFocus={() => setFocused(true)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            compositionEndedAtRef.current = performance.now();
          }}
          onBlur={() => {
            setFocused(false);
            composingRef.current = false;
            compositionEndedAtRef.current = -Infinity;
          }}
          onKeyDown={(event) => {
            // A hovered Tooltip consumes Escape during document capture. The
            // focused editor must still close its own Slash menu on that key.
            if (event.defaultPrevented && !((menuOpen || skillMenuOpen) && event.key === 'Escape'))
              return;
            // Let the browser insert newlines, including immediately after an IME
            // commit. Mobile Enter must never reach the submission dispatcher.
            if (mobileInput && event.key === 'Enter') return;
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229 ||
              composingRef.current
            )
              return;
            // Some IMEs end composition before the confirming Enter keydown.
            // Keyup releases this guard; the time limit also allows mouse commits.
            if (performance.now() - compositionEndedAtRef.current < 100) {
              if (event.key === 'Enter' && !event.shiftKey) event.preventDefault();
              return;
            }
            if (
              skillMenuOpen &&
              !event.shiftKey &&
              !event.altKey &&
              !event.metaKey &&
              !event.ctrlKey
            ) {
              if (event.key === 'Escape') {
                event.preventDefault();
                setSkillMenu({ identity: skillIdentity, selected: skillSelected, dismissed: true });
                return;
              }
              if (skillMatches.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                setSkillMenu({
                  identity: skillIdentity,
                  selected:
                    (skillSelected + (event.key === 'ArrowDown' ? 1 : -1) + skillMatches.length) %
                    skillMatches.length,
                  dismissed: false,
                });
                return;
              }
              if (skillMatches.length && (event.key === 'Enter' || event.key === 'Tab')) {
                event.preventDefault();
                if (!event.repeat) chooseSkill(skillMatches[skillSelected]!);
                return;
              }
            }
            if (menuOpen && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (matches.length)
                  selectCommand(
                    (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) %
                      matches.length,
                  );
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                dismissMenu();
                return;
              }
            }
            if (event.key !== 'Enter' || event.shiftKey) return;
            event.preventDefault();
            if (event.repeat) return;
            void send();
          }}
          onKeyUp={(event) => {
            if (event.key === 'Enter') compositionEndedAtRef.current = -Infinity;
          }}
          rows={3}
        />
        {mobileInput && <p className="composer-input-hint">{inputHint}</p>}
        <SettingsPanel
          attachmentControl={
            <ControlHint content={t('composer:add_images')}>
              <Button
                type="button"
                className="composer-attach"
                variant="ghost"
                size="sm"
                aria-label={t('composer:add_images')}
                disabled={
                  props.disabled ||
                  Boolean(props.thread?.archived) ||
                  Boolean(props.threadLoading) ||
                  props.submitting ||
                  props.resuming ||
                  props.forking ||
                  !(props.thread || props.projectId)
                }
                onClick={() => {
                  pickerDraftKey.current = key;
                  fileInputRef.current?.click();
                }}
              >
                <Icon name="plus" size={20} />
              </Button>
            </ControlHint>
          }
          settings={props.settings}
          projectName={props.projectName}
          models={props.models}
          onChange={props.onSettings}
          onSaveModelDefaults={props.onSaveModelDefaults}
          savingModelDefaults={props.savingModelDefaults}
          thread={props.thread}
          projectId={props.projectId}
          runtimeKey={props.runtimeKey}
          threadLoading={props.threadLoading}
          disabled={
            props.disabled ||
            Boolean(props.threadLoading) ||
            active ||
            props.submitting ||
            props.resuming ||
            props.forking
          }
        >
          {active && (
            <ControlHint content={t('composer:interrupt')}>
              <Button
                aria-label={props.interrupting ? t('composer:requesting') : t('composer:interrupt')}
                variant="secondary"
                size="sm"
                onClick={props.onInterrupt}
                disabled={!props.canInterrupt || props.interrupting}
              >
                <Icon name="stop" size={13} />
                <span className="composer-action-label">
                  {props.interrupting ? t('composer:requesting') : t('composer:interrupt')}
                </span>
              </Button>
            </ControlHint>
          )}
          <ControlHint id={shortcutId} className="composer-submit" content={inputHint}>
            <Button
              size="sm"
              aria-label={
                slash
                  ? executingCommand
                    ? t('composer:running_command')
                    : t('common:run_command')
                  : props.submitting
                    ? t('common:submitting')
                    : active
                      ? t('composer:additional_instructions')
                      : t('composer:send_task')
              }
              aria-describedby={shortcutId}
              onPointerDown={(event) => {
                if (slash || mobileInput) event.preventDefault();
              }}
              onClick={() => {
                void send();
              }}
              disabled={
                slash ? executingCommand || Boolean(selectedCommand?.unavailableReason) : !canSend
              }
            >
              <Icon name="send" size={14} />
              <span className="composer-action-label">
                {slash
                  ? executingCommand
                    ? t('composer:running_2')
                    : t('common:run_command')
                  : props.submitting
                    ? t('common:submitting')
                    : active
                      ? t('composer:additional_instructions')
                      : t('composer:send_task')}
              </span>
            </Button>
          </ControlHint>
        </SettingsPanel>
        <input
          ref={fileInputRef}
          type="file"
          hidden
          multiple
          accept={IMAGE_TYPES.join(',')}
          aria-label={t('composer:add_images')}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            addImages(files, pickerDraftKey.current ?? key);
            pickerDraftKey.current = undefined;
          }}
        />
      </div>
      <p className="composer-note">
        {active
          ? t('composer:closing_this_page_does_not_stop_tasks_interruptions')
          : t('composer:codex_runs_with_the_server_project_s_permissions')}
      </p>
    </div>
  );
}
