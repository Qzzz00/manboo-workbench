/**
 * **守门:手机调电脑的每一条接口,出了局域网要么走得通,要么明说只在局域网**(2026-09-25,卡 S「手机在哪都能用」)。
 *
 * 维护者放假在外,手机远程用正是核心场景。09-24 那一版「按住说话」在外面必然转不了文字,往下查:手机调电脑的接口里,
 * 有几条在外面按下去弹的是「POST /feed/run 不在房间代理的白名单里」—— 没人决定过它该不该在外面能用,只是没人想起来。
 *
 * 这份用例让「想起来」变成必须的:
 *   ① 手机源码里出现的每一个路径字面量,都得在 src/channel/remoteParity.ts 里 —— 要么是一条接口(写明在外面怎么走),
 *      要么写明「不是电脑接口」及理由。新加一条既没路、也没声明的:**红**;
 *   ② 说走房间代理(`via: 'proxy'`)的,必须真在 channel-worker/src/rpc.ts 的白名单里;说只在局域网的,必须真不在;
 *   ③ 表里那条手机已经不调了:**红**(免得表越放越假);
 *   ④ 「只在局域网」那一句是给他看的:要是人话(中文、不带路径、不提白名单),要说在外面怎么办;
 *   ⑤ 识别那条专门的路两端逐字一样(topic、编号属性、交给 8791 的那条路)。
 * 核心几件在「远程模式」下真走一遍的在 tests/remoteCore.test.ts。
 */
import { describe, expect, it } from 'vitest';
import { NOT_PHONE_INTERFACES, PHONE_INTERFACES, lanOnlyReason, phonePathMatches } from '../src/channel/remoteParity';
import { WBCH_ASR_ID_ATTRIBUTE, WBCH_ASR_TOPIC } from '../src/channel/channelProtocol';
import { WBCH_ASR_PATH } from '../src/channel/channelClient';
import { WORKER_ASR_FILE, phonePathLiterals, workerAllows, workerConst, workerWhitelist } from './remoteParityScan';

const literals = phonePathLiterals();
const rules = workerWhitelist();

function declared(path: string): boolean {
  return PHONE_INTERFACES.some((one) => phonePathMatches(one.path, path)) || NOT_PHONE_INTERFACES.some((one) => one.path === path);
}

