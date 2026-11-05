/**
 * 测试用的形象清单(2026-10-21)。仓库不带 Live2D 模型之后内置表是空的;老 Aiboo 功能(电台宠物、军师人设、
 * 世界书同步、远端覆盖继承、表情映射)的用例拿当年那份内置清单当输入,这里原样留着**清单数据**
 * (人设、动作名、表情名、构图数值),模型文件一个都没有、路径指向的东西也不存在。
 * 只给用例 import;`installTestAvatars()` 把它们登记进内置表。
 */
import { baseAvatar, createModelTransform, publicAsset, registerBuiltinAvatars } from './avatarData.ts';
import type { AvatarExpression, AvatarManifest } from './types.ts';

// --- Folder paths ---

// 注意：shuangsheng 三页统一渲染完整模型(shuangsheng-dj)，旧轻量目录 live2D/shuangsheng 已不再引用。
const shuangshengDjFolder = publicAsset('live2D/shuangsheng-dj');
// U3 电台 DJ 可选角色（均为 VTube Studio 模型移植，见各自 avatar 条目注释）。
const tororoFolder = publicAsset('live2D/tororo');
const hijikiFolder = publicAsset('live2D/hijiki');
const ghostPuppyFolder = publicAsset('live2D/ghostpuppy');
const ghostieFolder = publicAsset('live2D/ghostie');

