/**
 * RAG-1 · 可见资料与检索管理。
 *
 * 资料正文仍以各业务表为 Canon；这里只在源记录上保存稳定资料 ID 与作者的检索策略。
 * ragDocumentId 随项目 JSON 往返，节点图引用它而不是 Dexie 自增主键，避免导入后失联。
 */
export interface RagFieldPolicy {
  enabled?: boolean
  /** 相同节点预算下的相对优先级。 */
  weight?: number
  /** 单字段最多进入一次上下文的 token 数。 */
  tokenCap?: number
}

export interface RagDocumentPolicy extends RagFieldPolicy {
  fields?: Record<string, RagFieldPolicy>
}

export interface RagDocumentMetadata {
  ragDocumentId?: string
  ragPolicy?: RagDocumentPolicy
}

export type RagVectorState = 'none' | 'keyword' | 'partial' | 'ready'

export interface RagLibraryEntry {
  key: string
  documentId: string
  tableName: string
  recordId: number
  sourceKey: string
  sourceLabel: string
  title: string
  fieldKey: string
  fieldLabel: string
  content: string
  updatedAt: number
  tokenEstimate: number
  documentEnabled: boolean
  documentWeight: number
  documentTokenCap: number
  enabled: boolean
  weight: number
  tokenCap: number
  chunkCount: number
  vectorState: RagVectorState
}

export interface RagSelectionTrace {
  included: string[]
  omitted: string[]
  trimmed: string[]
}

export interface RagSelectionTraceCollector extends RagSelectionTrace {
  clear(): void
}

export function createRagSelectionTrace(): RagSelectionTraceCollector {
  return {
    included: [],
    omitted: [],
    trimmed: [],
    clear() {
      this.included.length = 0
      this.omitted.length = 0
      this.trimmed.length = 0
    },
  }
}
