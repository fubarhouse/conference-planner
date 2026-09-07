import { defineConfig, presetUno } from 'unocss'

export default defineConfig({
  presets: [
    presetUno(),
  ],

  // has-[selector]: variant — Tailwind v3.4 addition, not in preset-uno.
  // Transforms `has-[:checked]:border-blue-400` →
  //   `.has-\[\:checked\]\:border-blue-400:has(:checked) { ... }`
  variants: [
    (matcher) => {
      const match = matcher.match(/^has-\[([^\]]+)\]:(.+)$/)
      if (!match) return matcher
      const [, selector, rest] = match
      return {
        matcher: rest,
        selector: (s) => `${s}:has(${selector})`,
      }
    },
  ],

  // Safelist for classes that only appear as variant-prefixed forms
  // (the extractor sees the full string but the variant strips the prefix).
  safelist: [
    'has-[:checked]:border-blue-400',
    'has-[:checked]:bg-blue-50',
  ],

  // Content is passed via CLI patterns — see build:css / watch:css scripts.
  // Dynamic class values (TASK_PRIORITY_BADGE, TICKET_STATUS_CLASSES, etc.)
  // are complete string literals in JS source files and are found automatically.
})
