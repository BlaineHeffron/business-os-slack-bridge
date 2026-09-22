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
  return { title, excerpt, imageCandidates: imageCandidates(html) };
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
export function imageCandidates(html) {
  const seen = new Set();
  const out = [];
  const add = (value) => {
    const url = (value ?? '').trim();
    if (!url.startsWith('https://') || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };

  add(metaContent(html, 'og:image'));
  add(metaContent(html, 'twitter:image'));

  // Then the rendered article artwork, largest variant first: Buffer re-hosts
  // the asset, so a thumbnail would be a permanent downgrade.
  const scope =
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html;
  const rendered = [];
  for (const tag of scope.matchAll(/<img\b[^>]*>/gi)) {
    const src = attributes(tag[0]).src ?? '';
    if (src.startsWith('https://')) rendered.push(src);
  }
  const rank = (url) => (/_small$/.test(url) ? 2 : /_medium$/.test(url) ? 1 : 0);
  for (const url of rendered.sort((a, b) => rank(a) - rank(b))) add(url);

  return out.slice(0, 6);
}

/** First candidate the network agrees is an image, or '' if none are. */
export async function resolveImageUrl(candidates, fetchImpl = fetch) {
  for (const url of candidates ?? []) {
    try {
      // HEAD keeps this cheap: the artwork runs to hundreds of KB and only the
      // content type matters. Bodies are cancelled rather than left undrained,
      // which otherwise holds connections open for the whole poll.
      const response = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
      await response.body?.cancel?.().catch(() => {});
      if (!response.ok) continue;
      if ((response.headers.get('content-type') ?? '').startsWith('image/')) return url;
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
