export interface ErrorGuide {
  code: string
  explanation: string
  selfCheck: string
}

/** 只匹配已知错误特征；未命中时不猜测根因。 */
export function explainCommonError(error: unknown): ErrorGuide | null {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/Duplicate use of selection JSON ID\s+gapcursor/i.test(message)) return {
    code: 'editor.selection-id-duplicate',
    explanation: '编辑器在恢复光标位置时发现重复的选择类型标识，页面渲染因此中断。',
    selfCheck: '先下载诊断包并保留当前项目备份；重试若再次出现，请附上诊断包反馈。',
  }
  if (/QuotaExceededError/i.test(name + message)) return {
    code: 'storage.quota-exceeded',
    explanation: '浏览器为本站点提供的本地存储空间可能已用尽。',
    selfCheck: '检查设备剩余空间与浏览器站点存储；不要清除本站点数据，先从数据管理导出备份。',
  }
  if (/VersionError|database.*higher version/i.test(name + message)) return {
    code: 'storage.version-mismatch',
    explanation: '本地数据库版本与当前应用版本不匹配。',
    selfCheck: '确认是否打开了旧版应用；不要清除浏览器数据，保留诊断包和现有备份。',
  }
  if (/Failed to fetch dynamically imported module|ChunkLoadError|Loading chunk .* failed/i.test(message)) return {
    code: 'app.chunk-load-failed',
    explanation: '应用的一个代码模块未能加载，可能与缓存或网络状态有关。',
    selfCheck: '先下载诊断包，再检查网络并刷新页面；若仍失败，请确认分发包文件完整。',
  }
  if (/504 Gateway Time-out|\b504\b/i.test(message)) return {
    code: 'network.gateway-timeout',
    explanation: '上游服务等待响应超时。',
    selfCheck: '检查网络和模型服务状态，稍后重试；重复出现时附上诊断包。',
  }
  if (/Failed to fetch|NetworkError/i.test(name + message)) return {
    code: 'network.fetch-failed',
    explanation: '请求未能到达目标服务或未收到可用响应。',
    selfCheck: '检查网络、API 地址及浏览器跨域设置，稍后重试。',
  }
  return null
}
