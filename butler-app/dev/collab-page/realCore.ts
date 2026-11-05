/** 手机协作验收专用：真实 WorkbenchServer，所有用户资料只落调用方的临时目录。 */
import { join } from 'node:path';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { startWorkbenchServer } from '#qa-core/server/http.ts';
import { createWorkbenchService } from '#qa-core/server/service.ts';
import { createTasksService } from '#qa-core/server/tasks.ts';
import { createJobLog } from '#qa-core/server/jobLog.ts';
import { createPersonalTokens } from '#qa-core/server/personalToken.ts';
import { createAppConfig } from '#qa-core/server/appConfig.ts';
import { createPairingService } from '#qa-core/server/devices.ts';
import { createRegistry } from '#qa-core/server/engine/registry.ts';
import { createEngine } from '#qa-core/server/engine/engine.ts';
import { createActionGate } from '#qa-core/server/actionGate.ts';
import { jobPhaseOf } from '#qa-core/server/jobKey.ts';
import { resolveAgentCli } from '#qa-core/server/agentDispatch.ts';
import { lowPriorityCommand } from '#qa-core/server/lowPriority.ts';
import type { CliAdapterDeps } from '#qa-core/server/engine/adapters/cli.ts';

export async function startCollabQaCore(options: { dir: string; port?: number; realCodex?: boolean }) {
  const { dir } = options;
  const taskFile = join(dir, 'tasks.json');
  const service = createWorkbenchService();
  const tasks = createTasksService({ file: taskFile });
  const jobLog = createJobLog({ file: join(dir, 'jobs.jsonl') });
  await jobLog.load();
  const registry = createRegistry();
  const gate = createActionGate({ log: jobLog, now: () => new Date(), phaseOf: (job) => {
    try { return jobPhaseOf({ job, tasks: JSON.parse(readFileSync(taskFile, 'utf8')).tasks, sessions: service.getState().sessions }); }
    catch { return 'unknown'; }
  } });
  const engine = createEngine({ registry, gate, log: jobLog });
  const children = new Set<ReturnType<typeof spawn>>();
  const runCli: CliAdapterDeps['runCli'] = (cmd) => {
    mkdirSync(join(dir, 'dispatch'), { recursive: true });
    const fd = openSync(cmd.logFile, 'a', 0o600);
    const low = lowPriorityCommand(cmd.bin, cmd.argv);
    const child = spawn(low.file, low.args, { cwd: cmd.cwd, env: cmd.env ?? process.env, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    children.add(child);
    const exited = new Promise<{ code: number | null }>((resolve) => {
      child.once('exit', (code) => { children.delete(child); resolve({ code }); });
      child.once('error', () => { children.delete(child); resolve({ code: null }); });
    });
    return { ...(child.pid === undefined ? {} : { pid: child.pid }), exited };
  };
  const core = await startWorkbenchServer({
    port: options.port ?? 0,
    host: '127.0.0.1',
    service,
    tickIntervalMs: 0,
    tasks,
    jobLog,
    credentialFile: join(dir, 'devices.json'),
    pairing: createPairingService({ file: join(dir, 'devices.json') }),
    personalTokens: createPersonalTokens({ file: join(dir, 'pat.json') }),
    collabWorkdir: async () => join(dir, 'work'),
    ...(options.realCodex === true ? { engine, engineRegistry: registry, actionGate: gate } : {}),
    dispatchRun: {
      skillsRoot: join(dir, 'skills'),
      ...(options.realCodex !== true ? {} : {
        pollMs: 500, resultDir: join(dir, 'dispatch'), runCli,
        resolveCli: (family: Parameters<CliAdapterDeps['resolveCli']>[0]) => family === 'codex' ? resolveAgentCli(family, { pathEnv: process.env.PATH, home: dir, exists: existsSync }) : { found: false, family, why: '该受控验收只启用已授权 Codex' },
      }),
    },
    paths: { home: dir, moduleDir: dir, config: createAppConfig({ file: join(dir, 'app.json') }) },
  });
  if (options.realCodex === true) await registry.targets();
  return { ...core, async close() { await core.close(); for (const child of children) child.kill('SIGTERM'); } };
}
