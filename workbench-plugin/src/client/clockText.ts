/**
 * 顶栏右端那一小行:公历日期 · 农历 · 时刻(2026-09-26,维护者:「顶部栏右侧只有时间,没有日期,最好公历和农历都要有」)。
 *
 * 农历不引库:用浏览器自带的 `Intl` 中国农历(`zh-CN-u-ca-chinese`),WKWebView / Chrome 都有。
 * `dateStyle:'long'` 回的是「2026丙午年八月十六」,只取「年」之后那段(「八月十六」「闰四月初三」)。
 * 拿不到农历(老引擎、认不出的时刻)就只写公历,不编一个。
 */
const GREGORIAN = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' })

const LUNAR_MONTHS = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊']
const LUNAR_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

/** 农历的日子写法:初一 … 初十、十一 … 十九、二十、廿一 … 廿九、三十。 */
function lunarDay(day: number): string | undefined {
  if (!Number.isInteger(day) || day < 1 || day > 30) return undefined
  if (day <= 10) return `初${LUNAR_DIGITS[day]}`
  if (day < 20) return `十${LUNAR_DIGITS[day - 10]}`
  if (day === 20) return '二十'
  if (day < 30) return `廿${LUNAR_DIGITS[day - 20]}`
  return '三十'
}

/**
 * 农历「八月十六」「闰六月初一」。月份要它自己的字(Node 与 JavaScriptCore 都回「八月」,闰月带「闰」);
 * 日子两边引擎回的都是数字(JavaScriptCore 连 dateStyle:'long' 都写「八月16」),所以日子自己折成中文。
 */
function lunarOf(date: Date): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' }).formatToParts(date)
    const pick = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
    const rawMonth = pick('month')
    const month = rawMonth.includes('月')
      ? rawMonth
      : /^\d{1,2}$/.test(rawMonth) && LUNAR_MONTHS[Number(rawMonth) - 1] !== undefined ? `${LUNAR_MONTHS[Number(rawMonth) - 1]}月` : ''
    const day = lunarDay(Number(pick('day')))
    if (month === '' || day === undefined) return undefined
    return `${month}${day}`
  }
  catch {
    return undefined
  }
}

/** 「9月26日 周六」:Intl 回的是「9/26周六」,拆成中文写法(周几靠它自己认,不写死表)。 */
function gregorianOf(date: Date): string {
  const parts = GREGORIAN.formatToParts(date)
  const pick = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  const month = pick('month')
  const day = pick('day')
  const weekday = pick('weekday')
  if (month === '' || day === '') return ''
  return `${month}月${day}日${weekday === '' ? '' : ` ${weekday}`}`
}

/** 顶栏那一行:`9月26日 周六 · 八月十六 · 16:22`;时刻认不出回 `--:--`,农历拿不到就没有那一段。 */
export function topClockText(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--'
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const pieces = [gregorianOf(date), lunarOf(date), hhmm].filter(piece => piece !== undefined && piece !== '')
  return pieces.join(' · ')
}
