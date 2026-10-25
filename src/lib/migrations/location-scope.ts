import type { Transaction } from 'dexie'

/** Existing project-level locations remain unresolved when multi-world mode is enabled. */
export async function migrateLocationScope(tx: Transaction): Promise<void> {
  await tx.table('importantLocations').toCollection().modify(row => {
    if (row.scope == null) row.scope = 'unassigned'
    if (row.worldGroupId === undefined) row.worldGroupId = null
  })
}
