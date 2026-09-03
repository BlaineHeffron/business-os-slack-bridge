import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPageMetadata,
  extractSitemapPosts,
  fetchText,
  planSitemapChanges,
  sitemapIdempotencyKey,
} from '../src/sitemap.js';

const options = {
  startMarker: 'Begin Blogs Endpoints',
  endMarker: 'Begin Listing Endpoints',
  publicBaseUrl: 'https://book.example.com',
};

test('extracts only marked blog URLs and replaces the source host', () => {
  const xml = `
    <urlset>
      <url><loc>https://source.example.com/about</loc></url>
      <!--Begin Blogs Endpoints-->
      <url><loc>https://source.example.com/blog/new-post?a=1&amp;b=2</loc></url>
      <url><loc>https://other.example.com/blog/new-post?a=1&amp;b=2</loc></url>
      <!--Begin Listing Endpoints-->
      <url><loc>https://source.example.com/rentals/home</loc></url>
    </urlset>`;
  assert.deepEqual(extractSitemapPosts(xml, options), [
    {
      externalId: '/blog/new-post',
      url: 'https://book.example.com/blog/new-post?a=1&b=2',
    },
  ]);
});

test('fails closed when sitemap markers change', () => {
  assert.throws(() => extractSitemapPosts('<urlset/>', options), /markers are missing/);
});

test('keeps unusual sitemap paths on the configured public host', () => {
  const xml = `
    <!--Begin Blogs Endpoints-->
    <url><loc>https://source.example.com//untrusted.example/path</loc></url>
    <!--Begin Listing Endpoints-->`;
  assert.equal(extractSitemapPosts(xml, options)[0].url, 'https://book.example.com//untrusted.example/path');
});

test('fails closed when the marked section is empty', () => {
  const xml = '<!--Begin Blogs Endpoints--><!--Begin Listing Endpoints-->';
  assert.throws(() => extractSitemapPosts(xml, options), /contains no URLs/);
});

test('reads social metadata without depending on attribute order', () => {
  const html = `
    <html><head>
      <meta content="A &amp; B" property="og:title">
      <meta content="A useful author&#x27;s summary." name="description">
    </head></html>`;
  assert.deepEqual(extractPageMetadata(html), { title: 'A & B', excerpt: "A useful author's summary." });
});

test('uses the title element when Open Graph metadata is absent', () => {
  assert.deepEqual(extractPageMetadata('<title>New Post</title>'), { title: 'New Post', excerpt: '' });
});

test('the first scan creates only a baseline', () => {
  const posts = [{ externalId: '/existing', url: 'https://book.example.com/existing' }];
  assert.deepEqual(planSitemapChanges(posts, null), {
    baselinePaths: ['/existing'],
    newPosts: [],
  });
});

test('later scans select only unseen paths', () => {
  const posts = [
    { externalId: '/existing', url: 'https://book.example.com/existing' },
    { externalId: '/new', url: 'https://book.example.com/new' },
  ];
  assert.deepEqual(planSitemapChanges(posts, ['/existing']), {
    baselinePaths: null,
    newPosts: [posts[1]],
  });
});

test('creates a stable path idempotency key', () => {
  assert.equal(sitemapIdempotencyKey('/blog/new-post'), sitemapIdempotencyKey('/blog/new-post'));
  assert.notEqual(sitemapIdempotencyKey('/blog/new-post'), sitemapIdempotencyKey('/blog/other-post'));
});

test('rejects unsuccessful HTTP responses', async () => {
  const fetchImpl = async () => new Response('missing', { status: 404 });
  await assert.rejects(fetchText('https://example.com/missing', fetchImpl), /HTTP 404/);
});
