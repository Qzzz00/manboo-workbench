// 给音色目录贴标签(2026-09-23,Ben:「怎么都是女的」)。
//
//     node butler-server/scripts/tag-voices.mjs
//
// 读 `server/services/volcVoiceCatalog.json`(火山账号控制台导出的公版音色清单),
// 按下面那两张**关键词表**推出性别 / 年龄感 / 风格,写出 `server/services/voices-catalog.json`。
//
// **这张表就是标签的全部出处**:没有人逐个听过这 99 个音色。
// 名字里推不出来的一律写「未标」——「未标」是一个真答案,她在电话里就这么说。
// 清单变了(换账号、火山上新)就重跑一次,顺手看一眼下面打印的分布对不对。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'services')
const src = JSON.parse(readFileSync(join(ROOT, 'volcVoiceCatalog.json'), 'utf8'))

const UNTAGGED = '未标'

const AGE_RULES = [
  ['儿童', /童声|萌娃|绘本|少儿|儿童|熊二|佩奇|樱桃丸子|奶气/],
  ['少年', /少年|梓辛|Brayan/],
  ['成熟', /婆婆|妈妈|大叔|青叔|小叔|御姐|老师|高管|武则天|霸总|顾姐/],
  ['青年', /学长|学姐|学妹|男大|大学生|同桌|弟弟|妹妹|少女|女生|男孩|女孩|青年|小哥|丫头|公主|姐姐|女友|少御|小东|沐沐/],
]

const STYLE_RULES = [
  ['温柔', /温柔|柔美|柔和|温润|贴心|温暖/],
  ['知性', /知性|文静|渊博|儒雅|君子/],
  ['沉稳', /沉稳|擎苍|浩然|四郎|悠悠/],
  ['活泼', /活泼|爽快|爽朗|开朗|快乐|活力|阳光|俏皮|调皮|撒娇|萌丫头|萌仔|奶气|亮嗓|直率|不羁|反卷/],
  ['甜美', /甜美|甜/],
  ['清新', /清新|清爽|清澈|清婉/],
  ['磁性', /磁性|深夜播客/],
  ['高冷', /高冷|傲娇|霸气|霸总|女雷神|武则天|御姐|顾姐/],
  ['亲切', /亲切|暖阳|鸡汤|心灵|邻家|魅力|苏菲/],
  ['古风', /古风/],
  ['解说腔', /解说|译制片|广告|悬疑/],
]

function genderOf(id) {
  if (/_female_/.test(id)) return '女'
  if (/_male_/.test(id)) return '男'
  return UNTAGGED
}

function ageOf(name) {
  for (const [tag, re] of AGE_RULES) if (re.test(name)) return tag
  return UNTAGGED
}

function stylesOf(name, scene) {
  const hit = STYLE_RULES.filter(([, re]) => re.test(name)).map(([tag]) => tag)
  if (scene === '角色扮演') hit.push('角色感')
  if (scene === '客服场景') hit.push('客服腔')
  if (scene === '有声阅读') hit.push('朗读腔')
  const uniq = [...new Set(hit)]
  return uniq.length === 0 ? [UNTAGGED] : uniq
}

function langOf(entry) {
  return entry.lang === 'en' ? '英文' : (entry.lang === 'zh' ? '中文' : UNTAGGED)
}

function accentOf(entry) {
  if (entry.lang === 'en') return '英语'
  if (/TVB|粤/.test(entry.name)) return UNTAGGED
  return entry.lang === 'zh' ? '普通话' : UNTAGGED
}

function blurbOf(e, gender, age, styles, lang) {
  const who = gender === UNTAGGED ? '这一个' : `${gender}声`
  const bits = []
  if (age !== UNTAGGED) bits.push(`${age}感`)
  const realStyles = styles.filter(s => s !== UNTAGGED && s !== '角色感' && s !== '客服腔' && s !== '朗读腔')
  if (realStyles.length > 0) bits.push(realStyles.join('、'))
  const tail = `火山「${e.scene}」那一档`
  if (bits.length === 0) {
    return `${lang}${who};年龄感与风格光看名字定不下来,没标。${tail}。`
  }
  return `${lang}${who},${bits.join('、')}。${tail}。`
}

const voices = src.map((e) => {
  const gender = genderOf(e.id)
  const age = ageOf(e.name)
  const styles = stylesOf(e.name, e.scene)
  const lang = langOf(e)
  return {
    id: e.id,
    name: e.name,
    scene: e.scene,
    lang,
    gender,
    age,
    styles,
    accent: accentOf(e),
    blurb: blurbOf(e, gender, age, styles, lang),
    // 可用性:来自这台后端自己的账号导出清单(supported)。不在清单里的一律「未验」。
    verified: e.supported === true,
  }
})

const out = {
  provider_type: 'volcengine',
  source: 'butler-server/server/services/volcVoiceCatalog.json —— 火山「大模型语音合成(SeedTTS)」公版音色清单,从**这台后端配着的那个账号**的控制台导出;supported=true 表示该账号已开通。',
  tagged_at: '2026-09-23',
  tagging_method: '性别取自音色 id 里的 _female_ / _male_(火山自己的命名,可靠)。年龄感与风格标签是**按音色名字与火山场景分类的关键词映射**推出来的,没有人逐个听过;名字里判断不出来的一律写「未标」,不编。',
  caveat: '这份目录里没有火山文档上的方言音色(粤语、四川话…)—— 这个账号的导出清单里一条都没有,凭空写进来会让她念出一个换不成的名字。',
  untagged: UNTAGGED,
  voices,
}

writeFileSync(join(ROOT, 'voices-catalog.json'), `${JSON.stringify(out, null, 2)}\n`)

const stat = (key) => {
  const m = new Map()
  for (const v of voices) {
    const val = Array.isArray(v[key]) ? v[key].join('+') : v[key]
    m.set(val, (m.get(val) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}
console.log('共', voices.length, '条;verified', voices.filter(v => v.verified).length)
console.log('性别', stat('gender'))
console.log('年龄', stat('age'))
console.log('未标风格', voices.filter(v => v.styles.includes(UNTAGGED)).length)
