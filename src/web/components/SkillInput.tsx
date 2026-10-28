import {
  forwardRef,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type TextareaHTMLAttributes,
} from 'react';
import { skillDeletion, skillSelection, type SkillBinding } from '../lib/skill-references';
import { t } from '../i18n';

const noSkills: SkillBinding[] = [];
interface SkillInputProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange'> {
  draftKey: string;
  skills?: SkillBinding[];
  onChange?: (event: ChangeEvent<HTMLTextAreaElement>, restoredSkills?: SkillBinding[]) => void;
}

/** Keep native textarea/IME/paste behavior; mirror only the backgrounds of real bound inputs. */
export const SkillInput = forwardRef<HTMLTextAreaElement, SkillInputProps>(function SkillInput(
  { draftKey, skills = noSkills, ...props },
  ref,
) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const highlights = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  const text = String(props.value ?? '');
  const history = useRef({ draftKey, states: [{ text, skills }], index: 0 });
  useLayoutEffect(() => {
    if (history.current.draftKey !== draftKey) {
      history.current = { draftKey, states: [{ text, skills }], index: 0 };
      return;
    }
    const current = history.current.states[history.current.index]!;
    if (current.text === text && JSON.stringify(current.skills) === JSON.stringify(skills)) return;
    history.current.states.splice(history.current.index + 1);
    history.current.states.push({ text, skills });
    if (history.current.states.length > 100) history.current.states.shift();
    history.current.index = history.current.states.length - 1;
  }, [draftKey, text, skills]);
  const bindings = skills
    .filter((skill) => text.slice(skill.start, skill.end) === `$${skill.name}`)
    .sort((a, b) => a.start - b.start);
  const pendingDeletion = useRef<{ text: string; start: number; end: number } | undefined>(
    undefined,
  );
  const composing = useRef(false);
  useLayoutEffect(() => {
    composing.current = false;
    pendingDeletion.current = undefined;
  }, [draftKey]);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  useImperativeHandle(ref, () => textarea.current!, []);

  function prepareDeletion(backward: boolean) {
    const element = textarea.current;
    if (!element || props.readOnly || composing.current) return;
    const range = skillDeletion(
      text,
      bindings,
      element.selectionStart,
      element.selectionEnd,
      backward,
    );
    if (!range) return;
    pendingDeletion.current = { text, ...range };
    element.setSelectionRange(range.start, range.end);
  }

  useLayoutEffect(() => {
    const element = textarea.current!;
    const layer = highlights.current!;
    const sync = () => {
      layer.style.width = `${element.clientWidth}px`;
      layer.style.height = `${element.clientHeight}px`;
      layer.firstElementChild!.setAttribute(
        'style',
        `transform: translate(${-element.scrollLeft}px, ${-element.scrollTop}px)`,
      );
    };
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    element.addEventListener('scroll', sync);
    sync();
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', sync);
    };
  }, []);

  useLayoutEffect(() => {
    const element = textarea.current!;
    const beforeInput = (event: InputEvent) => {
      pendingDeletion.current = undefined;
      if (event.isComposing || !event.inputType.startsWith('delete')) return;
      prepareDeletion(event.inputType.endsWith('Backward'));
    };
    element.addEventListener('beforeinput', beforeInput);
    return () => element.removeEventListener('beforeinput', beforeInput);
  });

  let previousEnd = 0;
  const fragments = bindings.map((skill) => {
    const prefix = text.slice(previousEnd, skill.start);
    previousEnd = skill.end;
    return (
      <span key={`${skill.start}:${skill.path}`}>
        {prefix}
        <mark data-skill-path={skill.path} title={skill.path}>
          {text.slice(skill.start, skill.end)}
        </mark>
      </span>
    );
  });
  const selected = bindings.find(
    (skill) => selection.start >= skill.start && selection.end <= skill.end + 1,
  );
  return (
    <div className="composer-editor">
      <div ref={highlights} className="composer-highlights" aria-hidden="true">
        <div>
          {fragments}
          {text.slice(previousEnd)}
          {'\u200b'}
        </div>
      </div>
      {!!bindings.length && (
        <span id={descriptionId} className="sr-only">
          {t('composer:skills_selected')}:{' '}
          {bindings.map((skill) => `$${skill.name}: ${skill.path}`).join('; ')}
        </span>
      )}
      <textarea
        {...props}
        ref={textarea}
        title={selected?.path}
        aria-describedby={
          [props['aria-describedby'], bindings.length ? descriptionId : undefined]
            .filter(Boolean)
            .join(' ') || undefined
        }
        onKeyDown={(event) => {
          props.onKeyDown?.(event);
          if (
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 ||
            composing.current
          )
            return;
          if (event.key === 'Backspace' || event.key === 'Delete') {
            // Expanding the native selection keeps this as one browser edit, including undo.
            prepareDeletion(event.key === 'Backspace');
          } else if (
            !event.shiftKey &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            elementCollapsed(event.currentTarget)
          ) {
            const position = event.currentTarget.selectionStart;
            const skill = bindings.find((skill) =>
              event.key === 'ArrowLeft'
                ? position === skill.end
                : event.key === 'ArrowRight' && position === skill.start,
            );
            if (skill) {
              event.preventDefault();
              const next = event.key === 'ArrowLeft' ? skill.start : skill.end;
              event.currentTarget.setSelectionRange(next, next);
            }
          }
        }}
        onSelect={(event) => {
          const element = event.currentTarget;
          const range = composing.current
            ? { start: element.selectionStart, end: element.selectionEnd }
            : skillSelection(bindings, element.selectionStart, element.selectionEnd);
          if (range.start !== element.selectionStart || range.end !== element.selectionEnd)
            element.setSelectionRange(range.start, range.end, element.selectionDirection);
          setSelection(range);
          props.onSelect?.(event);
        }}
        onChange={(event) => {
          const deletion = pendingDeletion.current;
          pendingDeletion.current = undefined;
          // Some mobile beforeinput implementations retain their original target range.
          if (
            deletion?.text === text &&
            (event.nativeEvent as InputEvent).inputType?.startsWith('delete')
          ) {
            const next = text.slice(0, deletion.start) + text.slice(deletion.end);
            if (event.currentTarget.value !== next) {
              event.currentTarget.value = next;
              event.currentTarget.setSelectionRange(deletion.start, deletion.start);
            }
          }
          // Native undo owns text grouping; recover only identities from this draft's
          // exact earlier/later snapshots, never from a name or another workspace.
          const inputType = (event.nativeEvent as InputEvent).inputType;
          let restoredSkills: SkillBinding[] | undefined;
          if (inputType === 'historyUndo' || inputType === 'historyRedo') {
            const direction = inputType === 'historyUndo' ? -1 : 1;
            for (
              let index = history.current.index + direction;
              index >= 0 && index < history.current.states.length;
              index += direction
            ) {
              const state = history.current.states[index]!;
              if (state.text === event.currentTarget.value) {
                history.current.index = index;
                restoredSkills = state.skills;
                break;
              }
            }
          }
          props.onChange?.(event, restoredSkills);
        }}
        onCompositionStart={(event) => {
          composing.current = true;
          props.onCompositionStart?.(event);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          props.onCompositionEnd?.(event);
        }}
        onBlur={(event) => {
          composing.current = false;
          pendingDeletion.current = undefined;
          props.onBlur?.(event);
        }}
      />
    </div>
  );
});

function elementCollapsed(element: HTMLTextAreaElement) {
  return element.selectionStart === element.selectionEnd;
}
