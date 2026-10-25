import { create } from 'zustand'
import type { TokenUsage } from '../lib/ai/logger'

export interface AIGenerationSession {
  output: string
  isStreaming: boolean
  error: string | null
  tokenUsage: TokenUsage | null
  operation: string | null
  updatedAt: number
}

const EMPTY_SESSION: AIGenerationSession = {
  output: '',
  isStreaming: false,
  error: null,
  tokenUsage: null,
  operation: null,
  updatedAt: 0,
}

interface AIGenerationSessionStore {
  sessions: Record<string, AIGenerationSession>
  patchSession: (key: string, patch: Partial<AIGenerationSession>) => void
  resetSession: (key: string) => void
}

export const useAIGenerationSessionStore = create<AIGenerationSessionStore>(set => ({
  sessions: {},
  patchSession: (key, patch) => set(state => ({
    sessions: {
      ...state.sessions,
      [key]: {
        ...(state.sessions[key] ?? EMPTY_SESSION),
        ...patch,
        updatedAt: Date.now(),
      },
    },
  })),
  resetSession: key => set(state => {
    if (!(key in state.sessions)) return state
    const sessions = { ...state.sessions }
    delete sessions[key]
    return { sessions }
  }),
}))

export function selectAIGenerationSession(key: string | null | undefined) {
  return (state: AIGenerationSessionStore): AIGenerationSession =>
    (key ? state.sessions[key] : undefined) ?? EMPTY_SESSION
}

export function createAISessionKey(
  projectId: number,
  moduleKey: string,
  entityId: string | number = 'project',
): string {
  return `${projectId}:${moduleKey}:${String(entityId)}`
}
