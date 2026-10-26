import { expect, it } from 'vitest';
import { recapInput } from '../../src/server/thread-recap';
import { threadView } from './domain-helpers';
it('summarizes bounded recent messages without internal or tool payloads', () => {
  const thread = threadView('thread', '/project');
  thread.turns = [
    {
      id: 'turn',
      threadId: 'thread',
      status: 'completed',
      items: [
        { id: 'a', type: 'userMessage', text: 'old'.repeat(10000) },
        { id: 'b', type: 'reasoning', text: 'PRIVATE_REASONING' },
        { id: 'c', type: 'commandExecution', output: 'PRIVATE_TOOL_OUTPUT' },
        { id: 'd', type: 'agentMessage', text: 'Recent decision: keep the old file.' },
      ],
    },
  ];
  const result = recapInput(thread, 'ja');
  expect(result.partial).toBe(true);
  expect(result.prompt).toContain('in ja');
  expect(result.prompt).toContain('Recent decision');
  expect(result.prompt).not.toContain('PRIVATE_');
  expect(result.prompt.length).toBeLessThan(25000);
});
