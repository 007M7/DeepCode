// MessageText: the single text-block rendering point (Markdown support later = swap this component's internals, zero card-structure changes).

import css from './MessageText.module.css'

export function MessageText({ text }: { text: string }) {
  return <div className={css.text}>{text}</div>
}
