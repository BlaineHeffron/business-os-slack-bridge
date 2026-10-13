import { createHash } from 'node:crypto';

const decode = (value) =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');

export function extractSitemapPosts(xml, { startMarker, endMarker, publicBaseUrl }) {
  const start = xml.indexOf(startMarker);
  const end = xml.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('sitemap blog markers are missing or out of order');
  }

  const posts = new Map();
  const locs = xml.slice(start + startMarker.length, end).matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi);
  for (const match of locs) {
    const source = new URL(decode(match[1]));
    const url = new URL(publicBaseUrl);
    url.pathname = source.pathname;
    url.search = source.search;
    url.hash = '';
    posts.set(source.pathname, { externalId: source.pathname, url: url.toString() });
  }
  if (posts.size === 0) throw new Error('sitemap blog section contains no URLs');
  return [...posts.values()];
}

function attributes(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map((match) => [match[1].toLowerCase(), decode(match[2])]),
  );
}

function metaContent(html, name) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if ((attrs.property ?? attrs.name)?.toLowerCase() === name) return attrs.content?.trim() || '';
  }
  return '';
}

// BusinessOS grounds drafting in `title + excerpt` and then requires every
// source_quote to be a verbatim substring of it, 5-500 characters, 1-8 quotes
// per channel. A meta description is SEO-capped near 155 characters, which is
// far less than that constraint assumes: measured across eight live posts,
// title + og:description ran 38-226 characters, and a 38-character grounding
// cannot yield four distinct quotes for four channels at all. Drafting then
// fails quietly -- the ingest succeeds and no card is ever posted.
//
// So the readable article body goes in too. BusinessOS allows 64 KB of task
// input; this bound keeps the prompt small enough for local inference while
// leaving ample quotable text.
export const MAX_ARTICLE_TEXT_CHARS = 6000;

// Elements whose text is never part of the article and would poison quotes.
const NON_CONTENT = /<(script|style|noscript|template|svg|nav|header|footer|form|aside|iframe|title)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK_BOUNDARY = /<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre)\s*>|<br\b[^>]*>/gi;

export function extractArticleText(html, limit = MAX_ARTICLE_TEXT_CHARS) {
  // Tag name is a poor signal: on a real Feather post the only <article>
  // element wraps the hero image and contains no prose at all, so preferring it
  // yielded an empty excerpt. Clean every plausible container and keep whichever
  // actually carries the most text.
  const candidates = [
    ...[...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((match) => match[1]),
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1],
    html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1],
    html,
  ].filter(Boolean);

  let best = '';
  for (const candidate of candidates) {
    const text = cleanText(candidate);
    if (text.length > best.length) best = text;
  }

  if (best.length <= limit) return best;
  // Truncate on a sentence, then a word, so no quote spans a cut mid-token.
  const window = best.slice(0, limit);
  const sentence = window.lastIndexOf('. ');
  if (sentence > limit * 0.6) return window.slice(0, sentence + 1);
  const word = window.lastIndexOf(' ');
  return (word > 0 ? window.slice(0, word) : window).trim();
}

