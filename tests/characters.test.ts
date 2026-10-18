import { describe, expect, it } from 'vitest';
import { castLooks, CHARACTERS, sanitizeCharacter } from '../src/render/characters';
import { buildOfName } from '../src/game/roster';

describe('characters', () => {
  it('casts opponents by build, never twinning a look', () => {
    expect(castLooks([{ character: 'cody' }, { build: 'female' }]).map((l) => l.id)).toEqual(['cody', 'sarah']);
    expect(castLooks([{ character: 'sarah' }, { build: 'male' }]).map((l) => l.id)).toEqual(['sarah', 'cody']);
    const [a, b] = castLooks([{ character: 'cody' }, { build: 'male' }]);
    expect(a.id).toBe('cody');
    expect(b.build).toBe('male');
    expect(b.id).not.toBe('cody');
    const [c, d] = castLooks([{ character: 'sarah' }, { character: 'sarah' }]);
    expect(c.id).toBe('sarah');
    expect(d.build).toBe('female');
    expect(d.id).not.toBe('sarah');
  });

  it('reads builds from first names', () => {
    expect(buildOfName('Darlene Pruitt')).toBe('female');
    expect(buildOfName('Marge Delaney')).toBe('female');
    expect(buildOfName('Gus Barlow')).toBe('male');
    expect(buildOfName('“Dead Center” Voss')).toBe('male');
    expect(buildOfName('')).toBe('male');
  });

  it('falls back to Cody for unknown saved characters', () => {
    expect(sanitizeCharacter('sarah')).toBe('sarah');
    expect(sanitizeCharacter('bob')).toBe('cody');
    expect(sanitizeCharacter(undefined)).toBe('cody');
    expect(CHARACTERS.cody.look.height).toBeGreaterThan(CHARACTERS.sarah.look.height);
  });
});
