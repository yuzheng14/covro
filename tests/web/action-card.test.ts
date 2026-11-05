import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PendingAction } from '../../src/shared/types';
import { ActionCard } from '../../src/web/components/ActionCard';

const action: PendingAction = {
  actionId: 'action',
  codexEpoch: 'epoch',
  rpcId: 1,
  kind: 'questions',
  title: '确认请求',
  status: 'pending',
  options: [],
  questions: [
    {
      id: 'answer',
      header: '说明',
      question: '请说明是否允许使用此名称',
      isOther: false,
      isSecret: false,
      options: [],
    },
  ],
};
function render(overrides: Partial<PendingAction>) {
  return renderToStaticMarkup(
    createElement(ActionCard, {
      action: { ...action, ...overrides },
      disabled: false,
      onResolve: () => {},
    }),
  );
}

describe('interactive request labels', () => {
  it('does not infer authorization from permission wording in a free-text question', () => {
    const html = render({});
    expect(html).toContain('提交回答</button>');
    expect(html).not.toContain('确认允许');
  });

  it.each([
    ['responding', '正在提交…'],
    ['responded', '已处理'],
    ['expired', '请求已失效'],
  ] as const)('disables %s questions and forms with the matching state label', (status, label) => {
    for (const kind of ['questions', 'elicitation'] as const) {
      const html = render({
        kind,
        status,
        elicitation: { serverName: '测试服务', mode: 'form', fields: [] },
      });
      expect(html).toContain(`<span class="action-state">${label}</span>`);
      if (kind === 'questions') {
        expect(html).not.toContain('<button');
        expect(html).not.toContain('<input');
        expect(html).toContain('<fieldset disabled="">');
      } else {
        expect(html).toContain(`>${label}</button>`);
        expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
      }
      expect(html).not.toContain('提交回答</button>');
      expect(html).not.toContain('确认继续</button>');
    }
  });

  it('marks processed approvals as handled without claiming that they were allowed', () => {
    const html = render({
      kind: 'permissions',
      status: 'responded',
      options: [
        { id: 'acceptForSession', label: '本会话允许' },
        { id: 'decline', label: '拒绝' },
      ],
    });
    expect(html).toContain('已处理');
    expect(html).not.toContain('已回答');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
