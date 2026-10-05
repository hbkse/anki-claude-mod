export type Card = { id: number; kind: 'new' | 'learning' | 'review'; question: string; answer: string }
export type Counts = { new: number; learning: number; review: number }
export type Band = {
  status: 'idle' | 'syncing' | 'ready' | 'empty' | 'logged_out' | 'missing' | 'error'
  deck: string
  message?: string
}

declare module 'claude-code' {
  interface PluginState {
    'anki-claude-mod': { card: Card | null; isRevealed: boolean; band: Band; counts: Counts | null }
  }
}
