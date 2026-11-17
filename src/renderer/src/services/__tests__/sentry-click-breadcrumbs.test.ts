import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeSentryBreadcrumb } from '../../../../shared/sentry-breadcrumbs'

const { addBreadcrumb } = vi.hoisted(() => ({ addBreadcrumb: vi.fn() }))

vi.mock('@sentry/electron/renderer', () => ({ addBreadcrumb }))

import { installSemanticClickBreadcrumbs } from '../sentry-click-breadcrumbs'

function click(html: string): void {
  document.body.innerHTML = html
  document.body.querySelector<HTMLElement>('[data-target]')?.click()
}

describe('click breadcrumbs', () => {
  beforeAll(() => installSemanticClickBreadcrumbs(() => true))
  beforeEach(() => addBreadcrumb.mockClear())

  it.each([
    ['text', '<button data-target>Budget review with Sam</button>'],
    ['aria-label', '<button data-target aria-label="Budget review with Sam"></button>'],
    ['title', '<button data-target title="Budget review with Sam"></button>'],
    ['link text', '<a data-target href="#/x">Budget review with Sam</a>'],
    ['input value', '<input data-target type="button" value="Budget review with Sam" />']
  ])('does not record a label taken from %s', (_name, html) => {
    click(html)

    expect(addBreadcrumb).not.toHaveBeenCalled()
  })

  it('records a label the app wrote for Sentry', () => {
    click('<button data-target data-sentry-label="Record">Grabar</button>')

    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'ui.action', message: 'Record' })
    )
  })

  it('uses the labeled parent when the click lands inside it', () => {
    click('<button data-sentry-label="Record"><span data-target>Grabar</span></button>')

    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({ message: 'Record' }))
  })
})

describe('Sentry DOM breadcrumbs', () => {
  it.each(['ui.click', 'ui.input'])('drops %s, whose selectors can hold titles', (category) => {
    expect(
      normalizeSentryBreadcrumb({ category, message: 'button[title="Budget review with Sam"]' })
    ).toBeNull()
  })
})
