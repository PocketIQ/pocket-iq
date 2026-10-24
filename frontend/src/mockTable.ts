import type { AnalyzeResponse, Game, ShotEvent } from './types'

// Fake /analyze response for building the correction UI without taking photos. The 2, 7,
// 13 and 15 are missing because MOCK_GAME's history pocketed them.
// Includes a few deliberate mistakes to correct: low-confidence balls, a stripe
// read as the 4, and a ghost ball to remove. Every ball has a number, like game photos.
export const MOCK_TABLE: AnalyzeResponse = {
  table: { width: 1000, height: 500 },
  ball_radius: 11,
  balls: [
    { id: null, type: 'cue', x: 250, y: 250, confidence: 0.98 },
    { id: 8, type: 'eight', x: 700, y: 250, confidence: 0.95 },
    { id: 1, type: 'solid', x: 600, y: 180, confidence: 0.92 },
    { id: 3, type: 'solid', x: 880, y: 400, confidence: 0.55 }, // low confidence
    { id: 5, type: 'solid', x: 450, y: 380, confidence: 0.9 },
    { id: 9, type: 'stripe', x: 640, y: 330, confidence: 0.86 },
    { id: 4, type: 'solid', x: 960, y: 60, confidence: 0.42 }, // misread: really the 10
    { id: 12, type: 'stripe', x: 380, y: 140, confidence: 0.9 },
    { id: 14, type: 'stripe', x: 520, y: 460, confidence: 0.77 },
    { id: 11, type: 'stripe', x: 760, y: 440, confidence: 0.6 },
    { id: 6, type: 'solid', x: 100, y: 470, confidence: 0.3 }, // ghost: remove it
  ],
}

const shot = (photo: number, player: string, pocketed: number[], result: ShotEvent['result']): ShotEvent => ({
  t: 1761300000 + photo * 60,
  player,
  pocketed,
  scratch: false,
  result,
  intended: null,
  made: null,
  coached: false,
  photo,
  advice: null,
})

/**
 * A game in progress to go with MOCK_TABLE, covering each gutter case: the 13 on the break
 * (no ring), side 2 taking stripes with the 15, then pocketing the 2 (a solid: wrong ball,
 * dashed ring), and side 1 pocketing the 7. With teams, each side's two players alternate.
 */
export function mockGame(teams: boolean): Game {
  const [a, b] = teams ? ['Sharks', 'Jets'] : ['You', 'Friend']
  const sunk = new Set(['2', '7', '13', '15'])
  return {
    id: 'dev',
    players: [{ name: a, group: 'solid' }, { name: b, group: 'stripe' }],
    turn: 0,
    winner: null,
    balls: Object.fromEntries(
      ['cue', ...Array.from({ length: 15 }, (_, i) => String(i + 1))].map(n => [n, sunk.has(n) ? 'sunk' : 'on']),
    ),
    history: [
      shot(2, a, [13], 'turn passes'), // the break
      shot(3, b, [15], 'continues'),
      shot(4, b, [2], 'turn passes'),
      shot(5, a, [7], 'continues'),
      shot(6, a, [], 'turn passes'),
      shot(7, b, [], 'turn passes'),
    ],
    gutter: [
      { ball: 13, by: null, member: null, photo: 2, open: true },
      { ball: 15, by: 1, member: null, photo: 3, open: true },
      { ball: 2, by: 1, member: null, photo: 4, open: false },
      { ball: 7, by: 0, member: null, photo: 5, open: false },
    ],
    layout: null,
  }
}

export const MOCK_ROSTERS: [string[], string[]] = [['Ana', 'Ben'], ['Cal', 'Dee']]
