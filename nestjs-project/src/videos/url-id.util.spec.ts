import { generateUrlId } from './url-id.util';

describe('generateUrlId', () => {
  it('returns an 11-character base64url string', () => {
    const id = generateUrlId();
    expect(id).toHaveLength(11);
    expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('does not repeat across 10 000 generated ids', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => generateUrlId()));
    expect(ids.size).toBe(10_000);
  });
});
