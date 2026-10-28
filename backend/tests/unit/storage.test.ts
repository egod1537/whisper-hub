import { describe, expect, it } from 'vitest';
import { contentDisposition, resolveInside, safeDownloadBaseName } from '../../src/shared/storage/paths.js';

describe('storage paths', () => {
  it('blocks traversal and absolute paths', () => {
    expect(() => resolveInside('/data', '../secret')).toThrow();
    expect(() => resolveInside('/data', '/etc/passwd')).toThrow();
    expect(resolveInside('/data', 'uploads/id/source')).toBe('/data/uploads/id/source');
  });

  it('creates safe download headers', () => {
    expect(safeDownloadBaseName('../../evil\r\nname.mp3')).toBe('evil__name');
    expect(contentDisposition('한국어.txt')).toContain("filename*=UTF-8''");
    expect(contentDisposition('bad\r\n.txt')).not.toContain('\r');
  });
});

