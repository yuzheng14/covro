import { displayMessage } from '../i18n/messages';
import { t } from '../i18n';
import type { ItemView } from '../../shared/types';
import { MarkdownContent } from './MarkdownContent';

export function UserMessage({ item }: { item: ItemView }) {
  return (
    <article
      className="message user-message"
      aria-label={t('conversation:your_message')}
      data-prompt-id={item.id}
      tabIndex={-1}
    >
      <div className="message-content">
        {item.questionReplies?.length ? (
          item.questionReplies.map((reply, index) => (
            <div className="user-question-reply" key={index}>
              <blockquote>
                <MarkdownContent text={reply.question} />
              </blockquote>
              <div className="user-text">
                <MarkdownContent text={reply.answer} />
              </div>
            </div>
          ))
        ) : (
          <p className="user-text">{item.text}</p>
        )}
        {item.images && (
          <div className="message-images">
            {item.images.map((image, index) => (
              <img
                key={index}
                src={image}
                alt={t('conversation:sent_image', { v0: index + 1 })}
                loading="lazy"
              />
            ))}
          </div>
        )}
        {(item.imageCount ?? 0) > (item.images?.length ?? 0) && (
          <p className="subtle">
            {t('conversation:images_have_no_preview', {
              count: (item.imageCount ?? 0) - (item.images?.length ?? 0),
              v0: (item.imageCount ?? 0) - (item.images?.length ?? 0),
            })}
          </p>
        )}
        {item.error && <p className="inline-error">{displayMessage(item.error)}</p>}
      </div>
    </article>
  );
}
