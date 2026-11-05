/**
 * 「XX 像是个 Agent,要接上吗?」在手机上(2026-09-25,卡 Q;统筹:这一问算「只有他能做的」,手机「等你确认」能答)。
 *
 * 喂的是电脑那边同一份:workbench-plugin/tests/fixtures/agent-ask-state.json(电脑那边 server-agent-ask 核对过它就是
 * 工作台服务端真拼出来的:自动发现两道都判不出的「Mosaic」挂进卡 M 的提问经纪人)。
 * 手机不认这是哪一种问题 —— 就是「等你确认」里的一张提问卡:数进那一格、点一个选项就交。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchState } from '../src/api/protocol';
import { PhoneQuestionAsk } from '../src/asks/AskCards';
import { stageCards } from '../src/stage/stageCardsModel';

const SAME = JSON.parse(readFileSync(resolve(process.cwd(), '..', 'workbench-plugin', 'tests', 'fixtures', 'agent-ask-state.json'), 'utf8')) as WorkbenchState;

describe('手机「等你确认」:这一问就是那一格里的一件', () => {
  it('★那一格的数 = 电脑上「等你」那个数(1),那一行「事务官问你:Mosaic 像是个 Agent」,点下去到问你的那一页', () => {
    const card = stageCards(SAME).find((one) => one.id === 'confirm')!;
    expect(card.count).toBe(SAME.waiting!.count);
    expect(card.count).toBe(1);
    expect(card.lines.map((line) => [line.text, line.note])).toEqual([['事务官问你:Mosaic 像是个 Agent', '要你回答']]);
    expect(card.to).toEqual({ page: 'asks' });
  });

  it('★点开:同样的话(接上以后读什么、不读什么)、同样三个选项;点「接上」交回去的是原样的选项名', async () => {
    const answer = vi.fn(async () => undefined);
    render(<PhoneQuestionAsk question={SAME.questions![0]!} answer={answer} />);
    expect(screen.getByText('Mosaic 像是个 Agent')).toBeTruthy();
    expect(screen.getByText(/别的聊天内容不存、不往外发/)).toBeTruthy();
    for (const label of ['接上', '不是 Agent', '先不管']) expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^接上/ }));
    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
    expect(answer).toHaveBeenCalledWith([{ id: 'agent-connect', selected: ['接上'] }]);
  });
});
