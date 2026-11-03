import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalModelId,
  canonicalizeModelEntries,
  canonicalizeModelIds,
} from '../src/modelIds.js';

test('retired 3.8 aliases collapse to gemini-3.8-flash-high', () => {
  assert.equal(canonicalModelId('gemini-3.8-flash-tiered'), 'gemini-3.8-flash-high');
  assert.equal(canonicalModelId('gemini-3.8-flash-low'), 'gemini-3.8-flash-high');
  assert.equal(canonicalModelId('gemini-3.8-flash-high'), 'gemini-3.8-flash-high');
});

test('other model families keep their exact ids', () => {
  for (const id of [
    'gemini-3.5-flash-low',
    'gemini-3.5-flash-high',
    'gemini-3.6-flash-tiered',
    'gemini-3.1-flash-lite',
    'claude-opus-4-6-thinking',
    'gpt-oss-120b-medium',
  ]) {
    assert.equal(canonicalModelId(id), id);
  }
});

test('canonicalizeModelIds renames, de-duplicates and preserves order', () => {
  assert.deepEqual(
    canonicalizeModelIds([
      'gemini-3.8-flash-tiered',
      'gemini-3.1-flash-lite',
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-low',
    ]),
    ['gemini-3.8-flash-high', 'gemini-3.1-flash-lite'],
  );
});

test('canonicalizeModelEntries renames entries and drops duplicates', () => {
  const entries = canonicalizeModelEntries([
    { id: 'gemini-3.8-flash-tiered', object: 'model', owned_by: 'antigravity' },
    { id: 'gemini-3.8-flash-high', object: 'model', owned_by: 'antigravity' },
    { id: 'gemini-3.8-flash-low', object: 'model', owned_by: 'antigravity' },
    { id: 'gemini-3.1-flash-lite', object: 'model', owned_by: 'antigravity' },
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.id),
    ['gemini-3.8-flash-high', 'gemini-3.1-flash-lite'],
  );
  assert.equal(entries[0].owned_by, 'antigravity');
});
