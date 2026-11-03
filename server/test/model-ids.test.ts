import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalModelId,
  canonicalizeModelEntries,
  canonicalizeModelIds,
  includeVerifiedWebsiteModels,
  isUnavailableWebsiteModel,
  UNAVAILABLE_WEBSITE_MODEL_IDS,
  VERIFIED_WEBSITE_MODEL_IDS,
} from '../src/modelIds.js';

test('the retired tiered id maps to gemini-3.8-flash-high', () => {
  assert.equal(canonicalModelId('gemini-3.8-flash-tiered'), 'gemini-3.8-flash-high');
  assert.equal(canonicalModelId('gemini-3.8-flash-high'), 'gemini-3.8-flash-high');
  assert.equal(canonicalModelId('gemini-3.8-flash-low'), 'gemini-3.8-flash-low');
});

test('other model families keep their exact ids', () => {
  for (const id of [
    'gemini-3.8-flash-low',
    'gemini-3.5-flash-low',
    'gemini-3.5-flash-high',
    'gemini-3.6-flash-tiered',
    'gemini-3.7-flash-tiered',
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
    ['gemini-3.8-flash-high', 'gemini-3.1-flash-lite', 'gemini-3.8-flash-low'],
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
    ['gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-3.1-flash-lite'],
  );
  assert.equal(entries[0].owned_by, 'antigravity');
});

test('the website list adds verified ids the core omits without dropping live ones', () => {
  const live = [
    'claude-opus-4-6-thinking',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-image',
    'gpt-oss-120b-medium',
  ];

  const merged = includeVerifiedWebsiteModels(live);

  // Usable live ids keep their positions, so the Models page order is unchanged.
  assert.deepEqual(merged.slice(0, live.length), live);
  // Every verified alias is present exactly once.
  for (const id of VERIFIED_WEBSITE_MODEL_IDS) {
    assert.equal(merged.filter((value) => value === id).length, 1, `${id} appears once`);
  }
  // Ids that already exist upstream are not appended a second time.
  assert.equal(new Set(merged).size, merged.length);
  assert.ok(!merged.includes('claude-haiku-4-5'));
  assert.ok(!merged.includes('claude-opus-4-5'));

  // The verified-but-unlisted Claude ids are what makes the extra models usable.
  for (const id of [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-sonnet-4-5',
    'claude-sonnet-4-5-thinking',
    'claude-opus-4-5-thinking',
    'claude-haiku-4-5-20251001',
  ]) {
    assert.ok(merged.includes(id), `${id} is offered`);
  }
});

test('the website list drops core ids whose pool is currently unhealthy', () => {
  const live = [
    'gemini-3.6-flash',
    'gemini-3.7-flash-tiered',
    'gemini-3.5-flash-high',
    'gemini-3.8-flash-high',
    'gemini-3.5-flash-lite',
  ];

  const merged = includeVerifiedWebsiteModels(live);

  for (const id of ['gemini-3.6-flash', 'gemini-3.7-flash-tiered', 'gemini-3.5-flash-high']) {
    assert.ok(!merged.includes(id), `${id} is hidden`);
  }
  assert.ok(merged.includes('gemini-3.8-flash-high'));
  assert.ok(merged.includes('gemini-3.5-flash-lite'));
  for (const id of UNAVAILABLE_WEBSITE_MODEL_IDS) {
    assert.ok(!merged.includes(id), `${id} is hidden`);
  }
  // Hiding is website-only: the canonical id still exists for /v1/models.
  assert.equal(canonicalModelId('gemini-3.7-flash-tiered'), 'gemini-3.7-flash-tiered');
});

test('hiding is decided on the canonical id, so a retired alias cannot slip through', () => {
  assert.equal(isUnavailableWebsiteModel('gemini-3.7-flash-tiered'), true);
  assert.equal(isUnavailableWebsiteModel('gemini-3.6-flash-tiered'), true);
  assert.equal(isUnavailableWebsiteModel('gemini-3.8-flash-tiered'), false);
  assert.equal(isUnavailableWebsiteModel('gemini-3.8-flash-high'), false);
  assert.equal(isUnavailableWebsiteModel('claude-sonnet-4-6'), false);
});

test('the website list rewrites the retired tiered id instead of exposing it', () => {
  const merged = includeVerifiedWebsiteModels(['gemini-3.8-flash-tiered', 'gemini-3.8-flash-low']);

  assert.ok(merged.includes('gemini-3.8-flash-high'));
  assert.ok(merged.includes('gemini-3.8-flash-low'));
  assert.ok(!merged.includes('gemini-3.8-flash-tiered'));
  assert.equal(merged.filter((value) => value === 'gemini-3.8-flash-high').length, 1);
});

test('the website list still returns the verified ids when the gateway sends nothing', () => {
  assert.deepEqual(includeVerifiedWebsiteModels([]), [...VERIFIED_WEBSITE_MODEL_IDS]);
});
