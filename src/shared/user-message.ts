import { parseQuestionReplies } from './async-questions.js';
import type { ItemView, TaskMessage } from './types.js';

/** The submitted display is independent of the composer's next editable draft. */
export function submittedUserMessage(id: string, message: TaskMessage): ItemView {
  const replies = parseQuestionReplies(message.text);
  return {
    id: `submission:${id}`,
    type: 'userMessage',
    clientId: id,
    text: replies
      ? replies.map((reply) => `${reply.question}\n${reply.answer}`).join('\n\n')
      : message.text,
    ...(replies ? { questionReplies: replies } : {}),
    ...(message.images?.length
      ? { images: [...message.images], imageCount: message.images.length }
      : {}),
  };
}

/** Live receipts may omit media that was already shown for the same submission. */
export function mergeUserMessage(item: ItemView, previous?: ItemView): ItemView {
  if (item.type !== 'userMessage' || previous?.type !== 'userMessage') return item;
  return {
    ...item,
    ...(!item.images?.length && previous.images?.length ? { images: previous.images } : {}),
    ...(previous.imageCount
      ? { imageCount: Math.max(item.imageCount ?? 0, previous.imageCount) }
      : {}),
  };
}
