// Local sparkle icon for the Others tool-row variant (figma 43:31850 leading
// glyph is an SF Symbols "sparkles" text glyph — not extractable as vector
// data, so this is a hand-authored three-star approximation). Lives here
// rather than ui-primitives until the exact glyph is exported and adopted
// into the ic_ds_* family.

export function IconSparkle16({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6.1 3.1Q6.6 7.8 11.3 8.3Q6.6 8.8 6.1 13.5Q5.6 8.8 0.9 8.3Q5.6 7.8 6.1 3.1Z" fill="currentColor" />
      <path d="M11.9 1Q12.2 3.7 14.9 4Q12.2 4.3 11.9 7Q11.6 4.3 8.9 4Q11.6 3.7 11.9 1Z" fill="currentColor" />
      <path d="M12.5 9.4Q12.7 11.4 14.7 11.6Q12.7 11.8 12.5 13.8Q12.3 11.8 10.3 11.6Q12.3 11.4 12.5 9.4Z" fill="currentColor" />
    </svg>
  )
}
