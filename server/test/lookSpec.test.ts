import { describe, it, expect } from 'vitest';
import { parseLookSpec } from '../src/schema/lookSpec.js';
import { MOCK_LOOK } from '../src/llm/client.js';

describe('look_spec', () => {
  it('接受合法方案', () => expect(parseLookSpec(JSON.stringify(MOCK_LOOK)).ok).toBe(true));
  it('接受 ```json 包裹', () => expect(parseLookSpec('```json\n' + JSON.stringify(MOCK_LOOK) + '\n```').ok).toBe(true));
  it('拒绝非法色值并指出路径', () => {
    const bad = structuredClone(MOCK_LOOK); bad.lip.primary.hex = 'red';
    const r = parseLookSpec(JSON.stringify(bad));
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toContain('lip.primary.hex');
  });
  it('拒绝非 JSON', () => expect(parseLookSpec('好的，这是方案').ok).toBe(false));
  it('ai_generated 必须为 true', () => expect(parseLookSpec(JSON.stringify({ ...MOCK_LOOK, ai_generated: false })).ok).toBe(false));
});
