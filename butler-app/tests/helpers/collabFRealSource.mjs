/** 原F手机验收专用；真实FeedService/任务API/LAN，所有存储与时钟均在自有隔离目录。 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { startWorkbenchServer } from '#qa-core/server/http.ts';
import { createWorkbenchService } from '#qa-core/server/service.ts';
import { createTasksService } from '#qa-core/server/tasks.ts';
import { createPairingService } from '#qa-core/server/devices.ts';
import { createFeedService } from '#qa-core/server/feed.ts';
import { createJobLog } from '#qa-core/server/jobLog.ts';
import { createPersonalTokens } from '#qa-core/server/personalToken.ts';
import { createAppConfig } from '#qa-core/server/appConfig.ts';
export async function startOriginalFMobileQa({ root, portA = 0, portB = 0 }) {
  let clock = Date.parse('2026-10-18T12:00:00+08:00'), originBase = '', originStopped = false;
  const origin = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url?.startsWith('/notice') ? { title: '本轮受控HTTP公告', observed_at: new Date().toISOString(), scope: '仅验收用本地来源服务' } : {
      report: { date: '2026-10-19', sections: [{ label: '受控来源', items: [{ title: '本轮来源公告材料', summary: '实际运行的受控HTTP服务正在响应；仅测试FeedService标准接收与传输，不冒外部新闻采集。', publishedAt: '2026-10-19T09:30:00+08:00', source: { name: '原公告发布者-' + '长来源名称'.repeat(20) }, links: { original: originBase + '/notice?material=' + 'a'.repeat(700) } }] }] } }));
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve)); originBase = `http://127.0.0.1:${origin.address().port}`;
  const stopOrigin = async () => { if (!originStopped) { originStopped = true; await new Promise((resolve, reject) => origin.close(error => error ? reject(error) : resolve())); } };
  async function instance(name, port, withFeed) {
    const dir = join(root, name); mkdirSync(dir, { recursive: true });
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => clock / 1000 });
    const feed = withFeed ? createFeedService({ file: join(dir, 'feed.json'), configFile: join(dir, 'feed-config.json'), projects: async () => [], now: () => clock,
      aihotDaily: async () => (await fetch(originBase + '/daily')).json() }) : undefined;
    if (feed) { await feed.load(); await feed.setConfig({ podcast: false }); }
    const core = await startWorkbenchServer({ host: '127.0.0.1', port, tickIntervalMs: 0, tasks, dispatchRun: { skillsRoot: join(dir, 'skills') }, service: createWorkbenchService({ now: () => clock / 1000 }), jobLog: createJobLog({ file: join(dir, 'jobs.jsonl') }),
      ...(feed ? { feed } : {}), pairing: createPairingService({ file: join(dir, 'devices.json') }), credentialFile: join(dir, 'devices.json'),
      personalTokens: createPersonalTokens({ file: join(dir, 'pat.json') }), collabWorkdir: async () => join(dir, 'work'), paths: { home: dir, moduleDir: dir, config: createAppConfig({ file: join(dir, 'app.json') }) } });
    return { ...core, dir };
  }
  async function api(core, path, body) {
    const response = await fetch(core.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${data.error ?? 'unknown'}`);
    return data;
  }
  let a, b;
  try {
    a = await instance('sender', portA, true); b = await instance('receiver', portB, false);
    const project = 'aihot-daily';
    for (let i = 0; i < 12; i++) await api(a, '/task/create', { title: `受控材料${i}:` + '跨机引用边界与长文本可读性'.repeat(20), project_id: project, status: 'blocked', block_reason: 'approval', assignee: 'me', from: { kind: 'user', quote: '隔离周日正常API建立测试项目材料' }, acceptance: ['作为报告来源；不执行模型任务'] });
    await api(b, '/task/create', { title: '接收端加入同项目', project_id: project, status: 'todo', assignee: 'me', from: { kind: 'user', quote: '隔离测试成员项目登记' }, acceptance: ['只读频道'] });
    const bId = (await api(b, '/collab/lan/identity')).identity.member_id;
    const code = (await api(b, '/pair/start', {})).pairing.code;
    await api(a, '/collab/lan/connect', { host: '127.0.0.1', port: b.port, code, member_id: bId });
    const aId = (await api(a, '/collab/lan/identity')).identity.member_id;
    const reverseCode = (await api(a, '/pair/start', {})).pairing.code;
    await api(b, '/collab/lan/connect', { host: '127.0.0.1', port: a.port, code: reverseCode, member_id: aId });
    clock = Date.parse('2026-10-19T10:00:00+08:00');
    const feedRun = await api(a, '/feed/run', {});
    if (feedRun.added !== 1) throw new Error('controlled real feed did not ingest exactly one source');
    await api(a, '/collab/lan/channel/source-policy', { project_id: project, enabled: true, recipients: [bId], categories: ['news', 'daily', 'weekly'], expected_version: 0 });
    const published = await api(a, '/collab/lan/channel/publish', { project_id: project });
    if (!published.ok || published.messages.length !== 3) throw new Error('normal source publisher did not publish three actual snapshots');
    const legacy = await api(a, '/collab/lan/channel/send', { project_id: project, text: '日报周报资讯关键词不产生分类；普通协作留言', recipients: [bId], client_msg_id: 'qa-f-legacy' });
    await api(b, '/collab/lan/channel/send', { kind: 'report', project_id: project, reply_to: legacy.message.id, text: '做完:已收到原协作留言；这是执行回执，不是项目日报', recipients: [aId], client_msg_id: 'qa-f-report' });
    const channel = `/collab/lan/channel?project_id=${project}`;
    const before = await api(b, channel);
    if (before.messages.length !== 5) throw new Error('legacy/report brothers were not preserved');
    let receiverClosed = false;
    return {
      root, project, sender: a,
      get receiver() { return b; },
      originUrl: originBase + '/notice',
      initial: { sender: await api(a, channel), receiver: before, feed: feedRun },
      async stopOrigin() { await stopOrigin(); await api(a, '/feed/run', {}); },
      async closeReceiver() { if (!receiverClosed) { receiverClosed = true; await b.close(); } },
      async restartReceiver() { if (!receiverClosed) await b.close(); b = await instance('receiver', portB, false); receiverClosed = false; return { url: b.url, port: b.port }; },
      async close() { await a.close(); if (!receiverClosed) await b.close(); await stopOrigin(); },
    };
  } catch (error) { await a?.close(); await b?.close(); await stopOrigin(); throw error; }
}
