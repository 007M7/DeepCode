# Composer draft scrolling (14-line cap, two text layers)

## At the start of the draft

- draft overflows the capped box: true
- visible lines: 14
- both layers share one scroll extent: true
- all three layers wrap at one width: true
- textarea scroll offset: 0px
- glyph layer tracks it: true
- first draft line is on screen: true
- last draft line is on screen: false

## Scrolled to the end of the draft

- textarea moved: true
- glyph layer tracks it: true
- first draft line has scrolled out above: true
- last draft line is on screen: true

## Draft ending in a newline, scrolled to the end

- both layers share one scroll extent: true
- glyph layer tracks the caret: true
- last draft line is on screen: true
