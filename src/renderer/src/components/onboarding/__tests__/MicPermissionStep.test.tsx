import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MicPermissionStep } from '../MicPermissionStep'

describe('MicPermissionStep', () => {
  it('renders required badge and enable button', () => {
    render(<MicPermissionStep onNext={vi.fn()} />)
    expect(screen.getByText('REQUIRED')).toBeInTheDocument()
    expect(screen.getByText('Enable Microphone')).toBeInTheDocument()
  })

  it('does not show Continue until permission granted', () => {
    render(<MicPermissionStep onNext={vi.fn()} />)
    expect(screen.queryByText('Continue →')).not.toBeInTheDocument()
  })
})
