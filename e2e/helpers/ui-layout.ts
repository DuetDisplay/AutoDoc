import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { UiLanguageCode } from '../../src/shared/ui-language'

export async function setUi(page: Page, language: UiLanguageCode, theme: 'light' | 'dark') {
  await page.evaluate(
    async ({ language, theme }) => {
      await window.electronAPI.invoke('prefs:set-ui-language', language)
      await window.electronAPI.invoke('prefs:set-appearance', theme)
    },
    { language, theme }
  )
  await expect(page.locator('html')).toHaveAttribute('lang', language)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await settleLayout(page)
}

export async function settleLayout(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
  })
}

export async function setContentSize(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
  zoom: number
) {
  const native = await app.browserWindow(page)
  await native.evaluate(
    (w, { width, height, zoom }) => {
      w.setContentSize(width, height)
      w.webContents.setZoomFactor(zoom)
    },
    { width, height, zoom }
  )
  await page.setViewportSize({ width, height })
  await settleLayout(page)
}

/** Measure visible text, including opacity applied by containing elements. */
export async function contrastRatio(
  target: Locator,
  border = false,
  underlay?: string
): Promise<number> {
  return target.evaluate(
    (element, { border, underlay }) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      const rgba = (color: string): number[] => {
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = color
        ctx.fillRect(0, 0, 1, 1)
        const p = ctx.getImageData(0, 0, 1, 1).data
        return [p[0], p[1], p[2], p[3] / 255]
      }
      const over = (front: number[], back: number[]): number[] => {
        const alpha = front[3] + back[3] * (1 - front[3])
        return [0, 1, 2]
          .map((i) =>
            alpha ? (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / alpha : 0
          )
          .concat(alpha)
      }
      const luminance = (color: number[]) =>
        color
          .slice(0, 3)
          .map((c) => {
            c /= 255
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
          })
          .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0)
      const style = getComputedStyle(element)
      // Progress fills are siblings behind a transparent label, so an ancestor-
      // only walk cannot see their paint. Callers sample that actual fill color.
      const backdrop = underlay ? rgba(underlay) : [0, 0, 0, 0]
      let foreground = over(rgba(border ? style.borderTopColor : style.color), backdrop),
        background = backdrop
      for (let parent: Element | null = element; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent),
          fill = rgba(css.backgroundColor)
        foreground = over(foreground, fill)
        background = over(background, fill)
        foreground[3] *= Number(css.opacity)
        background[3] *= Number(css.opacity)
      }
      foreground = over(foreground, [255, 255, 255, 1])
      background = over(background, [255, 255, 255, 1])
      const a = luminance(foreground),
        b = luminance(background)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    },
    { border, underlay }
  )
}

/** Check actual line rectangles; scrollWidth alone misses text painted past a child. */
export async function expectTextWithin(target: Locator, bounds: Locator = target) {
  const box = await bounds.boundingBox()
  expect(box).not.toBeNull()
  const escaped = await target.evaluate((element, box) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT),
      failures: string[] = []
    while (walker.nextNode()) {
      const node = walker.currentNode,
        parent = node.parentElement!
      if (!node.textContent?.trim() || parent.closest('[aria-hidden="true"],.sr-only')) continue
      const style = getComputedStyle(parent)
      // User previews with a full-title tooltip may deliberately clamp to two lines.
      if (
        parent.closest('[title]') &&
        style.webkitLineClamp !== 'none' &&
        style.webkitLineClamp !== ''
      )
        continue
      const range = document.createRange()
      range.selectNodeContents(node)
      if (
        [...range.getClientRects()].some(
          (r) => r.width && (r.left < box!.x - 1 || r.right > box!.x + box!.width + 1)
        )
      )
        failures.push(node.textContent!)
    }
    return failures
  }, box)
  expect(escaped).toEqual([])
}

/** Scroll vertically without automatically panning away an overflow bug. */
export async function revealVertically(target: Locator) {
  await target.evaluate((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (
        /(auto|scroll)/.test(getComputedStyle(parent).overflowY) &&
        parent.scrollHeight > parent.clientHeight
      ) {
        const r = element.getBoundingClientRect(),
          p = parent.getBoundingClientRect()
        parent.scrollTop += r.top - p.top - Math.max(8, (parent.clientHeight - r.height) / 2)
      }
    }
  })
}

/** Fixed controls can cover text even when every element is inside the viewport. */
export async function onboardingOcclusions(page: Page, backLabel: string): Promise<string[]> {
  return page.evaluate((backLabel) => {
    const back = [...document.querySelectorAll('button')].find(
      (el) => el.textContent?.trim() === backLabel
    )
    const controls = [
      ...document.querySelectorAll('[data-testid="step-dot"]'),
      ...(back ? [back] : [])
    ]
    const boxes = controls.map((el) => el.getBoundingClientRect())
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT),
      overlaps: string[] = []
    while (walker.nextNode()) {
      const node = walker.currentNode,
        parent = node.parentElement!
      if (
        !node.textContent?.trim() ||
        parent.closest('script,style,[aria-hidden="true"],.sr-only') ||
        back?.contains(parent)
      )
        continue
      const range = document.createRange()
      range.selectNodeContents(node)
      if (
        [...range.getClientRects()].some((r) => {
          let left = Math.max(0, r.left),
            right = Math.min(innerWidth, r.right),
            top = Math.max(0, r.top),
            bottom = Math.min(innerHeight, r.bottom)
          // A range retains its offscreen geometry after scrolling. Only the
          // portion painted inside every clipping ancestor can be obscured.
          for (let p: Element | null = parent; p; p = p.parentElement) {
            const css = getComputedStyle(p),
              bounds = p.getBoundingClientRect()
            if (/hidden|clip|auto|scroll/.test(css.overflowX)) {
              left = Math.max(left, bounds.left)
              right = Math.min(right, bounds.right)
            }
            if (/hidden|clip|auto|scroll/.test(css.overflowY)) {
              top = Math.max(top, bounds.top)
              bottom = Math.min(bottom, bounds.bottom)
            }
          }
          return (
            right > left &&
            bottom > top &&
            boxes.some((b) => left < b.right && right > b.left && top < b.bottom && bottom > b.top)
          )
        })
      )
        overlaps.push(node.textContent!.trim())
    }
    return overlaps
  }, backLabel)
}

export async function expectAnimationContrast(target: Locator, label: string) {
  await target.evaluate(async (element) => {
    const entrances: Promise<Animation>[] = []
    for (let p: Element | null = element; p; p = p.parentElement)
      for (const animation of p.getAnimations({ subtree: false })) {
        const timing = animation.effect?.getComputedTiming()
        if (timing && timing.iterations !== Infinity && Number(timing.endTime) <= 1000)
          entrances.push(animation.finished.catch(() => animation))
      }
    await Promise.all(entrances)
  })
  for (const phase of [0, 0.25, 0.5, 0.75, 0.999]) {
    await target.evaluate((element, phase) => {
      for (let p: Element | null = element; p; p = p.parentElement) {
        for (const animation of p.getAnimations({ subtree: false })) {
          const timing = animation.effect?.getComputedTiming()
          if (timing?.iterations !== Infinity) continue
          const duration = timing.duration
          if (typeof duration === 'number' && Number.isFinite(duration)) {
            animation.pause()
            animation.currentTime = duration * phase
          }
        }
      }
    }, phase)
    expect(
      await contrastRatio(target),
      `${label}, animation phase ${phase}`
    ).toBeGreaterThanOrEqual(4.5)
  }
}