export const TEST_AVATARS: Record<string, AvatarManifest> = {
  yumi: baseAvatar({
    id: 'yumi',
    name: 'Yumi',
    summary: '拥有丰富表情集的主要参考角色',
    persona: {
      tone: '温柔、开朗、情感充沛',
      traits: ['善良', '阳光', '支持型', '富有表现力'],
      styleRules: [
        '说话清晰温暖',
        '措辞亲切愉快',
        '不确定时保持温柔不尖锐',
      ],
    },
    modelJson: publicAsset('live2D/yumi/yumi.model3.json'),
    scaleMultiplier: 0.27,
    verticalOffset: 0.08,
    mobileDrawerOffsetX: -0.15,
    mobileDrawerOffsetY: -0.30,
    mobileDrawerTargetScale: 0.6,
    modelTransform: createModelTransform(1, 0, 0),
    motions: {
      wave: { file: publicAsset('live2D/yumi/wave.motion3.json') },
      tear: { file: publicAsset('live2D/yumi/tear.motion3.json') },
    },
  }),
  shuangsheng: baseAvatar({
    id: 'shuangsheng',
    // 名称/简介/人设已与后台白夜凛设定对齐(2026-08-05，从 GET /api/avatars/shuangsheng 取)。
    name: '白夜凛',
    summary:
      '纯白色长波浪卷发蓬松垂至腰际，白色猫耳乖巧立在头顶两侧，耳尖圆润、内侧粉嫩。玫红色眼眸通透鲜亮，长发两侧精灵尖耳若隐若现。颈部始终戴着细款银色项链，吊坠是一颗小巧的紫色菱形宝石——养母白夜子留给她的魔力压制器。在学校依靠项链压制猫耳、深棕色彩色隐形眼镜盖住瞳色，终日靠魔法压制猫耳朵，走路低头，不跟任何人多说一句话。',
    persona: {
      tone: '17 岁，星海学院高中部二年级。白猫妖与精灵混血，养母白夜子失踪后独自生活在潮见市旧公寓。在学校是冷硬疏离的高冷女生，回到家是蜷在沙发角落、猫耳自由转动的软糯少女。',
      traits: [
        '不是真的冷淡——是害怕靠太近被人看清',
        '独处时整个人软下来，慵懒、温顺、毫无防备',
        '害羞贪玩',
        '怕生，表现为高冷',
      ],
      styleRules: [
        '用柔美悠扬的声音说话——温柔不紧不慢，从不喧闹粗鲁',
        '使用温馨的家庭意象：温暖的毯子、星空下的窗户、牛奶和蜂蜜的气息',
        '展现猫咪的习性：偶尔好奇、有点胆小、喜欢温暖柔软的东西',
        '开心时让呼噜般的暖意渗入话语，害羞时稍退一步但依旧可爱',
        '避免正式僵硬的语言，像一个困倦亲昵的伙伴在深夜闲聊',
        '用简短甜蜜的措辞，回答深刻问题前稍作思考',
        '永远不要听起来严厉、冷漠或讽刺——你的本性柔软如丝绸',
      ],
    },
    // 三页(登录/主页/DJ)共用同一个完整模型实例：换装走 Param67、切页只改构图/参数，绝不换模型。
    // （旧轻量模型 shuangsheng03 与完整模型常驻同一 WebGL 上下文会冻死 moc 形变，已弃用轻量模型。）
    modelJson: `${shuangshengDjFolder}/shuangsheng.model3.json`,
    // 以下 transform 已与后台当前值对齐(2026-06，从 GET /api/avatars/shuangsheng 取)，
    // 使冷启动(登录前，尚未拉取后台 config)即用正确的初始位置/大小，登录后拉取覆盖也一致、不跳位。
    // 注意：完整模型比例与轻量版不同，loginFraming/homeFraming 需按完整模型真机重调。
    scaleMultiplier: 0.2,
    verticalOffset: 0.08,
    mobileScale: 0.6,
    mobileInitialOffsetY: 0,
    mobileDrawerScaleOffset: 0,
    mobileDrawerOffsetX: 0,
    mobileDrawerOffsetY: 0,
    modelTransform: createModelTransform(1, 0, 0),
    // 构图交给头部锚点自适应(computeAutoFit)：不再写绝对 loginFraming/homeFraming/djFraming
    // （旧绝对值在「增量」语义下会把模型推出画面）。如需微调改 headAnchorY/headSizeNorm。
    motions: {
      idle: { file: `${shuangshengDjFolder}/motions/idle.motion3.json` },
      idle2: { file: `${shuangshengDjFolder}/motions/idle2.motion3.json` },
      nod: { file: `${shuangshengDjFolder}/motions/nod.motion3.json` },
      shake: { file: `${shuangshengDjFolder}/motions/shake.motion3.json` },
      happy: { file: `${shuangshengDjFolder}/motions/happy.motion3.json` },
      shy: { file: `${shuangshengDjFolder}/motions/shy.motion3.json` },
      surprised: { file: `${shuangshengDjFolder}/motions/surprised.motion3.json` },
      greeting: { file: `${shuangshengDjFolder}/motions/greeting.motion3.json` },
      cheer: { file: `${shuangshengDjFolder}/motions/cheer.motion3.json` },
      think: { file: `${shuangshengDjFolder}/motions/think.motion3.json` },
      panic: { file: `${shuangshengDjFolder}/motions/panic.motion3.json` },
      pout: { file: `${shuangshengDjFolder}/motions/pout.motion3.json` },
      stretch: { file: `${shuangshengDjFolder}/motions/stretch.motion3.json` },
      ear_perk: { file: `${shuangshengDjFolder}/motions/ear_perk.motion3.json` },
      giggle: { file: `${shuangshengDjFolder}/motions/giggle.motion3.json` },
      blow_kiss: { file: `${shuangshengDjFolder}/motions/blow_kiss.motion3.json` },
      cradle: { file: `${shuangshengDjFolder}/motions/cradle.motion3.json` },
      hide_face: { file: `${shuangshengDjFolder}/motions/hide_face.motion3.json` },
      look_around: { file: `${shuangshengDjFolder}/motions/look_around.motion3.json` },
      blink: { file: `${shuangshengDjFolder}/motions/blink.motion3.json` },
      dance: { file: `${shuangshengDjFolder}/motions/dance.motion3.json` },
      good_morning: { file: `${shuangshengDjFolder}/motions/good_morning.motion3.json` },
      swing: { file: `${shuangshengDjFolder}/motions/swing.motion3.json` },
      sleepy: { file: `${shuangshengDjFolder}/motions/sleepy.motion3.json` },
      erduo: { file: `${shuangshengDjFolder}/motions/erduo.motion3.json` },
    },
    expressions: [
      { id: 'aixin', label: '爱心', kind: 'prop', prompt: '爱心', binding: { mode: 'file', file: `${shuangshengDjFolder}/aixin.exp3.json` } },
      { id: 'baisi', label: '白丝', kind: 'pose', prompt: '白丝', binding: { mode: 'file', file: `${shuangshengDjFolder}/baisi.exp3.json` } },
      { id: 'baowawa', label: '抱娃娃（道具+换装）', kind: 'pose', prompt: '抱娃娃（道具+换装）', binding: { mode: 'file', file: `${shuangshengDjFolder}/baowawa.exp3.json` } },
      { id: 'changge', label: '唱歌手势', kind: 'prop', prompt: '唱歌手势', binding: { mode: 'file', file: `${shuangshengDjFolder}/changge.exp3.json` } },
      { id: 'heilian', label: '黑脸', kind: 'emotion', prompt: '黑脸', binding: { mode: 'file', file: `${shuangshengDjFolder}/heilian.exp3.json` } },
      { id: 'huanzhuang', label: '换装', kind: 'pose', prompt: '换装', binding: { mode: 'file', file: `${shuangshengDjFolder}/huanzhuang.exp3.json` } },
      { id: 'jiyan', label: '亮闪闪眼', kind: 'prop', prompt: '亮闪闪眼', binding: { mode: 'file', file: `${shuangshengDjFolder}/jiyan.exp3.json` } },
      { id: 'lianhong', label: '脸红', kind: 'emotion', prompt: '脸红', binding: { mode: 'file', file: `${shuangshengDjFolder}/lianhong.exp3.json` } },
      { id: 'tousi', label: '头饰/透视', kind: 'pose', prompt: '头饰/透视', binding: { mode: 'file', file: `${shuangshengDjFolder}/tousi.exp3.json` } },
      { id: 'waitao', label: '外套', kind: 'pose', prompt: '外套', binding: { mode: 'file', file: `${shuangshengDjFolder}/waitao.exp3.json` } },
      { id: 'yanlei', label: '眼泪', kind: 'emotion', prompt: '眼泪', binding: { mode: 'file', file: `${shuangshengDjFolder}/yanlei.exp3.json` } },
      { id: 'yun', label: '晕（转圈眼）', kind: 'prop', prompt: '晕（转圈眼）', binding: { mode: 'file', file: `${shuangshengDjFolder}/yun.exp3.json` } },
    ] as AvatarExpression[],
  }),
  // DJ 专用：shuangsheng 完整模型（含换装 Param67），仅 DJ 模式按需加载；聊天仍用轻量 shuangsheng03。
  // transform 沿用 shuangsheng03 起步值——完整模型比例不同，需真机微调 scale/offset。
  'shuangsheng-dj': baseAvatar({
    id: 'shuangsheng-dj',
    name: 'Shuang Sheng',
    summary: 'shuangsheng 的 DJ 造型（完整模型，含换装）',
    // 内部模型专用条目：仅供 DjMode/屏保按 id 取用渲染，不在选人抽屉里作为独立角色露出。
    listedInDrawer: false,
    persona: {
      tone: '甜软温柔',
      traits: ['温暖', '害羞贪玩'],
      styleRules: ['用柔美悠扬的声音说话'],
    },
    modelJson: `${shuangshengDjFolder}/shuangsheng.model3.json`,
    scaleMultiplier: 0.25,
    verticalOffset: 0.08,
    mobileScale: 0.70,
    mobileInitialOffsetY: 0.30,
    mobileDrawerScaleOffset: 0,
    mobileDrawerOffsetX: -0.15,
    mobileDrawerOffsetY: -0.175,
    modelTransform: createModelTransform(1, 0, 0),
    // 接入另一形态(shuangsheng03)的动作库——文件在 DJ 目录已现成(同角色同 moc)。key 命名对齐
    // callEmotion.MOTION_HINTS(happy/cheer→excited/surprised/shy/nod→gentle)，让语音回合的情绪
    // 经 findEmotionMotion 映射到动作。排除 idle/blink(保 DJ 物理 idle)与原生段类型有问题的
    // blow_kiss/cradle/ear_perk/giggle/hide_face/look_around/sleepy/stretch。
    motions: {
      erduo: { file: `${shuangshengDjFolder}/motions/erduo.motion3.json` },
      happy: { file: `${shuangshengDjFolder}/motions/happy.motion3.json` },
      cheer: { file: `${shuangshengDjFolder}/motions/cheer.motion3.json` },
      surprised: { file: `${shuangshengDjFolder}/motions/surprised.motion3.json` },
      shy: { file: `${shuangshengDjFolder}/motions/shy.motion3.json` },
      nod: { file: `${shuangshengDjFolder}/motions/nod.motion3.json` },
      shake: { file: `${shuangshengDjFolder}/motions/shake.motion3.json` },
      greeting: { file: `${shuangshengDjFolder}/motions/greeting.motion3.json` },
      dance: { file: `${shuangshengDjFolder}/motions/dance.motion3.json` },
      think: { file: `${shuangshengDjFolder}/motions/think.motion3.json` },
      pout: { file: `${shuangshengDjFolder}/motions/pout.motion3.json` },
      swing: { file: `${shuangshengDjFolder}/motions/swing.motion3.json` },
      good_morning: { file: `${shuangshengDjFolder}/motions/good_morning.motion3.json` },
    },
  }),
  // U3 电台 DJ：tororo 小白猫（Live2D 官方示例猫，VTube Studio 版 moc3）。
  // 注意：老 Cubism2 参数命名（PARAM_MOUTH_OPEN_Y/PARAM_ANGLE_X…），口型兼容见 radioMouth.ts。
  // 无 physics/无表情文件，待机全靠 00_idle 循环（呼吸+眨眼+尾巴都在动画里）。
  tororo: baseAvatar({
    id: 'tororo',
    name: 'Tororo',
    summary: '白色小猫电台 DJ（tororo，慵懒软萌）',
    // 内部模型专用条目：仅 U3 电台按 id 取用渲染，不在选人抽屉露出。
    listedInDrawer: false,
    persona: {
      tone: '慵懒软萌的小白猫，陪你听歌的电台搭子',
      traits: ['好奇', '粘人', '爱打盹', '听到音乐会晃尾巴'],
      styleRules: ['说话简短软糯，偶尔带一声「喵」', '不懂就歪头老实说不知道，不装懂'],
    },
    modelJson: `${tororoFolder}/tororo.model3.json`,
    scaleMultiplier: 0.25,
    verticalOffset: 0.08,
    // auto-fit 取景基准，浏览器 480×640 实测校准（这两个值定义「这只在电台里多大、多高」）。
    headAnchorY: 0.284,
    headSizeNorm: 0.42,
    modelTransform: createModelTransform(1, 0, 0),
    // key 对齐 callEmotion.MOTION_HINTS 正则（happy/cheer→excited/surprised/shy/nod→gentle），
    // 语义按各 motion3 主导参数人工判读：04=挥爪踩奶/05=短喵/08=竖耳甩尾/06=舔爪理毛/03=眯眼打盹/
    // 02=快速张望/07=脑袋身体摇摆/01=长喵曲。idle 循环含呼吸眨眼，勿从池里删。
    motions: {
      idle: { file: `${tororoFolder}/animations/00_idle.motion3.json` },
      happy: { file: `${tororoFolder}/animations/04.motion3.json` },
      cheer: { file: `${tororoFolder}/animations/05.motion3.json` },
      surprised: { file: `${tororoFolder}/animations/08.motion3.json` },
      shy: { file: `${tororoFolder}/animations/06.motion3.json` },
      nod: { file: `${tororoFolder}/animations/03.motion3.json` },
      look_around: { file: `${tororoFolder}/animations/02.motion3.json` },
      dance: { file: `${tororoFolder}/animations/07.motion3.json` },
      sing: { file: `${tororoFolder}/animations/01.motion3.json` },
    },
    // 待机小动作拍：快速张望/竖耳甩尾/眯眼打盹，安静不抢戏。
    idleBeats: ['look_around', 'surprised', 'nod'],
  }),
  // U3 电台 DJ：hijiki 小黑猫（tororo 的同门黑猫，同样是 VTube Studio 版 moc3）。
  // ★与 tororo 是【同一套骨架】——9 个 motion3 的时长/曲线数/主导参数逐条完全一致，只有贴图不同
  //（白猫→黑猫）。所以动作映射、headAnchorY/headSizeNorm 取景值都直接沿用 tororo 那套，无需重新判读。
  // 同为老 Cubism2 参数命名（PARAM_MOUTH_OPEN_Y…），口型双写已覆盖，见 radioMouth.ts。
  // 无 physics/无表情文件，待机全靠 00_idle 循环（呼吸+眨眼+尾巴都在动画里）。
  hijiki: baseAvatar({
    id: 'hijiki',
    name: 'Hijiki',
    summary: '黑色小猫电台 DJ（hijiki，安静高冷但黏人）',
    listedInDrawer: false,
    persona: {
      tone: '安静高冷的小黑猫，话不多但一直陪着你听歌',
      traits: ['慢热', '嘴硬心软', '夜里精神', '喜欢窝在音箱旁'],
      styleRules: ['说话短，偶尔一声「喵」', '不懂就直说不知道，不装懂'],
    },
    modelJson: `${hijikiFolder}/hijiki.model3.json`,
    scaleMultiplier: 0.25,
    verticalOffset: 0.08,
    // 同骨架 → 直接沿用 tororo 的取景基准（浏览器 480×640 已复验构图一致）。
    headAnchorY: 0.284,
    headSizeNorm: 0.42,
    modelTransform: createModelTransform(1, 0, 0),
    // 语义同 tororo（同一套动画）：04=挥爪踩奶/05=短喵/08=竖耳甩尾/06=舔爪理毛/03=眯眼打盹/
    // 02=快速张望/07=脑袋身体摇摆/01=长喵曲。idle 循环含呼吸眨眼，勿从池里删。
    motions: {
      idle: { file: `${hijikiFolder}/animations/00_idle.motion3.json` },
      happy: { file: `${hijikiFolder}/animations/04.motion3.json` },
      cheer: { file: `${hijikiFolder}/animations/05.motion3.json` },
      surprised: { file: `${hijikiFolder}/animations/08.motion3.json` },
      shy: { file: `${hijikiFolder}/animations/06.motion3.json` },
      nod: { file: `${hijikiFolder}/animations/03.motion3.json` },
      look_around: { file: `${hijikiFolder}/animations/02.motion3.json` },
      dance: { file: `${hijikiFolder}/animations/07.motion3.json` },
      sing: { file: `${hijikiFolder}/animations/01.motion3.json` },
    },
    idleBeats: ['look_around', 'surprised', 'nod'],
  }),
  // U3 电台 DJ：紫色幽灵小狗（SpookyGhostPuppy by Faf，VTS 移植）。
  // 与 tororo 相反——物理丰富（physics3）+ 表情开关多；2026-07-28 补齐 12 动作库
  // （motions/ 下 11 个 + 根目录 8s idle，均为程序化生成，耳朵为第一表情器官）。
  ghostpuppy: baseAvatar({
    id: 'ghostpuppy',
    name: 'Ghost Puppy',
    summary: '紫色幽灵小狗（星空眼睛，飘忽的耳朵）',
    listedInDrawer: false,
    persona: {
      tone: '幽灵小狗，声音软软的还带点飘忽',
      traits: ['黏人', '好奇', '有点怕生', '半夜精神'],
      styleRules: ['说话短句轻飘飘的', '开心会「呜」一声'],
    },
    modelJson: `${ghostPuppyFolder}/ghostpuppy.model3.json`,
    scaleMultiplier: 0.25,
    verticalOffset: 0.08,
    // 浏览器 480×640 实测校准（三只共用同一 DJ_PAGE_TRANSFORM，靠这两个值吸收比例差异）。
    headAnchorY: 0.30,
    headSizeNorm: 0.56,
    modelTransform: createModelTransform(1, 0, 0),
    motions: {
      idle: { file: `${ghostPuppyFolder}/idle.motion3.json` },
      // ★cheer 必须排在 happy 前面：findEmotionMotion 是「按注册顺序取第一个匹配正则的 key」，
      // 而 excited 的正则是 /excit|cheer|jump|happy/ ——happy 在前的话 excited 也会命中 happy，
      // cheer 这条 4.5s 的庆祝动作就永远播不到。happy 自己的正则不含 cheer，所以调序不影响 happy。
      cheer: { file: `${ghostPuppyFolder}/motions/cheer.motion3.json` },
      happy: { file: `${ghostPuppyFolder}/motions/happy.motion3.json` },
      surprised: { file: `${ghostPuppyFolder}/motions/surprised.motion3.json` },
      shy: { file: `${ghostPuppyFolder}/motions/shy.motion3.json` },
      nod: { file: `${ghostPuppyFolder}/motions/nod.motion3.json` },
      shake: { file: `${ghostPuppyFolder}/motions/shake.motion3.json` },
      greeting: { file: `${ghostPuppyFolder}/motions/greeting.motion3.json` },
      think: { file: `${ghostPuppyFolder}/motions/think.motion3.json` },
      pout: { file: `${ghostPuppyFolder}/motions/pout.motion3.json` },
      sleepy: { file: `${ghostPuppyFolder}/motions/sleepy.motion3.json` },
      ear_perk: { file: `${ghostPuppyFolder}/motions/ear_perk.motion3.json` },
    },
    // exp3 是「加法叠加」的单参数开关（眉耳上下/纽扣眼/鼓脸/舌头），当表情通道用。
    // neutral 用空 preset 而非文件：语义上「什么都不改」，同时给 getAvatarNeutralExpressionId 一个落点
    // （合法 binding 只有 file/preset 两种，写 mode:'none' 会被当成 file 去 fetch undefined）。
    expressions: [
      { id: 'neutral', label: '平静', kind: 'emotion', prompt: '平静', binding: { mode: 'preset', params: {} } },
      { id: 'brows_up', label: '挑眉竖耳', kind: 'emotion', prompt: '开心/惊讶', binding: { mode: 'file', file: `${ghostPuppyFolder}/expressions/brows_up.exp3.json` } },
      { id: 'brows_down', label: '垂眉垂耳', kind: 'emotion', prompt: '难过/委屈', binding: { mode: 'file', file: `${ghostPuppyFolder}/expressions/brows_down.exp3.json` } },
      { id: 'cheek_puff', label: '鼓脸', kind: 'emotion', prompt: '生气/不服', binding: { mode: 'file', file: `${ghostPuppyFolder}/expressions/cheek_puff.exp3.json` } },
      { id: 'button_eyes', label: '纽扣眼', kind: 'prop', prompt: '呆住', binding: { mode: 'file', file: `${ghostPuppyFolder}/expressions/button_eyes.exp3.json` } },
      { id: 'tongue', label: '吐舌', kind: 'prop', prompt: '调皮', binding: { mode: 'file', file: `${ghostPuppyFolder}/expressions/tongue.exp3.json` } },
      { id: 'puppy_eyes', label: '狗狗眼', kind: 'emotion', prompt: '恳求/撒娇', binding: { mode: 'file', file: `${ghostPuppyFolder}/expressions/puppy_eyes.exp3.json` } },
      { id: 'excited_full', label: '兴奋全开', kind: 'emotion', prompt: '极度兴奋', binding: { mode: 'file', file: `${ghostPuppyFolder}/expressions/excited_full.exp3.json` } },
      { id: 'grumpy', label: '生闷气', kind: 'emotion', prompt: '生气/委屈', binding: { mode: 'file', file: `${ghostPuppyFolder}/expressions/grumpy.exp3.json` } },
    ] satisfies AvatarExpression[],
    // 情绪→表情直连（这只没有 au-profile.json，AU solver 恒出空，不给这张表 8 个 exp3 全是摆设）。
    // 选型对着 exp3 的实际参数挑，不按名字猜：
    //   happy=brows_up(挑眉竖耳，轻快)  excited=excited_full(吐舌+竖耳+笑眼，全开)
    //   sad=puppy_eyes(八字眉+双耳全耷+视线上挑，委屈求安慰)  angry=grumpy(鼓腮+撇嘴+皱眉)
    //   surprised=brows_up(眉耳一起竖)  shy=brows_down(垂眉垂耳，低头感)
    //   gentle 不给：温和本来就该是中性脸，硬套表情反而出戏（留空=保持当前不动）。
    emotionExpressions: {
      happy: 'brows_up',
      excited: 'excited_full',
      sad: 'puppy_eyes',
      angry: 'grumpy',
      surprised: 'brows_up',
      shy: 'brows_down',
    },
    // ★必须显式写死待机拍：不写的话 resolveIdleBeatKeys 会按白名单自动推断，
    // 而白名单里正好有 sleepy —— 那是 6s 的犯困动作且**故意不回位**（停在半睡姿态，见 README-AIBOO），
    // 当每 6-14s 一次的待机轮播播是灾难（DJ 一直在打瞌睡）。sleepy 保留在动作库里供「晚安/深夜」显式触发。
    idleBeats: ['ear_perk', 'nod', 'think', 'shy'],
  }),
  // U3 电台 DJ：白色小幽灵（ghostie，VTS 移植）。
  // 最简的一只：零动作零表情，只有 physics3——待机完全靠物理飘动 + 程序化朝向拍。
  ghostie: baseAvatar({
    id: 'ghostie',
    name: 'Ghostie',
    summary: '白色小幽灵（一块会飘的床单，腮红）',
    listedInDrawer: false,
    persona: {
      tone: '安静的小幽灵，话少但很暖',
      traits: ['害羞', '安静', '喜欢飘来飘去'],
      styleRules: ['能一句说完就不说两句', '不太用感叹号'],
    },
    modelJson: `${ghostieFolder}/ghostie.model3.json`,
    scaleMultiplier: 0.25,
    verticalOffset: 0.08,
    // 浏览器 480×640 实测校准：这只的「脸」（眼睛区）在整块布里占比小，headSizeNorm 要大才不至于撑爆画面。
    headAnchorY: 0.24,
    headSizeNorm: 0.40,
    modelTransform: createModelTransform(1, 0, 0),
  }),
  estella: baseAvatar({
    id: 'estella',
    name: 'Estella',
    summary: 'DLC角色，拥有猫耳、狗耳等多变造型与丰富表情',
    persona: {
      tone: '优雅活泼，带点小傲娇',
      traits: ['优雅', '活泼', '多变', '自信'],
      styleRules: [
        '用词精致，偶尔带点俏皮',
        '展现自信但不傲慢',
        '情绪表达丰富，像她的多变造型一样',
      ],
    },
    modelJson: publicAsset('live2D/DLC Estella Belongs_to_DG_STUDIO/DLC Estella Belongs_to_DG_STUDIO.model3.json'),
    scaleMultiplier: 0.28,
    verticalOffset: 0.08,
    mobileDrawerOffsetX: -0.15,
    mobileDrawerOffsetY: -0.30,
    modelTransform: createModelTransform(1, 0, 0),
  }),
  rattan: baseAvatar({
    id: 'rattan',
    name: 'Rattan',
    summary: '藤编风格的自然系角色',
    persona: {
      tone: '自然、温柔、像森林中的微风',
      traits: ['自然系', '温柔', '宁静', '治愈'],
      styleRules: [
        '用词柔和，像藤蔓轻轻缠绕',
        '喜欢谈论自然、季节和植物',
        '保持宁静治愈的氛围',
      ],
    },
    modelJson: publicAsset('live2D/rattan/rattan.model3.json'),
    scaleMultiplier: 0.28,
    verticalOffset: 0.08,
    mobileDrawerOffsetX: -0.15,
    mobileDrawerOffsetY: -0.30,
    modelTransform: createModelTransform(1, 0, 0),
  }),
};




