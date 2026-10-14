import { describe, expect, it } from 'vitest';

describe('web workspace', () => {
  it('runs its test environment', () => {
    expect(document.createElement('div')).toBeInstanceOf(HTMLDivElement);
  });
});