describe('手机调电脑的每一条都有着落', () => {
  it('扫得到东西(扫描本身没坏):/state、识别、配对、推送都在', () => {
    for (const path of ['/state', '/butler/proxy/api/asr', '/pair/claim', '/live', '/butler/item']) expect(literals.has(path), path).toBe(true);
    expect(literals.size).toBeGreaterThan(50);
  });

  it('① 源码里每一个路径都在表里(接口写明在外面怎么走,不是接口写明为什么)', () => {
    const missing = [...literals.entries()].filter(([path]) => !declared(path)).map(([path, at]) => `${path}  (${at.join(', ')})`);
    expect(missing, [
      '手机新调了电脑的这几条,出了局域网怎么走还没有着落:',
      ...missing,
      '到 butler-app/src/channel/remoteParity.ts 里加一行:能走房间代理的,在 channel-worker/src/rpc.ts 的 RPC_ALLOWED 加一行并写 via: \'proxy\';',
      '走不了的写 lanOnly 和一句他看得懂的话(说在外面怎么办);不是电脑接口的加进 NOT_PHONE_INTERFACES 并写为什么。',
    ].join('\n')).toEqual([]);
  });

  it('② 说走房间代理的,真在工人的白名单里;说只在局域网的,真不在', () => {
    const notAllowed = PHONE_INTERFACES.filter((one) => 'via' in one.remote && one.remote.via === 'proxy' && !workerAllows(one.method, one.path, rules))
      .map((one) => `${one.method} ${one.path}`);
    expect(notAllowed, `说走房间代理、但工人白名单(channel-worker/src/rpc.ts 的 RPC_ALLOWED)里没有:\n${notAllowed.join('\n')}`).toEqual([]);
    const contradict = PHONE_INTERFACES.filter((one) => 'lanOnly' in one.remote && one.method !== 'WS' && workerAllows(one.method, one.path, rules))
      .map((one) => `${one.method} ${one.path}`);
    expect(contradict, `说只在局域网、可工人白名单放了(那它就走得通,改成 via: 'proxy'):\n${contradict.join('\n')}`).toEqual([]);
  });

  it('③ 表里每一条手机都真在调(已经不调的删掉,别让表越放越假)', () => {
    const stale = PHONE_INTERFACES.filter((one) => ![...literals.keys()].some((path) => phonePathMatches(one.path, path))).map((one) => `${one.method} ${one.path}`);
    const staleNot = NOT_PHONE_INTERFACES.filter((one) => !literals.has(one.path)).map((one) => one.path);
    expect([...stale, ...staleNot], '这几条手机源码里已经没有了,从 remoteParity.ts 里删掉').toEqual([]);
  });

  it('④「只在局域网」那一句是给他看的:人话、不带路径、不提白名单、说在外面怎么办', () => {
    for (const one of PHONE_INTERFACES) {
      if (!('lanOnly' in one.remote)) continue;
      const text = one.remote.lanOnly;
      expect(text, `${one.method} ${one.path}`).toMatch(/[一-鿿]/);
      expect(text, `${one.method} ${one.path}`).not.toMatch(/\/|白名单|代理|局域网|同一个网络|她|[A-Za-z]{3,}/);
      expect(text, `${one.method} ${one.path}:要说在外面怎么办`).toMatch(/在外面/);
      // 运行时就是这一句(channelClient.ts 当场回它)。
      if (one.method !== 'WS') expect(lanOnlyReason(one.method, one.path.split(':x').join('x1'))).toBe(text);
    }
  });

  // 它第一次合 main 就拦住了卡 M 的 POST /questions/answer(在外面答不了事务官的提问),见 tests/remoteCore.test.ts 的「答提问」。
  // 合并卡 W 09-25:卡 N 合进来了,`/progress/said` 已经登记(表里 via: 'proxy'),不能再拿它当「没登记」的例子 ——
  // 换成一条永远不会真有的路径,守门那条机制照旧钉着。
  it('它真拦得住:还没登记的新接口判为没着落,工人白名单也不放', () => {
    for (const path of ['/some/new/route']) expect(declared(path), path).toBe(false);
    expect(workerAllows('POST', '/some/new/route', rules)).toBe(false);
    expect(workerAllows('POST', '/butler/item', rules)).toBe(true);
    expect(workerAllows('GET', '/butler/item/t-1/turns', rules)).toBe(true);
  });

  /**
   * 普通用户第一次就会碰到、又只在局域网的那几条(维护者 09-25:从常规用户第一次使用、非专业用户的视角想)。
   * **每一条都在交接里按「不懂技术、第一次装、人在外面」走过一遍**:docs/交接-0925-手机语音在哪都能用.md 第三节,
   * 写了他在外面看见什么、下一步做什么。往这张名单里加一条之前,先去交接里把它走一遍。
   */
  const FIRST_USE_LAN_ONLY_REVIEWED = [
    'WS /live',
    'POST /pair/claim',
    'POST /butler/proxy/api/tts',
    'GET /butler/proxy/api/avatars',
  ];

  it('第一次就会碰到、又只在局域网的,只有交接里走过一遍的那几条', () => {
    const now = PHONE_INTERFACES.filter((one) => one.firstUse === true && 'lanOnly' in one.remote).map((one) => `${one.method} ${one.path}`);
    expect(now.sort(), '第一次就会碰到的接口多了一条只在局域网的:先在交接里按「不懂技术、第一次装、人在外面」走一遍,再加进这张名单').toEqual([...FIRST_USE_LAN_ONLY_REVIEWED].sort());
  });

  it('第一次就会碰到的核心几件在外面都有路:首页、说一句、按住说话、引导里答话、批一次、打电话', () => {
    for (const [method, path] of [['GET', '/state'], ['POST', '/butler/item'], ['POST', '/butler/proxy/api/asr'], ['POST', '/onboarding/say'], ['POST', '/approvals/answer'], ['GET', '/channel/status']] as const) {
      const one = PHONE_INTERFACES.find((entry) => entry.method === method && entry.path === path);
      expect(one?.firstUse, `${method} ${path}`).toBe(true);
      expect(one !== undefined && 'via' in one.remote, `${method} ${path} 在外面得有路`).toBe(true);
    }
  });

  /**
   * 卡 M 那一条(2026-09-25):手机「等你确认」里答事务官的提问走 `POST /questions/answer`,合进 main 时工人白名单里没有它 ——
   * 出了家里的 Wi-Fi 答不了。这份守门第一次跑在合并后的代码上就红在它身上(① 那条,指到 src/asks/asksApi.ts:10)。
   * 白名单那一行由维护者另起的会话加上了;这里钉住:手机真在调它;表里少了这一行 ① 就红;白名单少了那一行 ② 就红。
   */
  it('卡 M 的「答提问」:表里少了那一行 ① 红,白名单少了那一行 ② 红', () => {
    expect(literals.get('/questions/answer')?.some((at) => at.startsWith('src/asks/asksApi.ts'))).toBe(true);
    const withoutEntry = PHONE_INTERFACES.filter((one) => one.path !== '/questions/answer');
    expect(withoutEntry.some((one) => phonePathMatches(one.path, '/questions/answer'))).toBe(false);
    expect(PHONE_INTERFACES.find((one) => one.path === '/questions/answer')).toMatchObject({ method: 'POST', remote: { via: 'proxy' }, firstUse: true });
    expect(workerAllows('POST', '/questions/answer', rules)).toBe(true);
    expect(workerAllows('POST', '/questions/answer', rules.filter((rule) => rule.path !== '/questions/answer'))).toBe(false);
  });

  it('同一条接口不重复登记', () => {
    const keys = PHONE_INTERFACES.map((one) => `${one.method} ${one.path}`);
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
  });

  it('⑤ 识别那条专门的路:两端逐字一样', () => {
    expect(workerConst(WORKER_ASR_FILE, 'ASR_TOPIC')).toBe(WBCH_ASR_TOPIC);
    expect(workerConst(WORKER_ASR_FILE, 'ASR_ID_ATTRIBUTE')).toBe(WBCH_ASR_ID_ATTRIBUTE);
    expect(workerConst(WORKER_ASR_FILE, 'ASR_PATH')).toBe(WBCH_ASR_PATH);
    expect(PHONE_INTERFACES.find((one) => one.path === WBCH_ASR_PATH)?.remote).toEqual({ via: 'asr' });
    // 识别不经通用代理:白名单里照旧没有 /butler/proxy/**(见 channel-worker/src/rpc.ts 那段注释)。
    expect(rules.some((rule) => typeof rule.path === 'string' ? rule.path.startsWith('/butler/proxy/') : rule.path.test('/butler/proxy/api/asr'))).toBe(false);
  });

  it('协作 RPC 只开放精确业务路由,不信任 peer 或开放连接与接收入口', () => {
    for (const [method, path] of [
      ['POST', '/collab/lan/connect'], ['POST', '/collab/lan/receive'],
      ['POST', '/collab/lan/members/remember'], ['POST', '/collab/lan/members/remove'],
      ['GET', '/collab/lan/peer-credentials'], ['POST', '/collab/lan/peer-credentials'],
      ['POST', '/pair/start'], ['POST', '/pair/claim'],
      ['POST', '/collab/lan/channel/source-policy'], ['POST', '/collab/lan/channel/publish'],
    ] as const) {
      expect(workerAllows(method, path, rules), `${method} ${path}`).toBe(false);
    }
    const expected = PHONE_INTERFACES.filter((one) => 'via' in one.remote && one.remote.via === 'proxy' && (one.path.startsWith('/collab/') || one.path === '/task/comment'));
    const collabRules = rules.filter((rule) => typeof rule.path === 'string' && (rule.path.startsWith('/collab/') || rule.path === '/task/comment'));
    expect(expected).toHaveLength(21);
    expect(collabRules.map((rule) => `${rule.method} ${rule.path}`).sort()).toEqual(expected.map((one) => `${one.method} ${one.path}`).sort());
    for (const one of expected) {
      expect(workerAllows(one.method, `${one.path}/extra`, rules), `${one.method} ${one.path}/extra`).toBe(false);
      const other = one.method === 'GET' ? 'POST' : 'GET';
      if (!expected.some((entry) => entry.method === other && entry.path === one.path)) {
        expect(workerAllows(other, one.path, rules), `${other} ${one.path}`).toBe(false);
      }
    }
  });
});