function cleanText(fragment) {
  return decode(
    fragment
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(NON_CONTENT, ' ')
      // Keep a separator at block edges so adjacent words do not fuse into a
      // token that appears nowhere in the rendered article.
      .replace(BLOCK_BOUNDARY, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\r\f\v\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    // Navigation is repeated verbatim in the header and footer of these pages
    // and is not marked up as <nav>, so tag stripping cannot reach it. Dropping
    // repeated lines removes it without guessing at site structure.
    .filter((line, index, lines) => line !== '' && lines.indexOf(line) === index)
    .join('\n')
    .trim();
}

export function slugTitle(url) {
  const slug = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  const words = slug.replace(/\.[a-z0-9]+$/i, '').split(/[-_]+/).filter(Boolean);
  return words.map((word, i) => (i === 0 ? word[0].toUpperCase() + word.slice(1) : word)).join(' ');
}

export function extractPageMetadata(html, url) {
  const elementText = (name) =>
    decode((html.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1] ?? '').replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
  const description = metaContent(html, 'og:description') || metaContent(html, 'description');
  const article = extractArticleText(html);
  // Some Feather posts publish without any SEO title metadata; fall back to the
  // article heading, then to the URL slug. The slug is only acceptable when the
  // page carries prose to draft from; an empty shell has nothing to ground on.
  const title =
    metaContent(html, 'og:title') ||
    elementText('title') ||
    elementText('h1') ||
    (article && url ? slugTitle(url) : '');
  if (!title) throw new Error('published page has no title, <title>, <h1>, or article text');
  // The description is a human-written summary and often the most quotable
  // sentence on the page, so it stays even when the body is available.
  const excerpt = [description, article].filter(Boolean).join('\n\n');
  return { title, excerpt, imageCandidates: imageCandidates(html, url) };
}

// Instagram targets cannot be approved without a public image and drafting
// never sets one, so the article's own artwork is what keeps a proposal
// approvable without manual work.
//
// og:image is the usual source and works on every article checked. Callers
// still resolve the list against the network first, because sending an
// unfetchable URL is worse than sending none: Buffer re-hosts the asset, so a
// dead link fails during delivery instead of visibly blocking approval. The
// rendered artwork is kept as a fallback for pages without usable metadata.
//
// og:image is often the untouched camera original, though. Feather published a
// 6000px JPEG and Buffer rejected the Instagram post at delivery ("Image width
// (6000px) exceeds the 5,000px maximum for Instagram"). Where the page itself
// serves a resized copy through a srcset, that copy goes first. A copy that is
// format-negotiated is still converted by resolveImageUrl, but from the
// smaller file.
export function imageCandidates(html, pageUrl) {
  const seen = new Set();
  const out = [];
  const add = (value) => {
    const url = (value ?? '').trim();
    if (!url.startsWith('https://') || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };

  const imgTags = (fragment) => [...fragment.matchAll(/<img\b[^>]*>/gi)].map((tag) => attributes(tag[0]));
  const sized = new Map();
  for (const attrs of imgTags(html)) {
    const variant = srcsetVariant(attrs.srcset, pageUrl);
    if (variant && !sized.has(variant.original)) sized.set(variant.original, variant.url);
  }
  const addSized = (value) => {
    add(sized.get((value ?? '').trim()));
    add(value);
  };

  addSized(metaContent(html, 'og:image'));
  addSized(metaContent(html, 'twitter:image'));

  // Then the rendered article artwork, largest variant first: Buffer re-hosts
  // the asset, so a thumbnail would be a permanent downgrade.
  const scope =
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html;
  const rendered = [];
  for (const attrs of imgTags(scope)) {
    const variant = srcsetVariant(attrs.srcset, pageUrl);
    if (variant) rendered.push(variant.url);
    const src = attrs.src ?? '';
    if (src.startsWith('https://')) rendered.push(src);
  }
  const rank = (url) => (/_small$/.test(url) ? 2 : /_medium$/.test(url) ? 1 : 0);
  for (const url of rendered.sort((a, b) => rank(a) - rank(b))) add(url);

  return out.slice(0, 6);
}

// Buffer rejects Instagram images over 5000px wide. 1920 leaves wide margin,
// is above anything Instagram displays, and keeps the file comfortably small.
export const MAX_IMAGE_DIMENSION = 1920;
// Instagram's file size limit.
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// Formats Instagram accepts as-is; anything else is converted to JPEG.
const DIRECT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
// Enough to reach the size header past a large EXIF/XMP block.
const IMAGE_HEAD_BYTES = 512 * 1024;

/**
 * The largest srcset entry no wider than MAX_IMAGE_DIMENSION, with the image
 * it is a copy of. Next.js `/_next/image?url=<original>&w=<n>` entries name
 * their original, which is how an og:image is matched to its resized copy.
 */
export function srcsetVariant(srcset, pageUrl) {
  let best = null;
  for (const entry of (srcset ?? '').split(/,\s+/)) {
    const [raw, descriptor] = entry.trim().split(/\s+/);
    const width = Number.parseInt(descriptor?.match(/^(\d+)w$/)?.[1] ?? '', 10);
    if (!raw || !(width <= MAX_IMAGE_DIMENSION) || (best && best.width >= width)) continue;
    let url;
    try {
      url = new URL(raw, pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    best = { url: url.toString(), width, original: url.searchParams.get('url') ?? url.toString() };
  }
  return best && { url: best.url, original: best.original };
}

/** A public resizing proxy's JPEG copy of `url`, at most MAX_IMAGE_DIMENSION on a side. */
export function resizedImageUrl(url) {
  const proxy = new URL('https://images.weserv.nl/');
  proxy.searchParams.set('url', url);
  proxy.searchParams.set('w', String(MAX_IMAGE_DIMENSION));
  proxy.searchParams.set('h', String(MAX_IMAGE_DIMENSION));
  proxy.searchParams.set('fit', 'inside');
  proxy.searchParams.set('we', '');
  proxy.searchParams.set('output', 'jpg');
  proxy.searchParams.set('q', '85');
  return proxy.toString();
}

/** Pixel size from a JPEG, PNG, GIF, or WebP header, or null if it is not there. */
export function imageDimensions(bytes) {
  const b = bytes;
  const u16be = (i) => (b[i] << 8) | b[i + 1];
  const u16le = (i) => b[i] | (b[i + 1] << 8);
  const u24le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const ascii = (i, n) => String.fromCharCode(...b.subarray(i, i + n));

  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG') {
    return { width: u32be(16), height: u32be(20) };
  }
  if (b.length >= 10 && ascii(0, 3) === 'GIF') {
    return { width: u16le(6), height: u16le(8) };
  }
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: u24le(24) + 1, height: u24le(27) + 1 };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      // SOF0-SOF15 carry the frame size; C4, C8, and CC are other tables.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: u16be(i + 7), height: u16be(i + 5) };
      }
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}

// Ask the way a browser does. Image servers negotiate on Accept: Next.js
// /_next/image answers this with WebP, which Instagram refuses, while a bare
// request gets JPEG. Buffer's own fetch is not documented, so check against the
// answer a modern client gets rather than the friendliest one.
const BROWSER_IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';

// Fetch only as much of the body as the size header needs, then let go.
async function inspectImage(url, fetchImpl, signal) {
  const timeout = AbortSignal.timeout(20000);
  const response = await fetchImpl(url, {
    headers: { accept: BROWSER_IMAGE_ACCEPT },
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    return null;
  }
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const length = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (!type.startsWith('image/')) {
    await response.body?.cancel?.().catch(() => {});
    return null;
  }
  let head = new Uint8Array(0);
  let dimensions = null;
  const reader = response.body?.getReader();
  try {
    while (reader && head.length < IMAGE_HEAD_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const joined = new Uint8Array(head.length + value.length);
      joined.set(head);
      joined.set(value, head.length);
      head = joined;
      dimensions = imageDimensions(head);
      if (dimensions) break;
    }
  } finally {
    await reader?.cancel().catch(() => {});
  }
  return { type, length: Number.isFinite(length) ? length : null, dimensions };
}

function postableAsIs({ type, length, dimensions }) {
  return (
    DIRECT_IMAGE_TYPES.has(type) &&
    dimensions !== null &&
    Math.max(dimensions.width, dimensions.height) <= MAX_IMAGE_DIMENSION &&
    (length === null || length <= MAX_IMAGE_BYTES)
  );
}

/**
 * First candidate the network agrees is an image, or '' if none are. An image
 * Instagram would reject for size or format, or whose size cannot be read,
 * comes back as a resized JPEG copy through the proxy instead, once the proxy
 * has shown it can serve one. `signal` bounds the whole resolution, for
 * callers with a deadline of their own.
 */
export async function resolveImageUrl(candidates, fetchImpl = fetch, { signal } = {}) {
  for (const url of candidates ?? []) {
    if (signal?.aborted) break;
    try {
      const image = await inspectImage(url, fetchImpl, signal);
      if (!image) continue;
      if (postableAsIs(image)) return url;
      const resized = resizedImageUrl(url);
      const copy = await inspectImage(resized, fetchImpl, signal);
      if (copy && postableAsIs(copy)) return resized;
    } catch {
      // An unreachable candidate is simply not usable; try the next.
    }
  }
  return '';
}

export function planSitemapChanges(posts, seenPaths) {
  if (seenPaths === null) {
    return { baselinePaths: posts.map((post) => post.externalId), newPosts: [] };
  }
  const seen = new Set(seenPaths);
  return { baselinePaths: null, newPosts: posts.filter((post) => !seen.has(post.externalId)) };
}

export function sitemapIdempotencyKey(externalId) {
  return `sitemap-ingest:${createHash('sha256').update(externalId).digest('hex')}`;
}

export async function fetchText(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}