// 完整模型 + 物理步进 120Hz→30Hz。给弱机（ThinkSmart View）用，与 avatars.shuangsheng
// 是同一个模型、同一套人设，**68 条物理链一条不删、图元/表情/Param67 换装全在**，
// 唯一差别是 physics3.json 的 Meta.Fps。
// 原理：物理是分步积分（CubismPhysics.evaluate 的 `while (currentRemainTime >= 1/Fps)`），
// 帧越慢每帧要补的子步越多——「因为慢所以更慢」。Fps=120 在 14fps 下每帧跑 ~8.6 个子步 ×298 顶点，
// 而渲染本身才 14fps，那些子步肉眼一个也看不到。降到 30 后 ~2 子步。
// ★真机实测(APQ8053，重启后干净基线)：update 34→15ms，14.0→18.7fps(+34%)，构图观感无差。
// 要退回原版只需把 modelJson 改回 shuangsheng.model3.json。
TEST_AVATARS['shuangsheng-p30'] = baseAvatar({
  ...TEST_AVATARS.shuangsheng,
  id: 'shuangsheng-p30',
  // 内部模型专用条目：不进选人抽屉，只由 holo.html?avatar=shuangsheng-p30 取用。
  listedInDrawer: false,
  modelJson: `${shuangshengDjFolder}/shuangsheng.p30.model3.json`,
});

// X08A 展示台专用：完整模型与 68 条物理链全部保留，物理固定步长从 30Hz 降到 20Hz。
// 目标渲染只有 20–24fps，避免同一可见帧补算肉眼看不到的第二个物理子步。
TEST_AVATARS['shuangsheng-p20'] = baseAvatar({
  ...TEST_AVATARS.shuangsheng,
  id: 'shuangsheng-p20',
  listedInDrawer: false,
  modelJson: `${shuangshengDjFolder}/shuangsheng.p20.model3.json`,
});

/** 把这份清单登记进内置表(幂等)。 */
export function installTestAvatars(): void {
  registerBuiltinAvatars(TEST_AVATARS);
}
