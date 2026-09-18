import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shapeDigest, groupByTopic, splitRefs, feedHealth, topicCounts,
  hostOf, relativeTime, parseRoute, buildRoute, routeToParams, healthSummary,
} from '../web/feed.js';

const DIGEST = {
  check_id: 75,
  checked_at: 1789672200,
  kind: 'channels',
  posts: 220,
  refs: 220,
  highlights: ['## 科技', '美國眾議院通過法案 [1]。'],
  sections: [
    {
      channel: 'r/technology',
      topic: 'Technology',
      summary: '眾議院通過法案 [1]，加州簽署新法 [2]。',
      items: [
        { ref: 1, title: 'House Passes Bill', url: 'https://reddit.com/a', link: 'https://law.example/x', author: 'B-Z' },
        { ref: 2, title: 'California signs', url: 'https://reddit.com/b' },
      ],
    },
    { channel: 'Hacker News', topic: 'Technology', summary: 'HN 摘要。', items: [{ ref: 1, title: 'HN post', url: 'https://hn/1' }] },
    { channel: 'BBC', topic: 'UK', summary: '英國新聞。', items: [] },
  ],
};

test('shapeDigest groups channels under their topic, keeping order', () => {
  const shaped = shapeDigest(DIGEST);
  assert.equal(shaped.id, '75');
  assert.equal(shaped.posts, 220);
  assert.deepEqual(shaped.topics.map((t) => t.topic), ['Technology', 'UK']);
  assert.deepEqual(shaped.topics[0].channels.map((c) => c.channel), ['r/technology', 'Hacker News']);
  assert.equal(shaped.topics[0].posts, 3);
  assert.equal(shaped.highlights, '## 科技\n\n美國眾議院通過法案 [1]。');
});

test('groupByTopic files untagged sections under 其他', () => {
  const [group] = groupByTopic([{ channel: 'x', summary: 's', items: [] }]);
  assert.equal(group.topic, '其他');
});

test('splitRefs turns citations into ref parts and leaves the prose alone', () => {
  const items = [{ ref: 1, url: 'https://a' }, { ref: 2, url: 'https://b' }];
  const parts = splitRefs('甲 [1] 乙 [2] 丙', items);
  assert.deepEqual(parts.map((p) => p.type), ['text', 'ref', 'text', 'ref', 'text']);
  assert.equal(parts[1].item.url, 'https://a');
  assert.equal(parts.filter((p) => p.type === 'text').map((p) => p.value).join(''), '甲  乙  丙');
});

test('splitRefs ignores brackets with no matching item', () => {
  const parts = splitRefs('見 [9] 注', [{ ref: 1, url: 'https://a' }]);
  assert.deepEqual(parts, [{ type: 'text', value: '見 [9] 注' }]);
});

test('feedHealth counts failures', () => {
  const health = feedHealth([
    { name: 'a', ok: true },
    { name: 'b', ok: false, fetch_seq: 4, last_ok: 1700000000, last_error: 'timeout' },
    { name: 'c', ok: true },
  ]);
  assert.equal(health.total, 3);
  assert.equal(health.ok, 2);
  assert.equal(health.failing.length, 1);
  assert.equal(health.pending.length, 0);
  assert.deepEqual(health.failing[0], {
    name: 'b', state: 'failing', error: 'timeout', lastOk: 1700000000, errorAt: 0, attempts: 4,
  });
});

test('a feed that has never been fetched is pending, not failing', () => {
  // What upstream actually sends for a newly added feed: ok false, but no
  // attempts, no success and no error to show for it.
  const health = feedHealth([
    { name: 'r/Anthropic new', fetch_seq: 0, last_ok: null, last_error: null, error_at: null, ok: false },
  ]);
  assert.equal(health.failing.length, 0);
  assert.deepEqual(health.pending.map((p) => p.name), ['r/Anthropic new']);
  assert.equal(health.pending[0].state, 'pending');
  assert.equal(health.pending[0].attempts, 0);
});

test('a feed that failed after succeeding before is failing, not pending', () => {
  const health = feedHealth([{ name: 'x', ok: false, fetch_seq: 9, last_ok: 1700000000 }]);
  assert.equal(health.pending.length, 0);
  assert.equal(health.failing[0].state, 'failing');
});

test('healthSummary names each state, and says so when all is well', () => {
  assert.equal(healthSummary(feedHealth([{ name: 'a', ok: true }])), '1 個訊源正常');
  assert.equal(
    healthSummary(feedHealth([{ name: 'a', ok: false, fetch_seq: 0 }])),
    '1 個訊源未抓取',
  );
  assert.equal(
    healthSummary(feedHealth([{ name: 'a', ok: false, fetch_seq: 3, last_error: 'boom' }])),
    '1 個訊源失敗',
  );
  assert.equal(
    healthSummary(feedHealth([
      { name: 'a', ok: false, fetch_seq: 3, last_error: 'boom' },
      { name: 'b', ok: false, fetch_seq: 0 },
    ])),
    '1 個訊源失敗·1 個訊源未抓取',
  );
});

test('topicCounts counts channels per topic', () => {
  const counts = topicCounts(['Technology', 'AI', 'UK'], {
    'r/technology': 'Technology',
    'Hacker News': 'Technology',
    'r/OpenAI': 'AI',
  });
  assert.deepEqual(counts, [
    { topic: 'Technology', channels: 2 },
    { topic: 'AI', channels: 1 },
    { topic: 'UK', channels: 0 },
  ]);
});

test('hostOf strips www and survives junk', () => {
  assert.equal(hostOf('https://www.bbc.co.uk/news'), 'bbc.co.uk');
  assert.equal(hostOf('not a url'), '');
});

test('relativeTime speaks Cantonese units', () => {
  const now = 1_000_000_000_000;
  const at = (seconds) => relativeTime(now / 1000 - seconds, now);
  assert.equal(at(10), '啱啱');
  assert.equal(at(600), '10 分鐘前');
  assert.equal(at(3 * 3600), '3 小時前');
  assert.equal(at(2 * 86400), '2 日前');
  assert.equal(relativeTime(0, now), '');
});

test('parseRoute and buildRoute round-trip', () => {
  const route = { view: 'digests', topic: 'AI', channel: '', page: 3 };
  assert.equal(buildRoute(route), '#/digests?topic=AI&page=3');
  assert.deepEqual(parseRoute('#/digests?topic=AI&page=3'), route);
});

test('parseRoute defaults an unknown view to digests', () => {
  assert.equal(parseRoute('#/nonsense').view, 'digests');
  assert.equal(parseRoute('').view, 'digests');
  assert.equal(parseRoute('#/daily').view, 'daily');
});

test('routeToParams maps the route onto upstream parameter names', () => {
  assert.equal(routeToParams({ topic: 'Daily Summary', page: 1 }).toString(), 'topics=Daily+Summary');
  assert.equal(routeToParams({ channel: 'r/technology', page: 2 }).toString(), 'channel=r%2Ftechnology&page=2');
  assert.equal(routeToParams({}).toString(), '');
});
