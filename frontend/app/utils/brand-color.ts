/**
 * 品牌主色 → 一整套 accent 设计 token（浅色 / 深色）
 * studio.css 里所有品牌色相关的变量都从这里派生，组件只用变量，不写死颜色。
 * 内置火焰橙 #f97316 经此推导，结果与 studio.css 原值基本一致（深色自动提亮约等于 #ffb076）。
 */

type RGB = [number, number, number]

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)
}

function toRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')
}

/** 与目标色按比例混合：mix(c, white, 0.2) = 提亮 20% */
function mix(c: RGB, target: RGB, amount: number): RGB {
  return [0, 1, 2].map(i => c[i] + (target[i] - c[i]) * amount) as RGB
}

const WHITE: RGB = [255, 255, 255]
const BLACK: RGB = [0, 0, 0]

function rgba(c: RGB, a: number) {
  return `rgba(${c.map(Math.round).join(',')},${a})`
}

/** WCAG 相对亮度 0–1 */
function luminance(c: RGB) {
  const [r, g, b] = c.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** 深色主题下的自动主色：混白提亮，保证在深底上可读 */
export function autoDarkColor(hex: string): string {
  return toHex(mix(toRgb(hex), WHITE, 0.4))
}

export function accentTokens(hex: string, mode: 'light' | 'dark'): Record<string, string> {
  const c = toRgb(hex)
  if (mode === 'light') {
    // 亮主色（黄、浅青等）上用深色字，否则白字
    const onAccent = luminance(c) > 0.45 ? toHex(mix(c, BLACK, 0.85)) : '#ffffff'
    return {
      '--border-focus': hex,
      '--accent': hex,
      '--accent-dark': toHex(mix(c, BLACK, 0.22)),
      '--accent-bg': rgba(c, 0.10),
      '--accent-text': toHex(mix(c, BLACK, 0.08)),
      '--accent-glow': rgba(c, 0.20),
      '--accent-gradient': `linear-gradient(135deg, ${hex} 0%, ${toHex(mix(c, WHITE, 0.18))} 100%)`,
      '--action-primary': hex,
      '--action-primary-hover': toHex(mix(c, BLACK, 0.08)),
      '--action-primary-press': toHex(mix(c, BLACK, 0.22)),
      '--button-focus': rgba(c, 0.20),
      '--on-accent': onAccent,
    }
  }
  const onAccent = luminance(c) > 0.35 ? toHex(mix(c, BLACK, 0.85)) : '#ffffff'
  return {
    '--border-focus': hex,
    '--accent': hex,
    '--accent-dark': toHex(mix(c, BLACK, 0.1)),
    '--accent-bg': rgba(c, 0.14),
    '--accent-text': hex,
    '--accent-glow': rgba(c, 0.30),
    '--accent-gradient': `linear-gradient(135deg, ${hex} 0%, ${toHex(mix(c, BLACK, 0.08))} 100%)`,
    '--action-primary': hex,
    '--action-primary-hover': toHex(mix(c, WHITE, 0.2)),
    '--action-primary-press': toHex(mix(c, BLACK, 0.1)),
    '--button-focus': rgba(c, 0.30),
    '--on-accent': onAccent,
  }
}

/** 圆角风格 → 圆角 token（round = studio.css 默认值，不覆写） */
export function cornerTokens(style: string): Record<string, string> {
  if (style === 'soft') {
    return { '--radius-pill': '10px' }
  }
  if (style === 'sharp') {
    return {
      '--radius-sm': '4px',
      '--radius': '6px',
      '--radius-lg': '8px',
      '--radius-xl': '10px',
      '--radius-pill': '6px',
    }
  }
  return {}
}
