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

export function extractPageMetadata(html) {
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const title = metaContent(html, 'og:title') || decode(titleTag.replace(/<[^>]+>/g, '')).trim();
  if (!title) throw new Error('published page has no title');
  const excerpt = metaContent(html, 'og:description') || metaContent(html, 'description');
  return { title, excerpt };
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
