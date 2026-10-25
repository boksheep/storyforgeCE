import type { ReactNode } from 'react'

/**
 * 轻量 Markdown 渲染（Agent 输出阅读用）。
 *
 * 为什么自己写而不是引入依赖：项目依赖表冻结，且 AI 输出属于不可信数据。
 * 这里**只生成 React 元素、从不使用 dangerouslySetInnerHTML**，因此即使模型输出
 * 原始 HTML 也会被当纯文本显示，不存在注入面。
 *
 * 支持：ATX 标题、无序/有序列表、引用、围栏代码、表格、分隔线、
 * 行内 **粗体** / *斜体* / `代码` / [链接](url)（仅 http/https）。
 */

export type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'hr' }

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const FENCE = /^\s*```/
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_DIVIDER = /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) { index++; continue }

    if (FENCE.test(line)) {
      const body: string[] = []
      index++
      while (index < lines.length && !FENCE.test(lines[index])) { body.push(lines[index]); index++ }
      index++ // 跳过结束围栏
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() })
      index++
      continue
    }

    if (HR.test(line)) { blocks.push({ kind: 'hr' }); index++; continue }

    // 表格：当前行是 | ... | 且下一行是分隔行
    if (TABLE_ROW.test(line) && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1])) {
      const header = splitRow(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && TABLE_ROW.test(lines[index])) {
        rows.push(splitRow(lines[index]))
        index++
      }
      blocks.push({ kind: 'table', header, rows })
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (index < lines.length && QUOTE.test(lines[index])) {
        body.push(QUOTE.exec(lines[index])![1])
        index++
      }
      blocks.push({ kind: 'quote', text: body.join('\n') })
      continue
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line)
      const items: string[] = []
      while (index < lines.length) {
        const bullet = ordered ? ORDERED.exec(lines[index]) : BULLET.exec(lines[index])
        if (!bullet) break
        items.push(bullet[1].trim())
        index++
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim()
      && !HEADING.test(lines[index]) && !FENCE.test(lines[index])
      && !BULLET.test(lines[index]) && !ORDERED.test(lines[index])
      && !QUOTE.test(lines[index]) && !HR.test(lines[index])
      && !TABLE_ROW.test(lines[index])) {
      paragraph.push(lines[index].trim())
      index++
    }
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
  }
  return blocks
}

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`]+`|\[[^\]\n]+\]\([^()\s]+\))/g

function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null
}

/** 行内标记 → React 节点；不解析 HTML。 */
export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((match = INLINE.exec(text)) != null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyPrefix}-${match.index}`
    if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key} className="font-semibold text-text-primary">{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="rounded bg-bg-elevated px-1 py-0.5 font-mono text-[0.92em] text-text-primary">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^()\s]+)\)$/.exec(token)!
      const href = safeHref(link[2])
      nodes.push(href
        ? <a key={key} href={href} target="_blank" rel="noreferrer" className="text-accent underline">{link[1]}</a>
        : <span key={key}>{link[1]}</span>)
    } else {
      nodes.push(<em key={key} className="italic">{token.slice(1, -1)}</em>)
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-base font-semibold text-text-primary',
  2: 'text-sm font-semibold text-text-primary',
  3: 'text-xs font-semibold text-text-primary',
  4: 'text-xs font-semibold text-text-secondary',
  5: 'text-xs font-medium text-text-secondary',
  6: 'text-xs font-medium text-text-muted',
}

interface Props {
  text: string
  className?: string
}

/** 渲染 AI 输出的 Markdown 正文。 */
export default function MarkdownText({ text, className }: Props) {
  const blocks = parseMarkdownBlocks(text)
  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      {blocks.map((block, blockIndex) => {
        const key = `b${blockIndex}`
        if (block.kind === 'heading') {
          const Tag = (`h${Math.min(6, Math.max(1, block.level))}`) as 'h1'
          return (
            <Tag key={key} className={`${HEADING_CLASS[block.level] ?? HEADING_CLASS[6]} ${blockIndex > 0 ? 'pt-1' : ''}`}>
              {renderInline(block.text, key)}
            </Tag>
          )
        }
        if (block.kind === 'hr') return <hr key={key} className="border-border/60" />
        if (block.kind === 'code') {
          return (
            <pre key={key} className="overflow-x-auto rounded border border-border bg-bg-elevated p-2 font-mono text-[11px] leading-5 text-text-primary">
              <code>{block.text}</code>
            </pre>
          )
        }
        if (block.kind === 'quote') {
          return (
            <blockquote key={key} className="border-l-2 border-accent/40 pl-2 text-text-muted">
              {renderInline(block.text, key)}
            </blockquote>
          )
        }
        if (block.kind === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul'
          return (
            <ListTag key={key} className={`space-y-1 pl-4 ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`} className="pl-0.5">{renderInline(item, `${key}-${itemIndex}`)}</li>
              ))}
            </ListTag>
          )
        }
        if (block.kind === 'table') {
          return (
            <div key={key} className="overflow-x-auto rounded border border-border">
              <table className="w-full border-collapse text-left text-[11px]">
                <thead className="bg-bg-elevated text-text-secondary">
                  <tr>
                    {block.header.map((cell, cellIndex) => (
                      <th key={cellIndex} className="border-b border-border px-2 py-1 font-medium">
                        {renderInline(cell, `${key}-h${cellIndex}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className={rowIndex % 2 ? 'bg-bg-base/60' : undefined}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} className="border-b border-border/50 px-2 py-1 align-top">
                          {renderInline(cell, `${key}-${rowIndex}-${cellIndex}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        return <p key={key}>{renderInline(block.text, key)}</p>
      })}
    </div>
  )
}
