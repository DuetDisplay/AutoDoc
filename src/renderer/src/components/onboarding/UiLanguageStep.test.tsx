import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { UiLanguageStep } from './UiLanguageStep'
import { I18nProvider } from '../../services/i18n'

beforeEach(() => {
  localStorage.clear()
  window.electronAPI = {
    invoke: vi.fn(async (channel: string) =>
      channel === 'prefs:get-ui-language' ? 'en' : undefined
    ),
    on: vi.fn(() => () => {}),
    send: vi.fn()
  } as any
})
it('switches its own text immediately using the same saved preference as Settings', async () => {
  const next = vi.fn()
  render(
    <I18nProvider>
      <UiLanguageStep onNext={next} />
    </I18nProvider>
  )
  await screen.findByRole('heading', { name: 'Choose your language' })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'App language' })))
  await act(async () => fireEvent.click(screen.getByRole('option', { name: 'Español' })))
  expect(window.electronAPI.invoke).toHaveBeenCalledWith('prefs:set-ui-language', 'es')
  expect(localStorage.getItem('autodoc-ui-language')).toBe('es')
  expect(screen.getByRole('heading')).toHaveTextContent('Elige tu idioma')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Continuar' })))
  expect(next).toHaveBeenCalledOnce()
})
