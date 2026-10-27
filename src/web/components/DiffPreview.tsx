import { message, displayMessage, messageDetails } from '../i18n/messages';
import { t, currentLocale } from '../i18n';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { readableError } from '../lib/utils';
import { ChevronDown, ChevronUp, FileCode2, WrapText } from 'lucide-react';
import type { FileChange } from '../../shared/types';
import { diffCollapseReason, diffKindLabels, parseDiff, type DiffFile } from '../lib/diff';
import { highlightDiffHunks } from '../lib/diff-inline';
import { FilePreviewPanel } from './FilePreviewPanel';
import { Button } from './ui/button';

export interface DiffPreviewTarget {
  id: string;
  scope: string;
  source: 'turn' | 'item';
  selectedPath?: string;
  cursor?: string;
}
interface DiffSnapshot extends DiffPreviewTarget {
  text?: string;
  changes?: FileChange[];
  truncated?: boolean;
}
function Stats({ file }: { file: DiffFile }) {
  return (
    <span
      className="diff-stats"
      aria-label={t('preview:lines_added_lines_removed', {
        v0: file.additions,
        v1: file.deletions,
      })}
    >
      <span>+{file.additions}</span>
      <span>−{file.deletions}</span>
    </span>
  );
}

export function DiffPreview({
  target,
  threadId,
  onClose,
}: {
  target: DiffPreviewTarget;
  threadId: string;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<DiffSnapshot>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      setError(message('preview:reading_changes_timed_out_please_retry'));
    }, 35_000);
    setLoaded(undefined);
    setError(undefined);
    const read = target.cursor
      ? api.threadHistory(threadId, target.cursor, controller.signal)
      : api.thread(threadId, controller.signal);
    void read
      .then((thread) => {
        if (controller.signal.aborted) return;
        if (target.source === 'turn') {
          const turn = thread.turns.find((entry) => entry.id === target.id);
          if (!turn) throw new Error(t('preview:changes_from_this_turn_are_no_longer_in'));
          setLoaded({
            ...target,
            text: turn.diff,
            changes:
              turn.diff === undefined
                ? turn.items.flatMap((entry) => entry.changes ?? [])
                : undefined,
            truncated:
              thread.historyTruncated ||
              turn.items.some((entry) => entry.type === 'fileChange' && entry.truncated),
          });
        } else {
          const item = thread.turns
            .flatMap((entry) => entry.items)
            .find((entry) => entry.id === target.id);
          if (!item) throw new Error(t('preview:changes_from_this_tool_are_no_longer_in'));
          setLoaded({ ...target, changes: item.changes ?? [], truncated: item.truncated });
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(readableError(failure));
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [target, threadId, attempt]);
  return (
    <FilePreviewPanel
      label={t('preview:code_change_preview')}
      title={t('preview:code_changes')}
      subtitle={t('preview:read_only', { v0: displayMessage(target.scope) })}
      icon={<FileCode2 size={19} className="file-preview-icon" aria-hidden="true" />}
      onClose={onClose}
    >
      <p className="diff-scope">
        {t('preview:a_change_snapshot_from_codex_containing_patches_in')}
      </p>
      {error ? (
        <div className="diff-empty" role="alert">
          <h3>{t('preview:unable_to_load_changes')}</h3>
          <p>{displayMessage(error)}</p>
          {messageDetails(error) && (
            <details>
              <summary>{t('common:technical_details')}</summary>
              <pre>{messageDetails(error)}</pre>
            </details>
          )}
          <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
            {t('common:reload')}
          </Button>
        </div>
      ) : loaded ? (
        <DiffContent key={attempt} target={loaded} />
      ) : (
        <p className="file-preview-loading diff-loading" role="status">
          {t('preview:loading_changes')}
        </p>
      )}
    </FilePreviewPanel>
  );
}

export function DiffContent({
  target,
  showScope = true,
}: {
  target: Pick<DiffSnapshot, 'text' | 'changes' | 'truncated' | 'scope' | 'selectedPath'>;
  showScope?: boolean;
}) {
  const locale = currentLocale();
  const files = useMemo(
    () =>
      target.changes
        ? target.changes.flatMap((change) => parseDiff(change.diff, change))
        : parseDiff(target.text ?? ''),
    [target, locale],
  );
  const [wrap, setWrap] = useState(false);
  return (
    <>
      {target.truncated && (
        <p className="diff-warning" role="status">
          {t('preview:this_patch_is_truncated_only_received_content_is')}
        </p>
      )}
      {files.length ? (
        <>
          <div className="diff-list-toolbar">
            <span>{t('preview:new_files_in_this_snapshot', { v0: files.length })}</span>
            <Button variant="ghost" size="sm" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
              <WrapText size={15} />
              {t('preview:wrap_lines')}
            </Button>
          </div>
          <div className="diff-files" tabIndex={0} aria-label={t('preview:new_changed_file_list')}>
            {files.map((file, index) => (
              <DiffFilePreview
                key={index}
                file={file}
                wrap={wrap}
                reveal={
                  target.selectedPath !== undefined &&
                  (file.path === target.selectedPath || file.oldPath === target.selectedPath)
                }
              />
            ))}
          </div>
        </>
      ) : (
        <div className="diff-empty" role="status">
          <FileCode2 size={28} />
          <h3>{t('preview:no_file_changes_yet')}</h3>
          <p>{t('preview:no_previewable_patch_received_in_this_scope_yet')}</p>
        </div>
      )}
      {showScope && <footer className="file-preview-path">{displayMessage(target.scope)}</footer>}
    </>
  );
}

/** Each file owns its disclosure; expensive highlighting and code rows mount only on expansion. */
function DiffFilePreview({
  file,
  wrap,
  reveal,
}: {
  file: DiffFile;
  wrap: boolean;
  reveal: boolean;
}) {
  const reason = useMemo(() => diffCollapseReason(file), [file]);
  const [expanded, setExpanded] = useState(() => reveal || !reason);
  const section = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const restorePosition = useRef<number | undefined>(undefined);
  const contentId = useId();
  useEffect(() => {
    if (reveal) section.current?.scrollIntoView({ block: 'start' });
  }, [reveal]);
  useLayoutEffect(() => {
    const top = restorePosition.current;
    const element = section.current;
    const scroller = element?.closest('.diff-files');
    if (top !== undefined && element && scroller) {
      scroller.scrollTop += element.getBoundingClientRect().top - top;
      toggle.current?.focus({ preventScroll: true });
      restorePosition.current = undefined;
    }
  }, [expanded]);
  function collapse() {
    const element = section.current;
    const scroller = element?.closest('.diff-files');
    if (element && scroller) {
      // A bottom collapse returns to this file; a visible header stays in the same place.
      restorePosition.current = Math.max(
        element.getBoundingClientRect().top,
        scroller.getBoundingClientRect().top,
      );
    }
    setExpanded(false);
  }
  return (
    <section ref={section} className="diff-file" aria-label={file.path}>
      <div className="diff-file-heading">
        <h3>
          <code>{file.path}</code>
        </h3>
        <span className={`diff-kind diff-kind-${file.kind}`}>{diffKindLabels[file.kind]}</span>
        <Stats file={file} />
        <Button
          ref={toggle}
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => (expanded ? collapse() : setExpanded(true))}
        >
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          {expanded ? t('preview:new_collapse_changes') : t('preview:new_expand_changes')}
        </Button>
      </div>
      {file.kind === 'renamed' && file.oldPath && (
        <p className="diff-rename">{t('preview:original_path', { v0: file.oldPath })}</p>
      )}
      {file.incomplete && (
        <p className="diff-warning" role="status">
          {t('preview:this_patch_is_incomplete_or_malformed_line_numbers')}
        </p>
      )}
      {!expanded && (
        <p className="diff-collapsed">
          {t('preview:new_choose_expand_changes_to_view_it', {
            v0: reason ?? t('preview:new_changes_were_collapsed_manually'),
          })}
        </p>
      )}
      <div id={contentId} hidden={!expanded}>
        {expanded && <DiffFileBody file={file} wrap={wrap} />}
        {expanded && reason && (
          <Button className="diff-collapse-bottom" variant="ghost" size="sm" onClick={collapse}>
            <ChevronUp size={15} />
            {t('preview:new_collapse_changes')}
          </Button>
        )}
      </div>
    </section>
  );
}

