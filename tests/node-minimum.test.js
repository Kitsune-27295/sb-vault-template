import { describe, it, expect } from 'vitest';
import { meetsNodeMinimum } from '../tools/doctor.js';

// `node:sqlite` needs `--experimental-sqlite` before v22.13.0 and v23.4.0 (nodejs.org/api/sqlite.html).
describe('Node minimum for node:sqlite', () => {
  it.each([
    ['20.18.0', false],
    ['21.9.0', false],
    ['22.5.0', false],
    ['22.12.0', false],
    ['22.13.0', true],
    ['22.22.1', true],
    ['23.3.0', false],
    ['23.4.0', true],
    ['24.0.0', true],
    ['24.22.1', true],
    ['26.13.0', true],
  ])('%s -> %s', (version, expected) => {
    expect(meetsNodeMinimum(version)).toBe(expected);
  });
});
