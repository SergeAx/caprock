import { describe, expect, it } from 'vitest'
import { DEFAULT_UI_SCALE, getUiScale, setUiScale, stepUiScale } from './uiscale'

describe('uiscale', () => {
  it('steps within the list and resets to the default', () => {
    setUiScale(1)
    stepUiScale(-1)
    expect(getUiScale()).toBe(1)
    stepUiScale(1)
    expect(getUiScale()).toBe(1.1)
    stepUiScale(1); stepUiScale(1); stepUiScale(1)
    expect(getUiScale()).toBe(1.4)
    stepUiScale(0)
    expect(getUiScale()).toBe(DEFAULT_UI_SCALE)
    expect(localStorage.getItem('caprock.uiScale')).toBe(String(DEFAULT_UI_SCALE))
  })
})
