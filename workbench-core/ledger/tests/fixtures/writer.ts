/**
 * 子进程写手:给「写后被杀再打开」与「快照与续流交错」两条用例用。
 *
 *   node writer.ts <库路径> kill               一直写,直到被 SIGKILL
 *   node writer.ts <库路径> stream <N> [fast]   写 N 条后正常退出;fast = 关 F_FULLFSYNC,提交更密,好撞读的竞态窗口
 *
 * 每一轮是一条请求(建对象 + 改一次状态 = 两条事件),提交返回后才在 stdout 打一行
 * `ok <i> <object_id> <seq>`;kill 模式另外把出站队列 relay 的 last_acked 推到这一轮的 seq。
 * 父进程只相信打出来的行:打出来的必须在库里,没打出来的可有可无,但不许出现半条记录。
 */
import { openLedger } from '../../index.ts'

const [path, mode, nArg, speed] = process.argv.slice(2)
if (!path || (mode !== 'kill' && mode !== 'stream')) {
  process.stderr.write('usage: writer.ts <db> kill|stream [N] [fast]\n')
  process.exit(2)
}

const ledger = openLedger(path, { origin: 'mac-a', fullfsync: speed !== 'fast' })
const actor = { person: 'alice', device: 'alice-mac' }
const limit = mode === 'stream' ? Number(nArg ?? 200) : Number.POSITIVE_INFINITY

for (let i = 0; i < limit; i++) {
  const out = ledger.request({ request_id: `req-${i}`, op: 'writer.round' }, (tx) => {
    const created = tx.emit({
      kind: 'object.created',
      object_id: tx.newObjectId(),
      actor,
      payload: { owner: 'alice', status: 'todo', data: { title: `第 ${i} 件`, round: i } },
    })
    const id = created.object_id as string
    const updated = tx.emit({ kind: 'object.updated', object_id: id, actor, payload: { status: 'doing' } })
    return { object_id: id, seq: updated.seq }
  })
  if (!out.ok) throw new Error(`round ${i} rejected: ${out.error.code}`)
  if (mode === 'kill') ledger.outbox.ack('relay', out.result.seq)
  process.stdout.write(`ok ${i} ${out.result.object_id} ${out.result.seq}\n`)
}

ledger.close()
