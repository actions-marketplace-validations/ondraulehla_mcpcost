import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shardOf, todayShard } from './shard.js';

test('the day of the cycle is the UTC day of the year modulo 7, as date +%j gives it', () => {
  // 2026-10-26 is day 299 of the year: 299 % 7 = 5.
  assert.equal(todayShard(new Date('2026-10-26T08:00:00Z')), 5);
  assert.equal(todayShard(new Date('2026-01-01T00:00:00Z')), 1);
  // Day 8, which bash reads as octal without 10#.
  assert.equal(todayShard(new Date('2026-01-08T23:59:00Z')), 1);
});

test('a name falls on one day of the cycle, always the same', () => {
  assert.equal(shardOf('io.github.example/server'), shardOf('io.github.example/server'));
  for (const n of ['a', 'b', 'gateway.pipeworx.io/x']) assert.ok(shardOf(n) >= 0 && shardOf(n) < 7);
});
