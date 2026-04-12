import { describe, it, expect } from 'vitest';
import {
  cloneAndCleanNlmResponse,
  isCitationNode,
  serializeToProtectedMD,
  prepareNlmResponseForNotion,
} from '../copy-handler';

describe('copy-handler', () => {
  it('isCitationNode detects SUP with isolated digit', () => {
    const sup = document.createElement('sup');
    sup.textContent = '1';
    const p = document.createElement('p');
    p.appendChild(document.createTextNode('Hello '));
    p.appendChild(sup);
    p.appendChild(document.createTextNode(' world'));
    expect(isCitationNode(sup)).toBe(true);
  });

  it('serializeToProtectedMD emits VIDEO_CITATION tags', () => {
    const p = document.createElement('p');
    p.appendChild(document.createTextNode('Hello '));
    const sup = document.createElement('sup');
    sup.textContent = '2';
    p.appendChild(sup);
    const out = serializeToProtectedMD(p);
    expect(out).toContain('<VIDEO_CITATION id="2"/>');
  });

  it('cloneAndCleanNlmResponse removes buttons and does not mutate original', () => {
    const wrap = document.createElement('div');
    const p = document.createElement('p');
    p.textContent = 'Text';
    const btn = document.createElement('button');
    btn.textContent = 'more_horiz';
    wrap.appendChild(p);
    wrap.appendChild(btn);
    const clone = cloneAndCleanNlmResponse(wrap);
    expect(wrap.querySelector('button')).not.toBeNull();
    expect(clone.querySelector('button')).toBeNull();
  });

  it('prepareNlmResponseForNotion runs full pipeline', async () => {
    const root = document.createElement('div');
    const p = document.createElement('p');
    p.appendChild(document.createTextNode('Ref '));
    const a = document.createElement('a');
    a.textContent = '1';
    p.appendChild(a);
    p.appendChild(document.createTextNode(' done'));
    root.appendChild(p);
    const result = await prepareNlmResponseForNotion(root);
    expect(result.protectedText).toContain('<VIDEO_CITATION id="1"/>');
  });
});
