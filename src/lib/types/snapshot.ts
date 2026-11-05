/** 项目快照 — 自动/手动备份 */
export interface Snapshot {
  id?: number
  projectId: number
  /** 快照名称（自动备份 / 手动命名） */
  label: string
  /** 快照类型 */
  type: 'auto' | 'manual'
  /** 序列化后的完整项目数据（JSON string） */
  data: string
  /** 数据大小（字节） */
  size: number
  createdAt: number

  /**
   * CLOUD-DB-1 · 已上传到云数据库时的云端标识。
   *
   * 由客户端生成（与本地快照一一对应），因此重复上传是幂等的。
   * 没有这个字段 = 只存在本机。
   */
  cloudSnapshotUid?: string
  /** 最近一次上传成功的时间戳。 */
  cloudUploadedAt?: number
}
