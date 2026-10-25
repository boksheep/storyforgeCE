import type { ChatMessage } from '../../types'

export const SIMPLIFIED_CHINESE_OUTPUT_CONSTRAINT = [
  '【语言输出硬约束】',
  '除用户原文明确要求保留的专名、术语、代码、JSON key 外，所有面向读者的标题、summary、目标、说明和正文内容必须使用自然流畅的简体中文。',
  '禁止中英夹杂，禁止输出整句英文，禁止把英文变量名、英文示例或 prompt key 写进创作结果。',
  '如果输入资料中混有英文，请先在内部理解并转写为中文表达；不要原样扩散到大纲或正文。',
].join('\n')

export function appendUserConstraint(messages: ChatMessage[], constraint: string): ChatMessage[] {
  const next = messages.map(message => ({ ...message }))
  const user = [...next].reverse().find(message => message.role === 'user')
  if (user) user.content = `${user.content}\n\n${constraint}`
  return next
}

export function appendSimplifiedChineseOutputConstraint(messages: ChatMessage[]): ChatMessage[] {
  return appendUserConstraint(messages, SIMPLIFIED_CHINESE_OUTPUT_CONSTRAINT)
}
