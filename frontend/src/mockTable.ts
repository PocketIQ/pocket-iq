import type { AnalyzeResponse } from './types'

// Fake /analyze response for building the correction UI without taking photos.
// Includes a few deliberate mistakes to correct: low-confidence balls, a stripe
// mislabeled as a solid, an unknown id, and a ghost ball to remove.
export const MOCK_TABLE: AnalyzeResponse = {
  table: { width: 1000, height: 500 },
  ball_radius: 11,
  balls: [
    { id: null, type: 'cue', x: 250, y: 250, confidence: 0.98 },
    { id: 8, type: 'eight', x: 700, y: 250, confidence: 0.95 },
    { id: 1, type: 'solid', x: 600, y: 180, confidence: 0.92 },
    { id: 2, type: 'solid', x: 820, y: 120, confidence: 0.88 },
    { id: 3, type: 'solid', x: 880, y: 400, confidence: 0.55 }, // low confidence
    { id: 5, type: 'solid', x: 450, y: 380, confidence: 0.9 },
    { id: 7, type: 'solid', x: 150, y: 90, confidence: 0.81 },
    { id: 9, type: 'stripe', x: 640, y: 330, confidence: 0.86 },
    { id: 10, type: 'solid', x: 960, y: 60, confidence: 0.42 }, // mislabeled: 10 is a stripe
    { id: 12, type: 'stripe', x: 380, y: 140, confidence: 0.9 },
    { id: 14, type: 'stripe', x: 520, y: 460, confidence: 0.77 },
    { id: null, type: 'stripe', x: 760, y: 440, confidence: 0.6 }, // unknown id
    { id: null, type: 'solid', x: 100, y: 470, confidence: 0.3 }, // ghost: hold to remove
  ],
  debug: { received_bytes: 0, image_size: [0, 0], markers_used: [] },
}
