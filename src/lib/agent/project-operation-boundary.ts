/**
 * 主 Agent 操作边界（AGENT-2）。
 *
 * 目的：当作者要求的是主 Agent 不能安全执行的操作时，给出**具体原因与替代入口**，
 * 而不是让通用规划链凭空生成一个无关计划、或让用户以为任务已经完成。
 *
 * 边界不是"能力不足的借口"：这里只拦截有明确治理归属的操作——
 * 破坏性删除、内部/派生缓存改写、世界生命周期迁移。这些操作已有各自领域入口，
 * 由注册表（PROJECT_TABLES refs / 领域 lifecycle）保证级联与引用重映射。
 */

export interface ProjectOperationBoundary {
  /** 面向作者的解释，包含替代入口。 */
  message: string
}

const DESTRUCTIVE_VERB = /删除|删掉|移除|清除|清空|抹掉|作废/
// 只把删除动词实际支配的对象纳入边界；章节对象的文字/错字不是整章删除。
const DELETION_TARGET = /(?:删除|删掉|移除|清除|清空|抹掉|作废)\s*(?:掉)?\s*(?:第\s*[零〇一二两三四五六七八九十百\d]+\s*(?:章|节|卷|篇|部|幕)|所有|全部|这条|这个|这些|该|整个)?\s*(?:伏笔|角色|章节|正文|词条|分类|便签|笔记|地点|重要地点|时间线|年表|事件|故事线|支线|状态卡|物品|参考|作品|世界|大纲|卷|篇|章|错别字|字|文字)/
// 编号章节单独出现必须紧邻破坏动词，不能因句中其他对象被否定或局部编辑而误拦。

const INTERNAL_DATA_NOUN = /检索块|检索索引|向量|embedding|摘要树|叙事摘要|用量|消耗|日志|快照|导入缓存|导入原文|分析分块|分块分析|派生|缓存/
const INTERNAL_VERB = /重建|重算|清空|删除|修改|更新|写入|覆盖/

const WORLD_LIFECYCLE = /新建世界|新增世界组|删除世界|合并世界|迁移到.*世界|世界组迁移/

/** 返回边界说明；null 表示请求不属于已知的越界操作，应继续走正常规划。 */
export function describeProjectOperationBoundary(request: string): ProjectOperationBoundary | null {
  const text = request.trim()
  if (!text) return null

  if (WORLD_LIFECYCLE.test(text)) {
    return {
      message: '世界组的新建、删除与迁移会重写多张表的 worldGroupId 与引用关系，属于世界生命周期操作，不能由对话直接执行。请在「世界」管理入口完成，主 Agent 可以改为先读取相关世界数据供你核对。',
    }
  }

  if (INTERNAL_DATA_NOUN.test(text) && INTERNAL_VERB.test(text)) {
    return {
      message: '检索块、叙事摘要树、用量日志、快照与分析分块都属于内部/派生数据，由对应流水线在正文变化后按需重建，不接受对话直接改写。如果你要的是最终效果（例如“让检索跟上最新正文”），请在数据管理/设置里重建索引；主 Agent 可以读取这些数据帮你诊断。',
    }
  }

  // “删除第5章错别字/文字”只删除正文局部内容，必须走正文候选，不得被解释为删章。
  if (DESTRUCTIVE_VERB.test(text) && /第\s*[零〇一二两三四五六七八九十百\d]+\s*(?:章|节)/.test(text)
    && /错别字|病句|标点|字词|文字/.test(text)) return null

  const numberedDeletion = /(?:删除|删掉|移除|清除|清空|抹掉|作废)\s*(?:掉)?\s*第\s*[零〇一二两三四五六七八九十百\d]+\s*(?:章|节|卷|篇|部|幕)(?:的内容)?(?:\s*$|[。！!?？])/.test(text)
  const authorDataDeletion = /(?:伏笔|角色|章节|正文|词条|分类|便签|笔记|地点|重要地点|时间线|年表|事件|故事线|支线|状态卡|物品|参考|作品|世界|大纲|卷|篇)/.test(text)
  if (DESTRUCTIVE_VERB.test(text) && (DELETION_TARGET.test(text) || numberedDeletion || authorDataDeletion)) {
    return {
      message: '删除属于破坏性操作，会触发级联与引用重映射，必须在对应领域入口由你本人确认执行（大纲/章节列表/伏笔/词条/地点/年表等面板）。主 Agent 不会代替你删除数据；如果你希望的是“先看看删了会影响什么”，我可以读取相关记录和引用关系供你判断。',
    }
  }

  return null
}
