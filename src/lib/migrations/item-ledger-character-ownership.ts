import type { Transaction } from 'dexie'
import { log } from '../logging/logger'

interface LegacyItemLedgerRow {
  id?: number
  projectId: number
  heldByName?: string
  characterId?: number | null
  [key: string]: unknown
}

interface LegacyCharacterRow {
  id?: number
  projectId: number
  name: string
  role?: string
  roleWeight?: string
  [key: string]: unknown
}

function resolveUniqueMainCharacter(characters: LegacyCharacterRow[]): LegacyCharacterRow | null {
  const currentMain = characters.filter(character => character.roleWeight === 'main')
  if (currentMain.length === 1) return currentMain[0]
  if (currentMain.length > 1) return null

  // v34 之前的备份可能还没有 roleWeight，才回退读取旧 role。
  const legacyProtagonists = characters.filter(character => character.role === 'protagonist')
  return legacyProtagonists.length === 1 ? legacyProtagonists[0] : null
}

/** v37 → v38：itemLedger 加 heldByName + characterId，存量条目归给唯一主要角色。 */
export async function migrateItemLedgerToCharacterOwnership(tx: Transaction): Promise<void> {
  const items = await tx.table('itemLedger').toArray() as LegacyItemLedgerRow[]
  const characters = await tx.table('characters').toArray() as LegacyCharacterRow[]

  const byProject = new Map<number, LegacyCharacterRow[]>()
  let assigned = 0
  let unresolved = 0
  for (const c of characters) {
    const list = byProject.get(c.projectId) ?? []
    list.push(c)
    byProject.set(c.projectId, list)
  }

  for (const item of items) {
    if (item.heldByName != null) continue
    const chars = byProject.get(item.projectId) ?? []
    const mainCharacter = resolveUniqueMainCharacter(chars)
    if (mainCharacter) {
      item.heldByName = mainCharacter.name
      item.characterId = mainCharacter.id ?? null
      assigned++
    } else {
      item.heldByName = '未知(历史数据)'
      item.characterId = null
      unresolved++
    }
    await tx.table('itemLedger').update(item.id!, { heldByName: item.heldByName, characterId: item.characterId })
  }
  log.info('Migration', 'migration.item-ownership.prepared', '物品账本归属迁移事务已处理', {
    itemCount: items.length, characterCount: characters.length,
    assignedCount: assigned, unresolvedCount: unresolved,
  })
}
