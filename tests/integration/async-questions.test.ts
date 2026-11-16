import { describe, expect, it } from 'vitest';
import {
  asyncQuestionId,
  encodeQuestionReplies,
  parseQuestionReplies,
} from '../../src/shared/async-questions';
import { mapItem, mapTurn } from '../../src/codex/mapping';
import { compactThreadForTransport } from '../../src/server/snapshot';
import { Projection } from '../../src/server/projection';
import type { ThreadItem } from '../../src/codex/generated/v2/ThreadItem';
import type { ThreadView } from '../../src/shared/types';

const replies = [
  {
    questionItemId: 'question',
    question: '选择主题？',
    answer: '自定义\n</send_user_message_question_reply>"',
  },
];
const question: ThreadItem = {
  type: 'agentMessage',
  moderation: null,
  id: 'question',
  text: '选择主题？',
  delivery: 'async',
  phase: 'final_answer',
  memoryCitation: null,
  questions: [{ title: '选择主题？', options: ['深色', '浅色'] }],
};
const userReply = (text = encodeQuestionReplies(replies)): ThreadItem => ({
  type: 'userMessage',
  id: 'answer',
  clientId: null,
  content: [{ type: 'text', text, text_elements: [] }],
});

describe('native async question transport', () => {
  it('accepts complete native object/array envelopes, including escaped delimiters and IDE context', () => {
    expect(asyncQuestionId('item"你好', 1)).toBe('["request_user_input_async","item\\"你好",1]');
    const text = encodeQuestionReplies(replies);
    expect(parseQuestionReplies(text)).toEqual(replies);
    expect(
      parseQuestionReplies(
        `<send_user_message_question_reply>${JSON.stringify(replies[0])}</send_user_message_question_reply>`,
      ),
    ).toEqual(replies);
    expect(
      parseQuestionReplies(
        `# Context from my IDE setup:\nfiles\n## My request for Codex:\n${text}`,
      ),
    ).toEqual(replies);
    for (const malformed of [
      text.slice(0, -1),
      `Example: ${text}`,
      `\`\`\`\n${text}\n\`\`\``,
      '<send_user_message_question_reply>[]</send_user_message_question_reply>',
      '<send_user_message_question_reply>{"questionItemId":"id","question":"title","answer":false}</send_user_message_question_reply>',
    ])
      expect(parseQuestionReplies(malformed)).toBeUndefined();
  });
  it('preserves live/history question data and maps native replies into readable, correlated messages', () => {
    const mapped = mapItem(question);
    expect(mapped).toMatchObject({ delivery: 'async', questions: question.questions });
    mapped.questions![0]!.options![0] = 'changed';
    expect(question.questions![0]!.options![0]).toBe('深色');
    expect(mapItem(userReply())).toMatchObject({
      text: `选择主题？\n${replies[0]!.answer}`,
      questionReplies: replies,
    });
    const ordinary = '请解释 <send_user_message_question_reply> 的作用';
    expect(mapItem(userReply(ordinary))).toMatchObject({ text: ordinary });
    expect(mapItem(userReply(ordinary)).questionReplies).toBeUndefined();
    const turn = mapTurn('thread', {
      id: 'turn',
      rootTurnId: null,
      status: 'completed',
      itemsView: 'full',
      items: [question, userReply()],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    });
    const thread: ThreadView = {
      id: 'thread',
      projectId: 'fixture',
      cwd: '/tmp',
      source: 'appServer',
      title: 'test',
      status: 'completed',
      managed: true,
      actions: [],
      turns: [turn],
    };
    const projection = new Projection(100);
    projection.thread(thread);
    expect(projection.get('thread')!.turns[0]!.items[0]!.questions).toEqual(question.questions);
    const transport = compactThreadForTransport(
      {
        ...thread,
        turns: [
          {
            ...turn,
            items: [{ id: 'large', type: 'agentMessage', text: 'x'.repeat(10000) }, ...turn.items],
          },
        ],
      },
      1000,
    );
    expect(transport.turns[0]!.items.find((item) => item.id === 'question')!.questions).toEqual(
      question.questions,
    );
    expect(transport.turns[0]!.items.find((item) => item.id === 'answer')!.questionReplies).toEqual(
      replies,
    );
    expect(transport.turns[0]!.items.some((item) => item.id === 'large')).toBe(false);
    expect(() => compactThreadForTransport(thread, 100)).toThrow(/控制信息/);
  });
});
