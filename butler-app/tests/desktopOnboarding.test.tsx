import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OnboardingCall } from '../src/onboarding/OnboardingCall'
afterEach(cleanup)
it('手机主动开引导只提示回电脑，不自动通话或改进度', () => {
  const close = vi.fn()
  const client = vi.fn()
  render(<OnboardingCall onClose={close} createCallClient={client} />)
  expect(screen.getByText(/首次引导请在电脑上继续/)).toBeTruthy()
  expect(client).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '回主页' }))
  expect(close).toHaveBeenCalledOnce()
})
