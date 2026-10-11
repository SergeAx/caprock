import { describe, expect, it } from 'vitest'
import { isExternalLink } from './externalLinks'

const link = (href: string, target = '') => {
  const a = document.createElement('a')
  a.setAttribute('href', href)
  if (target) a.target = target
  return a
}

describe('external links in the app', () => {
  it('sends a new-window link or another origin to the browser', () => {
    expect(isExternalLink(link('https://github.com/dspv/caprock/releases/latest', '_blank'), 'http://127.0.0.1:4173')).toBe(true)
    expect(isExternalLink(link('https://caprock.dev/changelog'), 'http://127.0.0.1:4173')).toBe(true)
    expect(isExternalLink(link('mailto:hi@caprock.dev'), 'http://127.0.0.1:4173')).toBe(true)
  })
  it('keeps the dashboard own routes and odd schemes in the page', () => {
    expect(isExternalLink(link('#/history'), 'http://127.0.0.1:4173')).toBe(false)
    expect(isExternalLink(link('/v1/export'), 'http://127.0.0.1:4173')).toBe(false)
    expect(isExternalLink(link('javascript:void(0)', '_blank'), 'http://127.0.0.1:4173')).toBe(false)
  })
})
