/** A styled run of card text; `r` is the furigana drawn over it. */
export type Seg = { t: string; r?: string; b?: boolean; i?: boolean; u?: boolean; c?: string }
export type Card = {
  id: number
  kind: 'new' | 'learning' | 'review'
  /** Plain text, furigana in brackets: what's drawn where lines can't be. */
  question: string
  answer: string
  questionLines?: Seg[][]
  answerLines?: Seg[][]
}
export type Counts = { new: number; learning: number; review: number }
export type DeckRow = Counts & { name: string; level: number }
export type Band = {
  status: 'idle' | 'syncing' | 'ready' | 'empty' | 'logged_out' | 'desktop_open' | 'missing' | 'error'
  deck: string
  message?: string
}
/** The deck picker: open until a deck is picked, `page` of its rows shown. */
export type Menu = { isOpen: boolean; page: number; decks: DeckRow[] }

declare module 'claude-code' {
  interface PluginState {
    anki: {
      card: Card | null
      isRevealed: boolean
      band: Band
      counts: Counts | null
      menu: Menu
      /** The card whose grade is held back and can still be undone. */
      undoable: Card | null
    }
  }
}
