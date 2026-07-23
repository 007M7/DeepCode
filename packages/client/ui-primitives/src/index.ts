/**
 * Pure React atoms (zero cordis): StateDot, icons, Button/Pill/Menu/Input,
 * markdown family, ConnectionBanner. Everything consumes props plus --dsw-*
 * token vars only. Contract: api-contracts v3 section 8.
 */

export { StateDot } from './StateDot.tsx'
export type { StateDotState } from './StateDot.tsx'
export { Button } from './Button.tsx'
export type { ButtonVariant } from './Button.tsx'
export { Pill } from './Pill.tsx'
export { Input } from './Input.tsx'
export { Menu } from './Menu.tsx'
export type { MenuItem } from './Menu.tsx'
export { ConnectionBanner } from './ConnectionBanner.tsx'
export { FishLogo } from './FishLogo.tsx'
export { JsonBlock } from './markdown/JsonBlock.tsx'
export { MessageText } from './markdown/MessageText.tsx'
export * from './icons/index.tsx'