function DiffFileBody({ file, wrap }: { file: DiffFile; wrap: boolean }) {
  const [hunkIndex, setHunkIndex] = useState(0);
  const hunks = useRef<(HTMLElement | null)[]>([]);
  const highlightedHunks = useMemo(() => highlightDiffHunks(file.hunks), [file]);
  const failed =
    !file.binary &&
    !file.hunks.length &&
    file.metadata.some(
      (line) =>
        !/^(old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to )/.test(
          line,
        ),
    );
  function jump(index: number) {
    setHunkIndex(index);
    const hunk = hunks.current[index];
    const scroller = hunk?.closest('.diff-files');
    const heading = hunk?.closest('.diff-file')?.querySelector('.diff-file-heading');
    if (hunk && scroller && heading) {
      // Leave room for the pinned heading, including wrapped paths on narrow screens.
      scroller.scrollTop +=
        hunk.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        heading.getBoundingClientRect().height -
        12;
    }
  }
  return (
    <>
      {file.hunks.length > 1 && (
        <div
          className="diff-controls"
          role="group"
          aria-label={t('preview:change_hunk_navigation')}
        >
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('preview:previous_change_hunk')}
            disabled={hunkIndex === 0}
            onClick={() => jump(hunkIndex - 1)}
          >
            <ChevronUp size={16} />
          </Button>
          <span>{t('preview:new_hunks', { v0: hunkIndex + 1, v1: file.hunks.length })}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('preview:next_change_hunk')}
            disabled={hunkIndex >= file.hunks.length - 1}
            onClick={() => jump(hunkIndex + 1)}
          >
            <ChevronDown size={16} />
          </Button>
        </div>
      )}
      <div
        className={`diff-content${wrap ? ' diff-wrap' : ''}`}
        tabIndex={0}
        aria-label={t('preview:new_changes_in', { v0: file.path })}
      >
        {file.binary ? (
          <div className="diff-empty">
            <FileCode2 size={28} />
            <h3>{t('preview:binary_file_changed')}</h3>
            <p>{t('preview:line_by_line_preview_is_unavailable_for_this')}</p>
          </div>
        ) : failed ? (
          <div className="diff-empty" role="alert">
            <h3>{t('preview:unable_to_read_change_content')}</h3>
            <p>{t('preview:the_content_is_not_a_recognized_unified_diff')}</p>
          </div>
        ) : file.hunks.length ? (
          <table
            className="diff-table"
            aria-label={t('preview:line_changes_in', { v0: file.path })}
          >
            <thead>
              <tr>
                <th scope="col">{t('preview:old_line')}</th>
                <th scope="col">{t('preview:new_line')}</th>
                <th scope="col" aria-label={t('preview:change_type')} />
                <th scope="col">{t('preview:code')}</th>
              </tr>
            </thead>
            {highlightedHunks.map((hunk, index) => (
              <tbody
                key={index}
                ref={(element) => {
                  hunks.current[index] = element;
                }}
              >
                <tr className="diff-hunk">
                  <td colSpan={4}>
                    <span>{t('preview:hunk', { v0: index + 1 })}</span> {hunk.header}
                  </td>
                </tr>
                {hunk.lines.map((line, row) => (
                  <tr key={row} className={`diff-line diff-${line.kind}`}>
                    <td className="diff-line-number">{line.oldLine}</td>
                    <td className="diff-line-number">{line.newLine}</td>
                    <td
                      className="diff-marker"
                      aria-label={
                        {
                          added: t('common:added'),
                          removed: t('common:removed'),
                          context: t('preview:context'),
                          note: t('preview:note'),
                        }[line.kind]
                      }
                    >
                      {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}
                    </td>
                    <td className="diff-code">
                      <code>
                        {line.segments
                          ? line.segments.map((segment, index) =>
                              segment.changed ? (
                                <mark className="diff-inline-change" key={index}>
                                  {segment.text}
                                </mark>
                              ) : (
                                segment.text
                              ),
                            )
                          : line.text || ' '}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        ) : (
          <div className="diff-empty">
            <h3>{t('preview:no_line_changes')}</h3>
            <p>{t('preview:this_patch_changes_only_metadata_paths_or_empty')}</p>
          </div>
        )}
      </div>
    </>
  );
}
