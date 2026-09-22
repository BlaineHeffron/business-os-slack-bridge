import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractArticleText,
  imageCandidates,
  resolveImageUrl,
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
  assert.deepEqual(extractPageMetadata(html), {
    title: 'A & B',
    excerpt: "A useful author's summary.",
    imageCandidates: [],
  });
});

test('uses the title element when Open Graph metadata is absent', () => {
  assert.deepEqual(extractPageMetadata('<title>New Post</title>'), {
    title: 'New Post',
    excerpt: '',
    imageCandidates: [],
  });
});

test('falls back to the article heading when the page has no title metadata', () => {
  const html = '<html><head><meta charset="utf-8"></head><body><h1 class="post">Mount\n  Pleasant &amp; <em>more</em></h1></body></html>';
  assert.equal(extractPageMetadata(html).title, 'Mount Pleasant & more');
  assert.throws(() => extractPageMetadata('<html><body><p>nothing</p></body></html>'), /no title/);
});

test('falls back to the URL slug only when the page has article text', () => {
  const url = 'https://book.example.com/best-luxury-family-vacation-rentals-in-mount-pleasant-sc';
  const prose = `<html><body><main><p>${'Shem Creek is a short walk away and the kitchens run at full tilt. '.repeat(8)}</p></main></body></html>`;
  assert.equal(extractPageMetadata(prose, url).title, 'Best luxury family vacation rentals in mount pleasant sc');
  assert.throws(() => extractPageMetadata('<html><body></body></html>', url), /no title/);
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

test('reads the article body, not just the meta description', () => {
  const html = `<html><head>
      <meta property="og:title" content="Large group rentals"/>
      <meta property="og:description" content="A short summary."/>
    </head><body><main>
      <p>Sleeps twelve guests across five bedrooms.</p>
      <p>Two minutes from the beach access path.</p>
    </main></body></html>`;
  const metadata = extractPageMetadata(html);
  assert.equal(metadata.title, 'Large group rentals');
  assert.match(metadata.excerpt, /A short summary\./);
  assert.match(metadata.excerpt, /Sleeps twelve guests across five bedrooms\./);
  assert.match(metadata.excerpt, /Two minutes from the beach access path\./);
});

test('prefers the container with text over an empty <article> wrapper', () => {
  // The real failure: on a live post the only <article> wrapped the hero image
  // and held no prose, so preferring it by tag name produced an empty excerpt.
  const html = `<html><body>
      <article><div><img alt="hero"/></div></article>
      <div><p>The porch overlooks the marsh at sunset.</p></div>
    </body></html>`;
  assert.match(extractArticleText(html), /The porch overlooks the marsh at sunset\./);
});

test('excludes scripts, styles, and markup that is not prose', () => {
  const html = `<html><body><main>
      <script>var tracking = "do not quote me";</script>
      <style>.cta { color: red; }</style>
      <p>Pet friendly with a fenced yard.</p>
    </main></body></html>`;
  const text = extractArticleText(html);
  assert.match(text, /Pet friendly with a fenced yard\./);
  assert.doesNotMatch(text, /do not quote me/);
  assert.doesNotMatch(text, /color: red/);
});

test('drops navigation repeated in the header and footer', () => {
  const html = `<html><body>
      <div>Blogs</div><div>Contact Us</div>
      <main><p>Four bedrooms with an ocean view.</p></main>
      <div>Blogs</div><div>Contact Us</div>
    </body></html>`;
  const lines = extractArticleText(html).split('\n');
  assert.equal(lines.filter((line) => line === 'Blogs').length, 1);
  assert.equal(lines.filter((line) => line === 'Contact Us').length, 1);
});

test('keeps block boundaries so words never fuse across elements', () => {
  const html = '<html><body><main><p>Isle of Palms</p><p>Sullivans Island</p></main></body></html>';
  assert.doesNotMatch(extractArticleText(html), /PalmsSullivans/);
});

test('truncates on a sentence boundary so a quote never spans the cut', () => {
  const sentence = 'The cottage sleeps eight guests comfortably. ';
  const html = `<html><body><main><p>${sentence.repeat(40)}</p></main></body></html>`;
  const text = extractArticleText(html, 400);
  assert.ok(text.length <= 400);
  assert.ok(text.endsWith('.'), `expected a sentence end, got ${JSON.stringify(text.slice(-30))}`);
});

test('offers og:image first, then rendered artwork, largest variant first', () => {
  const html = `<html><head>
      <meta property="og:image" content="https://cdn.example.com/hero"/>
    </head><body><article>
      <img src="https://cdn.example.com/a_small"/>
      <img src="https://cdn.example.com/a_medium"/>
      <img src="https://cdn.example.com/a"/>
    </article></body></html>`;
  assert.deepEqual(imageCandidates(html), [
    'https://cdn.example.com/hero',
    'https://cdn.example.com/a',
    'https://cdn.example.com/a_medium',
    'https://cdn.example.com/a_small',
  ]);
});

test('never offers a non-https candidate', () => {
  const html = '<html><head><meta property="og:image" content="http://cdn.example.com/x"/></head></html>';
  assert.deepEqual(imageCandidates(html), []);
});

test('skips a candidate the network refuses', async () => {
  // Buffer re-hosts the asset, so an unfetchable URL fails during delivery
  // rather than visibly blocking approval. Position in the list is not
  // evidence that a URL actually serves an image.
  const responses = {
    'https://cdn.example.com/hero': { ok: false, status: 403, headers: new Map() },
    'https://cdn.example.com/a': { ok: true, headers: new Map([['content-type', 'image/jpeg']]) },
  };
  const fake = async (url) => {
    const r = responses[url];
    if (!r) throw new Error('unreachable');
    return { ok: r.ok, headers: { get: (k) => r.headers.get(k) ?? null } };
  };
  const chosen = await resolveImageUrl(
    ['https://cdn.example.com/hero', 'https://cdn.example.com/a'],
    fake,
  );
  assert.equal(chosen, 'https://cdn.example.com/a');
});

test('returns empty when nothing resolves, rather than a broken URL', async () => {
  const fake = async () => ({ ok: false, headers: { get: () => null } });
  assert.equal(await resolveImageUrl(['https://cdn.example.com/x'], fake), '');
});

test('rejects a reachable non-image', async () => {
  const fake = async () => ({ ok: true, headers: { get: () => 'text/html' } });
  assert.equal(await resolveImageUrl(['https://cdn.example.com/page'], fake), '');
});
