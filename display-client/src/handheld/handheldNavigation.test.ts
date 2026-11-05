import { describe, expect, it } from 'vitest';
import * as handheldNavigation from './handheldNavigation.ts';

const { classifyHorizontalSwipe, navigationForSwipe, settingsClosePolicy } = handheldNavigation;
const navigationForSwipeProgress = (
  handheldNavigation as typeof handheldNavigation & {
    navigationForSwipeProgress?: (
      surface: 'home' | 'games' | 'apps' | 'settings',
      start: { x: number; y: number },
      current: { x: number; y: number },
    ) => unknown;
  }
).navigationForSwipeProgress;
const navigationForTrackedTouch = (
  handheldNavigation as typeof handheldNavigation & {
    navigationForTrackedTouch?: (
      surface: 'home' | 'games' | 'apps' | 'settings',
      session: { identifier: number; start: { x: number; y: number } },
      touches: ArrayLike<{ identifier: number; clientX: number; clientY: number }>,
    ) => unknown;
  }
).navigationForTrackedTouch;

describe('classifyHorizontalSwipe', () => {
  it('recognizes both directions once the horizontal threshold is reached', () => {
    expect(classifyHorizontalSwipe(-56, 10)).toBe('left');
    expect(classifyHorizontalSwipe(56, -10)).toBe('right');
  });

  it('does not turn a short drag into page navigation', () => {
    expect(classifyHorizontalSwipe(55, 0)).toBeNull();
    expect(classifyHorizontalSwipe(-30, 2)).toBeNull();
  });

  it('leaves vertical and diagonal scrolling alone', () => {
    expect(classifyHorizontalSwipe(40, 80)).toBeNull();
    expect(classifyHorizontalSwipe(80, 65)).toBeNull();
  });
});

describe('navigationForSwipe', () => {
  it.each([
    ['home', 'left', { kind: 'page', page: 'games' }],
    ['home', 'right', { kind: 'settings', origin: 'home' }],
    ['games', 'left', { kind: 'page', page: 'apps' }],
    ['games', 'right', { kind: 'page', page: 'home' }],
    ['apps', 'right', { kind: 'page', page: 'games' }],
  ] as const)('%s + %s executes the agreed navigation', (page, direction, expected) => {
    expect(navigationForSwipe(page, direction)).toEqual(expected);
  });

  it('swiping left closes settings through the same return policy as the back button', () => {
    const navigate = navigationForSwipe as unknown as (
      surface: 'home' | 'games' | 'apps' | 'settings',
      direction: 'left' | 'right',
    ) => unknown;
    expect(navigate('settings', 'left')).toEqual({ kind: 'close-settings' });
  });

  it('does nothing only at the outside edge of the page chain', () => {
    expect(navigationForSwipe('apps', 'left')).toEqual({ kind: 'none' });
  });

  it('resolves a game-page swipe as soon as move crosses the threshold', () => {
    expect(navigationForSwipeProgress?.('games', { x: 260, y: 180 }, { x: 188, y: 190 })).toEqual({
      kind: 'page',
      page: 'apps',
    });
  });

  it('tracks the native touch identifier and resolves before WebView scroll cancels the gesture', () => {
    const touches = [
      { identifier: 3, clientX: 410, clientY: 90 },
      { identifier: 9, clientX: 188, clientY: 190 },
    ];

    expect(navigationForTrackedTouch?.(
      'games',
      { identifier: 9, start: { x: 260, y: 180 } },
      touches,
    )).toEqual({ kind: 'page', page: 'apps' });
  });

  it('does not substitute another finger after the tracked native touch disappears', () => {
    expect(navigationForTrackedTouch?.(
      'games',
      { identifier: 9, start: { x: 260, y: 180 } },
      [{ identifier: 3, clientX: 188, clientY: 190 }],
    )).toEqual({ kind: 'none' });
  });
});

describe('settingsClosePolicy', () => {
  it('stops the preview and restores home only for settings opened from home', () => {
    expect(settingsClosePolicy('home')).toEqual({ destination: 'home', keepStrip: false });
  });

  it('keeps the strip and returns to the running game for settings opened from the strip', () => {
    expect(settingsClosePolicy('game')).toEqual({ destination: 'game', keepStrip: true });
  });
});
