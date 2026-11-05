/**
 * 理解中枢的硬护栏(设计第五节):**只此一处**。
 *
 * - 取消 / 删除(卡取消、目标不要了)、花钱、对外发出、动她的账号与设备 → 不办,改成问一句,原命令挂起等她点头;
 * - 不可改清单(PRD §9:AI 悬浮窗、回滚机制、记忆读写规则、日结功能本身、澄清环节)被要求拿掉 / 关掉 → 拒,说明为什么。
 *
 * 风险只看**动作**:护栏读的是命令,不是句子里有没有某个词 —— 待办标题里写「发给客户」不是外发。
 * 派活的文字是交给执行者的那段话,它说要发版 / 推公网 / 付款,执行者就会真去做,所以派活的文字要核。
 */
import type { HubCommand, HubResult } from './commands.ts'
import type { HubContext } from './context.ts'

/** 派活文字里的高风险动作(执行者真会去做的那几样)。 */
const RISK_ACTS: readonly { re: RegExp, what: string }[] = [
  { re: /付款|支付|购买|下单|充值|续费|开通会员|花钱/u, what: '要花钱' },
  { re: /发版|publish-update|推(?:到)?公网|对外发布|发布到(?:公网|官网|应用商店)|发(?:给|到)(?:客户|外部)|群发|发邮件给/u, what: '要对外发出去' },
  { re: /退出登录|注销|解绑|重置密码|换绑|删除账号|配对(?:新|别的)?设备/u, what: '要动你的账号或设备' },
]

const IMMUTABLE = /(?:AI\s*)?悬浮(?:窗|球)|回滚(?:机制)?|记忆(?:读写)?(?:规则)?|日结|澄清(?:环节)?/u
const REMOVE = /删|去掉|拿掉|关掉|关闭|停用|废掉|撤掉|不要了/u

export const IMMUTABLE_WHY = '这是不可改清单里的一项(AI 悬浮窗、回滚机制、记忆读写规则、日结、澄清环节),不能拿掉或关掉'

function touchesImmutable(text: string): boolean {
  const hit = IMMUTABLE.exec(text)
  if (hit === null) return false
  // 只拦「拿掉 / 关掉」那一类:修它、调它的样子不算触及。
  const around = text.slice(Math.max(0, hit.index - 12), hit.index + hit[0].length + 12)
  return REMOVE.test(around)
}

function cardTitle(ctx: HubContext, id: string): string {
  const card = ctx.cards.find(one => one.id === id)
  return card === undefined ? id : `${id}「${card.title}」`
}

function goalTitle(ctx: HubContext, id: string): string {
  const goal = ctx.goals.find(one => one.id === id)
  return goal === undefined ? id : `目标「${goal.title}」`
}

export interface GuardedAsk { question: string, options: readonly string[], held: HubCommand }

export function guardCommands(commands: readonly HubCommand[], ctx: HubContext, opts: { confirmed?: boolean } = {}): {
  pass: HubCommand[]
  asks: GuardedAsk[]
  refused: HubResult[]
} {
  const pass: HubCommand[] = []
  const asks: GuardedAsk[] = []
  const refused: HubResult[] = []
  for (const command of commands) {
    const words = command.name === 'dispatch' ? `${command.text}\n${command.new?.title ?? ''}`
      : command.name === 'user_layer_fix' ? command.said
        : command.name === 'remember' ? command.text
          : command.name === 'note' ? command.title
            : ''
    if (words !== '' && touchesImmutable(words)) {
      refused.push({ command: command.name, ok: false, did: `「${words.split('\n')[0]!.slice(0, 40)}」没办`, why: IMMUTABLE_WHY })
      continue
    }
    if (opts.confirmed === true) { pass.push(command); continue }
    if (command.name === 'cancel' || (command.name === 'move_status' && command.status === 'canceled')) {
      asks.push({ question: `要把 ${cardTitle(ctx, command.card_id)} 取消吗?`, options: ['取消它', '先留着'], held: command })
      continue
    }
    if (command.name === 'goal_status' && command.status === 'dropped') {
      asks.push({ question: `${goalTitle(ctx, command.goal_id)}标成「不要了」吗?`, options: ['不要了', '先留着'], held: command })
      continue
    }
    if (command.name === 'dispatch') {
      const act = command.risk === 'money' ? '要花钱' : command.risk === 'external' ? '要对外发出去' : command.risk === 'account' ? '要动你的账号或设备'
        : RISK_ACTS.find(one => one.re.test(command.text))?.what
      if (act !== undefined) {
        const target = command.card_id === undefined ? `「${command.new?.title ?? command.text.slice(0, 30)}」` : cardTitle(ctx, command.card_id)
        asks.push({ question: `${target}这件${act},你点头我再派?`, options: ['派吧', '先别'], held: command })
        continue
      }
    }
    pass.push(command)
  }
  return { pass, asks, refused }
}
