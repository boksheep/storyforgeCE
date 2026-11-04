/**
 * ⚠️ 自动生成，请勿手改。
 *
 * 来源：`src/lib/registry/project-tables.ts` 中 `exportable === true` 的条目，保持声明顺序。
 * 重新生成：`node scripts/gen-cloud-sync-manifest.mjs`
 * 一致性校验：`tests/registry/R-cloud-sync-tables.test.ts`
 *
 * 服务端只把这些表当作**不透明载荷**存进 `project_tables.payload_json`，
 * 因此前端给任意表加字段都不需要改服务端。
 */
export const SYNC_TABLES = Object.freeze([
  "projects",
  "worldviews",
  "storyCores",
  "powerSystems",
  "cultivationSystems",
  "cultivationProgress",
  "geographies",
  "histories",
  "worldNodes",
  "mapAssets",
  "mapAssetBlobs",
  "mapFeatures",
  "mapObservations",
  "mapRelations",
  "mapLegendEntries",
  "mapCategoryDefinitions",
  "mapScanTasks",
  "historicalTimelineEvents",
  "historicalKeywords",
  "importantLocations",
  "worldRulesProfiles",
  "characters",
  "characterRelations",
  "outlineNodes",
  "chapters",
  "detailedOutlines",
  "emotionBeatCards",
  "foreshadows",
  "storyArcs",
  "characterDrivenPlans",
  "storylineProgress",
  "storylineCrossings",
  "stateCards",
  "itemLedger",
  "storyTimelineEvents",
  "notes",
  "creativeRules",
  "codexCategories",
  "codexEntries",
  "userStyleProfiles",
  "inspirationWorkspaces",
  "agentConversations",
  "agentEvents",
  "nodeFlows",
  "nodeRuns",
  "simulationSessions",
  "simulationEvents",
  "simulationCheckpoints",
  "temporalFacts",
  "knowledgeLedger",
  "worldGroups",
  "worldGroupLinks",
  "references",
  "referenceAnalysisRuns",
  "referenceChunkAnalysis"
])

/** 表数量（55：含 `projects` 根表）。 */
export const SYNC_TABLE_COUNT = SYNC_TABLES.length

/** 是否为已知同步表（拒绝客户端塞入未知表名）。 */
export const SYNC_TABLE_SET = new Set(SYNC_TABLES)
