import type { OutlineNode } from '../types'

/**
 * OutlineNode.summary/title/order 在类型上是非可选字段,但历史版本、跨版本导入、
 * 或开发期直接写 store 都可能把脏值带入内存。大纲视图和 store 共用这一层,
 * 避免 UI 继续散落 `summary?.trim()` 兜底。
 */
export function normalizeOutlineNode(node: OutlineNode): OutlineNode {
  return {
    ...node,
    parentId: node.parentId ?? null,
    title: String(node.title ?? ''),
    summary: String(node.summary ?? ''),
    order: Number.isFinite(Number(node.order)) ? Number(node.order) : 0,
  }
}
