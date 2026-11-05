/**
 * 第二套横屏展示台「环绕」的摆法(2026-10-01,Pen.dev 稿「B · 中央粒子与环绕会话」)。
 * display-client 的用例跑在 node 里,没有 DOM:这里用服务端渲染把结构钉住,连线几何单独算。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrbitDashboard, connectorPath, orbitDate } from './OrbitDashboard';
import type { OrbitCard, QuotaAccount } from './orbitBoard';

function card(over: Partial<OrbitCard> & { key: string }): OrbitCard {
  return { agentId: 'claude', agentName: 'Claude', title: '事项', sub: '', status: 'running', statusText: '在跑', linked: true, ringing: false, ...over };
}

const ACCOUNTS: QuotaAccount[] = [
  { id: 'claude', name: 'Claude', stale: false, windows: [{ label: '5小时', pct: 66, level: 'ok' }, { label: '周', pct: 42, level: 'ok' }, { label: 'Sonnet', pct: 78, level: 'ok' }] },
  { id: 'antigravity', name: 'Antigravity', stale: false, windows: [], groups: [{ name: 'Gemini Models', windows: [{ label: '5小时', pct: 64, level: 'ok' }] }] },
  { id: 'muse', name: 'Muse', stale: false, windows: [], empty: '额度未接入' },
];

function render(over: Partial<Parameters<typeof OrbitDashboard>[0]> = {}): string {
  return renderToStaticMarkup(
    <OrbitDashboard
      now={{ title: '夜に駆ける', sub: 'YOASOBI', live: true }}
      playing
      cards={[
        card({ key: 'claude:a', title: '手机横屏 · 音乐与播客', sub: '补齐落后进度 · 刚刚' }),
        card({ key: 'claude:b', title: '故障修复与验收' }),
        card({ key: 'codex:c', agentId: 'codex', agentName: 'Codex', title: 'Space · 导出 PDF' }),
        card({ key: 'claude:w', title: '批准本次文件访问', status: 'waiting', statusText: '等你', linked: false }),
      ]}
      accounts={ACCOUNTS}
      hidden={0}
      sync={{ text: '与电脑同步中', alert: false }}
      icons={{ claude: 'data:image/png;base64,AAAA' }}
      colors={{ codex: '#10a37f' }}
      stage={<div className="stage-here" />}
      {...over}
    />,
  );
}

describe('环绕:摆法', () => {
  it('顶栏:时间、日期、正在放的那一首', () => {
    const html = render();
    expect(html).toContain('ob-clock');
    expect(html).toContain('夜に駆ける · YOASOBI');
  });

  it('★会话左二右二,中间是形象位;等你的那张不连线', () => {
    const html = render();
    const left = html.slice(html.indexOf('ob-side--left'), html.indexOf('ob-center'));
    const right = html.slice(html.indexOf('ob-side--right'));
    expect(left).toContain('手机横屏 · 音乐与播客');
    expect(left).toContain('故障修复与验收');
    expect(right).toContain('Space · 导出 PDF');
    expect(right).toContain('批准本次文件访问');
    expect(html).toContain('stage-here');
    expect(html).toMatch(/data-status="waiting" data-linked="false"/);
  });

  it('有 logo 的画 logo,没有的画那一家的色点', () => {
    const html = render();
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('background:#10a37f');
  });

  it('★额度按账号:全部周期都在、分组按组、没接入写明', () => {
    const html = render();
    for (const word of ['5小时', '周', 'Sonnet', '66%', '42%', '78%', 'Gemini Models', '额度未接入']) expect(html).toContain(word);
  });

  it('断开了右上角如实说(C1);多出来的账号报个数', () => {
    const html = render({ sync: { text: '和电脑断开了 · 显示最后一次已知状态', alert: true }, hidden: 2 });
    expect(html).toContain('和电脑断开了');
    expect(html).toContain('data-alert="true"');
    expect(html).toContain('另有 2 个账号没摆下');
  });

  it('只有一个账号时那一组限宽居中(稿子「单账号 · 重新居中」);七个以上会话卡收紧', () => {
    expect(render({ accounts: ACCOUNTS.slice(0, 1) })).toContain('data-count="1"');
    const many = Array.from({ length: 7 }, (_, i): QuotaAccount => ({ id: `a${i}`, name: `A${i}`, stale: false, windows: [], empty: '额度未接入' }));
    expect(render({ accounts: many })).toContain('data-dense="true"');
  });
});

describe('连线', () => {
  it('左边的卡从右沿中点连到球的左侧,右边的镜像;两端水平出发', () => {
    const left = connectorPath({ x: 0, y: 0, w: 232, h: 73 }, { x: 412, y: 70 }, 'left');
    expect(left.startsWith('M232,36.5 C')).toBe(true);
    const right = connectorPath({ x: 593, y: 0, w: 232, h: 73 }, { x: 412, y: 70 }, 'right');
    expect(right.startsWith('M593,36.5 C')).toBe(true);
  });
});

describe('日期', () => {
  it('稿子的写法:10月1日 周四', () => {
    expect(orbitDate(new Date(2026, 9, 1, 22, 2))).toBe('10月1日 周四');
  });
});
