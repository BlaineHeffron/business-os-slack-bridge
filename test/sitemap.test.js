import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractArticleText,
  imageCandidates,
  imageDimensions,
  MAX_IMAGE_DIMENSION,
  resizedImageUrl,
  resolveImageUrl,
  srcsetVariant,
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

// Minimal headers that imageDimensions can read.
function png(width, height) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function jpeg(width, height, { exifBytes = 0 } = {}) {
  const exif = [0xff, 0xe1, ((exifBytes + 2) >> 8) & 0xff, (exifBytes + 2) & 0xff, ...new Array(exifBytes).fill(0)];
  const sof = [0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, ...new Array(9).fill(0)];
  return new Uint8Array([0xff, 0xd8, ...exif, ...sof, 0xff, 0xd9]);
}

const image = (bytes, type = 'image/jpeg') => () =>
  new Response(bytes, { headers: { 'content-type': type, 'content-length': String(bytes.length) } });

function fakeNetwork(routes) {
  const requested = [];
  const fake = async (url) => {
    requested.push(url);
    const route = routes[url];
    if (!route) throw new Error('unreachable');
    return route();
  };
  return { fake, requested };
}

test('skips a candidate the network refuses', async () => {
  // Buffer re-hosts the asset, so an unfetchable URL fails during delivery
  // rather than visibly blocking approval. Position in the list is not
  // evidence that a URL actually serves an image.
  const { fake } = fakeNetwork({
    'https://cdn.example.com/hero': () => new Response(null, { status: 403 }),
    'https://cdn.example.com/a': image(jpeg(1200, 800)),
  });
  const chosen = await resolveImageUrl(
    ['https://cdn.example.com/hero', 'https://cdn.example.com/a'],
    fake,
  );
  assert.equal(chosen, 'https://cdn.example.com/a');
});

test('returns empty when nothing resolves, rather than a broken URL', async () => {
  const fake = async () => new Response(null, { status: 404 });
  assert.equal(await resolveImageUrl(['https://cdn.example.com/x'], fake), '');
});

test('rejects a reachable non-image', async () => {
  const fake = async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
  assert.equal(await resolveImageUrl(['https://cdn.example.com/page'], fake), '');
});

test('reads image sizes from JPEG, PNG, GIF, and WebP headers', () => {
  assert.deepEqual(imageDimensions(jpeg(6000, 4000, { exifBytes: 300 })), { width: 6000, height: 4000 });
  assert.deepEqual(imageDimensions(png(1080, 1350)), { width: 1080, height: 1350 });
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00]);
  assert.deepEqual(imageDimensions(gif), { width: 320, height: 240 });
  const webp = new Uint8Array(30);
  webp.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  webp.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
  webp.set([0x7f, 0x07, 0x00, 0x37, 0x04, 0x00], 24); // 1920 x 1080, minus one
  assert.deepEqual(imageDimensions(webp), { width: 1920, height: 1080 });
  // A JPEG cut off before its frame header is "not known yet", not a size.
  assert.equal(imageDimensions(jpeg(6000, 4000, { exifBytes: 300 }).subarray(0, 100)), null);
  assert.equal(imageDimensions(new TextEncoder().encode('<html>')), null);
});

test("prefers the page's own resized copy of og:image", () => {
  // The live Feather markup: og:image is the camera original and the hero
  // <img> carries relative Next.js variants of the same file.
  const original = 'https://cdn.example.com/blog_image/abc';
  const variant = (w) => `/_next/image?url=${encodeURIComponent(original)}&amp;w=${w}&amp;q=75 ${w}w`;
  const html = `<html><head>
      <meta property="og:image" content="${original}"/>
    </head><body><article>
      <img alt="hero" sizes="100vw" srcSet="${[640, 1080, 1920, 3840].map(variant).join(', ')}"
        src="/_next/image?url=${encodeURIComponent(original)}&amp;w=3840&amp;q=75"/>
    </article></body></html>`;
  const sized = `https://blog.example.com/_next/image?url=${encodeURIComponent(original)}&w=1920&q=75`;
  assert.deepEqual(imageCandidates(html, 'https://blog.example.com/post'), [sized, original]);
  assert.deepEqual(srcsetVariant('a.jpg 2400w, b.jpg 1200w', 'https://x.example/'), {
    url: 'https://x.example/b.jpg',
    original: 'https://x.example/b.jpg',
  });
  assert.equal(srcsetVariant('a.jpg 1x, b.jpg 2x', 'https://x.example/'), null);
});

test('an image that fits is used as-is', async () => {
  const { fake, requested } = fakeNetwork({ 'https://cdn.example.com/a': image(jpeg(1920, 1280)) });
  assert.equal(await resolveImageUrl(['https://cdn.example.com/a'], fake), 'https://cdn.example.com/a');
  assert.deepEqual(requested, ['https://cdn.example.com/a']);
});

test('an oversized image is replaced by a resized copy', async () => {
  // The failure that prompted this: Buffer refused a 6000px original.
  const original = 'https://cdn.example.com/blog_image/abc';
  const resized = resizedImageUrl(original);
  const { fake } = fakeNetwork({
    [original]: image(jpeg(6000, 4000, { exifBytes: 300 })),
    [resized]: image(jpeg(1920, 1280)),
  });
  assert.equal(await resolveImageUrl([original], fake), resized);
  const proxy = new URL(resized);
  assert.equal(proxy.origin, 'https://images.weserv.nl');
  assert.equal(proxy.searchParams.get('url'), original);
  assert.equal(proxy.searchParams.get('w'), String(MAX_IMAGE_DIMENSION));
  assert.equal(proxy.searchParams.get('output'), 'jpg');
});

test('a format Instagram refuses, or an unreadable size, is converted too', async () => {
  const webp = 'https://cdn.example.com/a.webp';
  const unknown = 'https://cdn.example.com/b';
  const { fake } = fakeNetwork({
    [webp]: image(png(800, 800), 'image/webp'),
    [resizedImageUrl(webp)]: image(jpeg(800, 800)),
    [unknown]: image(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])),
    [resizedImageUrl(unknown)]: image(jpeg(1000, 700)),
  });
  assert.equal(await resolveImageUrl([webp], fake), resizedImageUrl(webp));
  assert.equal(await resolveImageUrl([unknown], fake), resizedImageUrl(unknown));
});

test('moves on when the resizing proxy cannot serve a usable copy', async () => {
  const big = 'https://cdn.example.com/big';
  const { fake } = fakeNetwork({
    [big]: image(jpeg(6000, 4000)),
    [resizedImageUrl(big)]: () => new Response(null, { status: 502 }),
    'https://cdn.example.com/fits': image(png(1080, 1080), 'image/png'),
  });
  assert.equal(await resolveImageUrl([big, 'https://cdn.example.com/fits'], fake), 'https://cdn.example.com/fits');
});
