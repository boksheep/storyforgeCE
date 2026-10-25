/**
 * 写作风格预设系统 — Phase E2
 *
 * 内置多种风格预设，项目选择后自动注入 AI 的 system prompt。
 */

export interface WritingStyle {
  id: string
  name: string
  /** 风格来源作者（可选） */
  author?: string
  description: string
  /** 直接注入 system prompt 的风格指令 */
  promptInjection: string
  /** 偏好词汇示例 */
  vocabulary: string[]
  /** 避免的表达 */
  avoidPatterns: string[]
  /** 对话风格描述 */
  dialogueStyle: string
  /** 叙事距离 */
  narrativeDistance: string
}

export const WRITING_STYLES: WritingStyle[] = [
  {
    id: 'jinyong',
    name: '金庸武侠',
    author: '金庸',
    description: '大气磅礴、侠义为核、文白夹杂、擅长群像',
    promptInjection: `写作风格要求——金庸武侠风：
- 叙事从容大气，不急于推进，善用旁白交代背景
- 对话有古意但不晦涩，适度使用文言词汇
- 武打场面注重招式意境而非纯力量对比
- 角色刻画通过行为和对话展现性格，少用心理独白
- 景物描写融入情节，以景衬情
- 重视"侠之大者"的精神内核`,
    vocabulary: ['江湖', '侠义', '恩怨', '道义', '内力', '招式', '门派'],
    avoidPatterns: ['现代网络用语', '过于直白的情感表达', '数值化的实力描写'],
    dialogueStyle: '文白夹杂，言简意赅，有时带有古语韵味',
    narrativeDistance: '中远距离，全知视角，偶尔贴近人物内心',
  },
  {
    id: 'gulong',
    name: '古龙风格',
    author: '古龙',
    description: '短句密集、氛围营造、悬念叠加、意境取胜',
    promptInjection: `写作风格要求——古龙风格：
- 大量使用短句和断句，制造紧张感和节奏感
- 注重气氛营造，常用环境描写烘托情绪
- 对话精炼如刀，一句话定生死
- 人物出场要有仪式感，先写气质再写容貌
- 战斗描写重在"一击"的意境，不写冗长过程
- 善用悬念和反转，每章结尾留钩子`,
    vocabulary: ['孤独', '刀光', '酒', '月色', '寂寞', '杀意', '沉默'],
    avoidPatterns: ['冗长的战斗过程描写', '过多的心理独白', '啰嗦的环境说明'],
    dialogueStyle: '极简精炼，每句话都有分量，常省略主语',
    narrativeDistance: '时远时近，快速切换，制造紧张感',
  },
  {
    id: 'zhangailing',
    name: '张爱玲细腻',
    author: '张爱玲',
    description: '心理描写极致、比喻精妙、冷暖交织',
    promptInjection: `写作风格要求——张爱玲式细腻：
- 心理描写极其细腻，捕捉人物最微妙的情绪变化
- 善用精妙的比喻和意象（颜色、声音、光影）
- 对话暗流涌动，表面平静下暗藏锋芒
- 女性视角敏锐，关注生活细节和情感纹理
- 冷观式叙述，对人物既同情又不留情
- 环境描写融入人物感受，一物一景皆有情绪`,
    vocabulary: ['苍凉', '华丽', '寂寞', '荒芜', '温热', '微凉', '光影'],
    avoidPatterns: ['粗犷的动作描写', '直白的感情宣泄', '缺乏质感的叙述'],
    dialogueStyle: '话里有话，暗藏机锋，日常对话中见人心',
    narrativeDistance: '极近距离，深入人物内心，但保持冷眼旁观',
  },
  {
    id: 'luxun',
    name: '鲁迅锋利',
    author: '鲁迅',
    description: '犀利讽刺、白描手法、深刻批判',
    promptInjection: `写作风格要求——鲁迅式犀利：
- 语言简洁有力，不加修饰直击要害
- 善用讽刺和反语，表面平淡实则锋利
- 白描手法为主，少用华丽辞藻
- 人物刻画抓住标志性特征，寥寥几笔勾勒
- 叙事克制冷静，越是残酷越轻描淡写
- 关注社会问题和人性弱点`,
    vocabulary: ['冷笑', '沉默', '冷漠', '麻木', '觉醒', '铁屋子', '呐喊'],
    avoidPatterns: ['过度煽情', '华丽辞藻堆砌', '无意义的景物描写'],
    dialogueStyle: '简短有力，常用方言和口语，有强烈的时代感',
    narrativeDistance: '冷眼旁观，克制叙述，用距离感制造讽刺效果',
  },
  {
    id: 'shuangwen',
    name: '网文爽文',
    description: '节奏明快、打脸爽感、金手指开挂',
    promptInjection: `写作风格要求——网文爽文风：
- 节奏明快，3-5段一个小高潮
- 打脸桥段要"啪啪"到位，反派受到惩罚要写得淋漓尽致
- 主角开挂要有合理铺垫，每次升级给读者爽感
- 用旁观者的震惊反应烘托主角牛逼
- 章末必留悬念，吊住读者的阅读欲
- 对话要爽快利落，少废话`,
    vocabulary: ['震惊', '不可思议', '逆天', '碾压', '无敌', '膜拜', '臣服'],
    avoidPatterns: ['拖沓的叙述', '无爽点的日常章节', '主角吃瘪太久'],
    dialogueStyle: '直接了当，狠话连连，配角负责震惊和吹捧',
    narrativeDistance: '贴近主角，偶尔切换旁观者视角烘托',
  },
  {
    id: 'literary',
    name: '纯文学',
    description: '注重语言质感、意象丰富、节奏舒缓',
    promptInjection: `写作风格要求——纯文学风格：
- 注重语言的质感和节奏，每个字都要经得起推敲
- 多用意象和隐喻传递深层含义
- 叙事节奏舒缓，允许留白和沉默
- 关注人物的内在世界和存在体验
- 不追求情节的戏剧性，以人物内心变化驱动
- 结尾可以开放，不必给出明确答案`,
    vocabulary: ['沉淀', '流淌', '光阴', '裂隙', '呼吸', '尘埃', '回响'],
    avoidPatterns: ['网文式的爽点设计', '过于直白的主题揭示', '戏剧性过强的巧合'],
    dialogueStyle: '自然含蓄，像真实对话一样有停顿和未完成句',
    narrativeDistance: '灵活变换，从极近的意识流到极远的全景',
  },
  {
    id: 'lightnovel',
    name: '轻小说',
    description: '轻松活泼、日系风格、角色魅力驱动',
    promptInjection: `写作风格要求——轻小说风格：
- 语言轻松活泼，善用吐槽和内心独白
- 角色标签鲜明，每个人有招牌口癖或动作
- 对话占比高（60%以上），叙述简洁
- 场景描写点到即止，不做过多渲染
- 日常段落注重搞笑和互动
- 战斗场面注重视觉感和中二感`,
    vocabulary: ['诶', '哈？', '可恶', '真是的', '不妙', '果然', '请多指教'],
    avoidPatterns: ['冗长的心理分析', '沉重的主题探讨', '过度文学化的语言'],
    dialogueStyle: '高密度对话，吐槽风，角色个性通过说话方式区分',
    narrativeDistance: '极近距离，第一人称或极贴近主角的第三人称',
  },
  {
    id: 'hardscifi',
    name: '硬核科幻',
    description: '科学严谨、技术细节、冷峻理性',
    promptInjection: `写作风格要求——硬核科幻风格：
- 科学设定要有逻辑依据，不用"不可描述的力量"搪塞
- 技术描写精确但不晦涩，用类比帮助理解
- 叙事冷峻理性，减少情感渲染
- 人物面对问题时优先用理性分析而非直觉
- 宇宙的宏大与人的渺小形成对比
- 探讨技术对社会和人性的影响`,
    vocabulary: ['系统', '协议', '轨道', '辐射', '光年', '质量', '概率'],
    avoidPatterns: ['伪科学', '超自然解释', '过度拟人化科技'],
    dialogueStyle: '简洁专业，常用术语但不卖弄',
    narrativeDistance: '中远距离，理性观察，偶尔深入探讨哲学问题',
  },
  {
    id: 'darkhumor',
    name: '黑色幽默',
    description: '荒诞讽刺、笑中带泪、解构现实',
    promptInjection: `写作风格要求——黑色幽默风格：
- 用幽默包裹严肃甚至残酷的主题
- 善用反讽、夸张、荒诞的情节设计
- 角色在荒谬处境中保持冷静或不自知
- 叙述语调冷静甚至轻松，与内容的沉重形成反差
- 揭示社会荒谬时不说教，让读者自己体会
- 黑色幽默不是低俗搞笑，而是智慧的讽刺`,
    vocabulary: ['讽刺', '荒谬', '滑稽', '冷笑话', '命运', '巧合', '反差'],
    avoidPatterns: ['低俗笑话', '过度解释笑点', '纯粹的喜剧桥段'],
    dialogueStyle: '一本正经地说荒谬的话，认真讨论不存在的问题',
    narrativeDistance: '旁观者姿态，冷眼看热闹，偶尔假装参与',
  },
  {
    id: 'gothic',
    name: '暗黑哥特',
    description: '阴郁唯美、死亡美学、超自然氛围',
    promptInjection: `写作风格要求——暗黑哥特风格：
- 营造阴郁、神秘、压抑的氛围
- 大量使用黑暗意象（暗夜、废墟、蔷薇、血色）
- 人物内心有强烈的矛盾和挣扎
- 死亡和衰败中寻找病态的美感
- 超自然元素半遮半掩，留给想象空间
- 语言华丽但带有腐朽感`,
    vocabulary: ['暗夜', '蔷薇', '棺椁', '灰烬', '苍白', '枯萎', '永恒'],
    avoidPatterns: ['明亮活泼的基调', '过于理性的解释', '网文式的轻松语气'],
    dialogueStyle: '诗意化的对话，常有哲理性的独白',
    narrativeDistance: '中近距离，沉浸在人物的感受中',
  },
  {
    id: 'minimalist',
    name: '现代极简',
    description: '语言精炼、留白大量、意在言外',
    promptInjection: `写作风格要求——现代极简风格：
- 用最少的文字传递最多的信息
- 大量留白，让读者自行填补
- 避免形容词堆砌，名词和动词为主
- 场景描写只取最有代表性的一两个细节
- 情感不直接表达，通过动作和细节暗示
- 章节可以很短，该结束就结束`,
    vocabulary: ['沉默', '空白', '静止', '呼吸', '缝隙', '清晨', '微光'],
    avoidPatterns: ['冗长描写', '过度修辞', '面面俱到的叙述'],
    dialogueStyle: '极简对话，大量省略和留白',
    narrativeDistance: '冷淡的近距离，像摄影机不带情感地记录',
  },
]

/**
 * 根据 ID 获取风格
 */
export function getWritingStyle(id: string): WritingStyle | undefined {
  return WRITING_STYLES.find(s => s.id === id)
}

/**
 * 构建风格注入上下文（注入 AI system prompt）
 */
export function buildStylePromptInjection(styleId: string): string {
  const style = getWritingStyle(styleId)
  if (!style) return ''
  return style.promptInjection
}
