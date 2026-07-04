const UNAVAILABLE_PRICE = 'Preço indisponível';
const UNAVAILABLE_DESCRIPTION = 'Descrição indisponível.';
const REQUEST_TIMEOUT = 9000;

export async function extractItemMetadata(url) {
  const normalizedUrl = normalizeUrl(url);
  const marketplace = detectMarketplace(normalizedUrl);
  const fallback = buildFallbackMetadata(normalizedUrl, marketplace);
  const candidates = [fallback];

  const cloudCandidate = await fetchCloudScraper(normalizedUrl);
  if (cloudCandidate) {
    candidates.push(cloudCandidate);
  }

  const apiCandidate = await fetchMarketplaceApi(normalizedUrl, marketplace);
  if (apiCandidate) {
    candidates.push(apiCandidate);
  }

  const documents = await fetchReadableDocuments(normalizedUrl);
  documents.forEach((document) => {
    const parsed = document.kind === 'html'
      ? parseHtmlMetadata(document.text)
      : parseMarkdownMetadata(document.text);

    if (parsed) {
      candidates.push(parsed);
    }
  });

  const merged = mergeCandidates(candidates, fallback);

  return {
    title: merged.title || 'Item sem título',
    description: merged.description || UNAVAILABLE_DESCRIPTION,
    imageUrl: merged.imageUrl || '',
    price: merged.price || UNAVAILABLE_PRICE,
  };
}

function normalizeUrl(url) {
  const trimmedUrl = String(url || '').trim();

  if (!trimmedUrl) {
    throw new Error('Informe uma URL válida.');
  }

  try {
    return new URL(trimmedUrl).toString();
  } catch {
    return new URL(`https://${trimmedUrl}`).toString();
  }
}

function detectMarketplace(url) {
  const hostname = safeHostname(url);

  if (hostname.includes('mercadolivre.com') || hostname.includes('mercadolibre.com')) {
    return 'mercadolivre';
  }

  if (hostname.includes('shopee.')) {
    return 'shopee';
  }

  if (hostname.includes('tiktok.com')) {
    return 'tiktok';
  }

  return 'generic';
}

async function fetchMarketplaceApi(url, marketplace) {
  try {
    if (marketplace === 'mercadolivre') {
      return await fetchMercadoLivreApi(url);
    }

    if (marketplace === 'shopee') {
      return await fetchShopeeApi(url);
    }
  } catch {
    return null;
  }

  return null;
}

async function fetchCloudScraper(url) {
  const scraperUrl = getCloudScraperUrl();

  if (!scraperUrl) {
    return null;
  }

  try {
    const response = await fetchWithTimeout(scraperUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url }),
      timeout: 15000,
    });

    if (!response.ok) {
      return null;
    }

    const json = await response.json();
    return json?.metadata ? cleanCandidate(json.metadata) : null;
  } catch {
    return null;
  }
}

function getCloudScraperUrl() {
  return import.meta.env.VITE_SCRAPER_FUNCTION_URL || '';
}

async function fetchMercadoLivreApi(url) {
  const itemId = extractMercadoLivreItemId(url);

  if (!itemId) {
    return null;
  }

  const headers = { accept: 'application/json' };

  const item = await fetchJson(`https://api.mercadolibre.com/items/${itemId}`, { headers });

  if (!item?.title) {
    return null;
  }

  const description = await fetchJson(`https://api.mercadolibre.com/items/${itemId}/description`, { headers })
    .catch(() => null);

  return {
    title: item.title,
    description: description?.plain_text || item.subtitle || '',
    imageUrl: item.thumbnail || item.pictures?.[0]?.secure_url || item.pictures?.[0]?.url || '',
    price: formatMarketplacePrice(item.price, item.currency_id),
  };
}

async function fetchShopeeApi(url) {
  const ids = extractShopeeIds(url);

  if (!ids) {
    return null;
  }

  const endpoints = [
    `https://shopee.com.br/api/v4/pdp/get_pc?shop_id=${ids.shopId}&item_id=${ids.itemId}`,
    `https://shopee.com.br/api/v4/item/get?shopid=${ids.shopId}&itemid=${ids.itemId}`,
  ];

  for (const endpoint of endpoints) {
    const json = await fetchJson(endpoint).catch(() => null);
    const item = json?.data?.item || json?.data || json?.item;
    const title = item?.title || item?.name || json?.data?.name;

    if (!title) {
      continue;
    }

    return {
      title,
      description: item?.description || json?.data?.description || '',
      imageUrl: resolveShopeeImage(item?.image || item?.images?.[0] || json?.data?.image),
      price: formatMarketplacePrice(resolveShopeePrice(item), 'BRL'),
    };
  }

  return null;
}

async function fetchReadableDocuments(url) {
  const encodedUrl = encodeURIComponent(url);
  const documentRequests = [
    {
      kind: 'markdown',
      url: `https://r.jina.ai/http://${encodedUrl}`,
      timeout: 9000,
    },
    {
      kind: 'html',
      url: `https://r.jina.ai/http://${encodedUrl}`,
      headers: { 'x-return-format': 'html' },
      timeout: 9000,
    },
    {
      kind: 'html',
      url: `https://api.allorigins.win/raw?url=${encodedUrl}`,
      timeout: 4500,
    },
  ];

  const results = await Promise.allSettled(
    documentRequests.map(async (request) => {
      const text = await fetchText(request.url, {
        headers: request.headers,
        timeout: request.timeout,
      });
      return {
        kind: request.kind,
        text,
      };
    }),
  );

  return results
    .filter((result) => result.status === 'fulfilled' && result.value.text)
    .map((result) => result.value);
}

function parseHtmlMetadata(html) {
  if (!html || isBlockedDocument(html)) {
    return null;
  }

  const jsonLd = parseJsonLdMetadata(html);
  const meta = parseMetaMetadata(html);
  const title = meta.title || decodeHtml(getTagContent(html, 'title'));
  const price = meta.price || jsonLd.price || findPrice(html);
  const description = meta.description || jsonLd.description || findDescriptionFromText(stripHtml(html));
  const imageUrl = meta.imageUrl || jsonLd.imageUrl || '';

  return cleanCandidate({
    title: meta.title || jsonLd.title || title,
    description,
    imageUrl,
    price,
  });
}

function parseMarkdownMetadata(markdown) {
  if (!markdown || isBlockedDocument(markdown)) {
    return null;
  }

  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const title = extractLineValue(markdown, 'Title') || '';
  const description = findDescriptionFromText(
    lines
      .filter((line) => !line.startsWith('Title:') && !line.startsWith('URL Source:'))
      .join('\n'),
  );
  const imageUrl = findMarkdownImage(markdown);

  return cleanCandidate({
    title,
    description,
    imageUrl,
    price: extractLineValue(markdown, 'Price') || findPrice(markdown),
  });
}

function parseJsonLdMetadata(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];

  for (const block of blocks) {
    const rawJson = decodeHtml(block[1]).trim();
    const parsed = safeJsonParse(rawJson);
    const product = findProductNode(parsed);

    if (!product) {
      continue;
    }

    const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    const image = Array.isArray(product.image) ? product.image[0] : product.image;

    return cleanCandidate({
      title: product.name,
      description: product.description,
      imageUrl: image?.url || image,
      price: formatMarketplacePrice(
        offer?.price || offer?.lowPrice || offer?.highPrice || product.price,
        offer?.priceCurrency || product.priceCurrency,
      ),
    });
  }

  return {};
}

function parseMetaMetadata(html) {
  const title = getMetaContent(html, [
    'og:title',
    'twitter:title',
    'title',
  ]);
  const description = getMetaContent(html, [
    'og:description',
    'twitter:description',
    'description',
  ]);
  const imageUrl = getMetaContent(html, [
    'og:image:secure_url',
    'og:image',
    'twitter:image',
  ]);
  const rawPrice = getMetaContent(html, [
    'product:price:amount',
    'price:amount',
    'og:price:amount',
    'twitter:data1',
  ]);
  const currency = getMetaContent(html, [
    'product:price:currency',
    'price:currency',
    'og:price:currency',
  ]);

  return cleanCandidate({
    title,
    description,
    imageUrl,
    price: findPrice(rawPrice) || formatMarketplacePrice(rawPrice, currency),
  });
}

function buildFallbackMetadata(url, marketplace) {
  const slugTitle = extractTitleFromUrl(url);
  const marketplaceName = {
    mercadolivre: 'Mercado Livre',
    shopee: 'Shopee',
    tiktok: 'TikTok Shop',
    generic: 'link informado',
  }[marketplace];

  return {
    title: slugTitle || 'Item sem título',
    description: slugTitle ? `${slugTitle} - ${marketplaceName}` : UNAVAILABLE_DESCRIPTION,
    imageUrl: '',
    price: '',
  };
}

function mergeCandidates(candidates, fallback) {
  return candidates.reduce((merged, candidate) => {
    const clean = cleanCandidate(candidate);

    return {
      title: pickBestText(merged.title, clean.title, fallback.title),
      description: pickBestText(merged.description, clean.description, fallback.description),
      imageUrl: isUsefulImage(merged.imageUrl) ? merged.imageUrl : clean.imageUrl || merged.imageUrl,
      price: isUsefulPrice(merged.price) ? merged.price : clean.price || merged.price,
    };
  }, fallback);
}

function cleanCandidate(candidate = {}) {
  return {
    title: cleanText(candidate.title),
    description: cleanText(candidate.description),
    imageUrl: cleanImageUrl(candidate.imageUrl),
    price: cleanPrice(candidate.price),
  };
}

function pickBestText(current, next, fallback) {
  if (isUsefulText(current) && current !== fallback) {
    return current;
  }

  if (isUsefulText(next)) {
    return next;
  }

  return current || next || '';
}

function isUsefulText(value) {
  const text = cleanText(value);
  const lower = text.toLowerCase();

  return Boolean(
    text
    && !['mercado libre', 'mercado livre', 'shopee brasil', 'security check'].includes(lower)
    && !lower.includes('página indisponível')
    && !lower.includes('verify to continue')
    && !lower.includes('acesse sua conta'),
  );
}

function isBlockedDocument(text) {
  const lower = text.toLowerCase();
  return [
    'suspicious-traffic',
    'account-verification',
    'verify to continue',
    'drag the puzzle piece',
    'página indisponível',
    'acesse sua conta',
    'negative_traffic',
  ].some((phrase) => lower.includes(phrase));
}

function extractMercadoLivreItemId(url) {
  const normalized = decodeURIComponent(url);
  const matches = [
    normalized.match(/\/(MLB)-?(\d{7,})/i),
    normalized.match(/[?&]item_id=(MLB)-?(\d{7,})/i),
  ];
  const match = matches.find(Boolean);

  return match ? `${match[1].toUpperCase()}${match[2]}` : '';
}

function extractShopeeIds(url) {
  const decodedUrl = decodeURIComponent(url);
  const match = decodedUrl.match(/(?:-|\/)i\.(\d+)\.(\d+)/i)
    || decodedUrl.match(/\/product\/(\d+)\/(\d+)/i);

  return match
    ? {
        shopId: match[1],
        itemId: match[2],
      }
    : null;
}

function extractTitleFromUrl(url) {
  const parsedUrl = new URL(url);
  const decodedPath = decodeURIComponent(parsedUrl.pathname);
  const segments = decodedPath.split('/').filter(Boolean);
  const productSegment = segments.find((segment) => (
    segment
    && !/^p$/i.test(segment)
    && !/^product$/i.test(segment)
    && !/^shop$/i.test(segment)
    && !/^MLB-?\d+$/i.test(segment)
    && !/^i\.\d+\.\d+$/i.test(segment)
  ));

  const source = productSegment || segments.at(-1) || parsedUrl.hostname;

  return cleanText(
    source
      .replace(/^MLB-?\d+-?/i, '')
      .replace(/-i\.\d+\.\d+.*$/i, '')
      .replace(/_JM$/i, '')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[-_+]+/g, ' '),
  );
}

function findProductNode(value) {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map(findProductNode).find(Boolean) || null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  const type = Array.isArray(value['@type']) ? value['@type'].join(' ') : value['@type'];

  if (String(type || '').toLowerCase().includes('product')) {
    return value;
  }

  return findProductNode(value['@graph'])
    || findProductNode(value.mainEntity)
    || findProductNode(value.itemListElement);
}

function getMetaContent(html, names) {
  for (const name of names) {
    const escapedName = escapeRegExp(name);
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${escapedName}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["']${escapedName}["'][^>]*>`, 'i'),
    ];

    const match = patterns.map((pattern) => html.match(pattern)).find(Boolean);

    if (match?.[1]) {
      return decodeHtml(match[1]);
    }
  }

  return '';
}

function getTagContent(html, tagName) {
  const match = html.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match?.[1] || '';
}

function extractLineValue(text, label) {
  const match = text.match(new RegExp(`^${escapeRegExp(label)}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() || '';
}

function findMarkdownImage(markdown) {
  const images = [...markdown.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter(isUsefulImage);

  return images[0] || '';
}

function findDescriptionFromText(text) {
  const lines = stripHtml(text)
    .split('\n')
    .map((line) => cleanText(line))
    .filter((line) => isUsefulText(line) && !isTechnicalLine(line) && line.length > 24 && !findPrice(line));

  return lines[0] || '';
}

function findPrice(text) {
  const source = String(text || '');
  const currencyMatch = source.match(/R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?|R\$\s?\d+(?:,\d{2})?/i);

  if (currencyMatch) {
    return cleanPrice(currencyMatch[0]);
  }

  const jsonPriceMatch = source.match(/["'](?:price|salePrice|currentPrice|priceAmount)["']\s*:\s*["']?(\d+(?:[.,]\d{1,2})?)["']?/i);
  return jsonPriceMatch ? cleanPrice(jsonPriceMatch[1]) : '';
}

function cleanPrice(price) {
  const text = cleanText(price);

  if (!text || !isUsefulPrice(text)) {
    return '';
  }

  if (/^R\$/i.test(text)) {
    return text.replace(/\s+/g, ' ');
  }

  if (/^\d+(?:[.,]\d{1,2})?$/.test(text)) {
    return formatMarketplacePrice(text, 'BRL');
  }

  return text;
}

function isUsefulPrice(price) {
  const text = cleanText(price).toLowerCase();
  return Boolean(text && !text.includes('indisponível') && !text.includes('undefined') && !text.includes('null'));
}

function formatMarketplacePrice(value, currency = 'BRL') {
  if (value === undefined || value === null || value === '') {
    return '';
  }

  const numberValue = typeof value === 'number'
    ? value
    : parsePriceNumber(value);

  if (!Number.isFinite(numberValue)) {
    return cleanPrice(value);
  }

  if (String(currency || '').toUpperCase() === 'BRL') {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(numberValue);
  }

  return `${currency || ''} ${numberValue.toFixed(2)}`.trim();
}

function parsePriceNumber(value) {
  const cleaned = String(value)
    .trim()
    .replace(/\s/g, '')
    .replace(/[^\d.,-]/g, '');

  if (!cleaned) {
    return Number.NaN;
  }

  const commaIndex = cleaned.lastIndexOf(',');
  const dotIndex = cleaned.lastIndexOf('.');
  let normalized = cleaned;

  if (commaIndex > -1 && dotIndex > -1) {
    const decimalSeparator = commaIndex > dotIndex ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    normalized = cleaned
      .replace(new RegExp(`\\${thousandsSeparator}`, 'g'), '')
      .replace(decimalSeparator, '.');
  } else if (commaIndex > -1) {
    normalized = normalizeSingleSeparator(cleaned, ',');
  } else if (dotIndex > -1) {
    normalized = normalizeSingleSeparator(cleaned, '.');
  }

  return Number(normalized);
}

function normalizeSingleSeparator(value, separator) {
  const parts = value.split(separator);
  const lastPart = parts.at(-1) || '';

  if (parts.length === 2 && lastPart.length > 0 && lastPart.length <= 2) {
    return value.replace(separator, '.');
  }

  if (parts.length > 1) {
    return parts.join('');
  }

  return value;
}

function resolveShopeePrice(item) {
  const rawPrice = item?.price || item?.price_min || item?.price_before_discount || item?.price_max;

  if (!rawPrice) {
    return '';
  }

  const numericPrice = Number(rawPrice);
  return Number.isFinite(numericPrice) && numericPrice > 100000
    ? numericPrice / 100000
    : numericPrice;
}

function resolveShopeeImage(image) {
  if (!image) {
    return '';
  }

  if (/^https?:\/\//i.test(image)) {
    return image;
  }

  return `https://down-br.img.susercontent.com/file/${image}`;
}

function cleanImageUrl(url) {
  const text = cleanText(url);
  return isUsefulImage(text) ? text : '';
}

function isUsefulImage(url) {
  const text = cleanText(url).toLowerCase();
  return Boolean(
    /^https?:\/\//i.test(text)
    && !text.includes('logo')
    && !text.includes('favicon')
    && !text.includes('vlibras')
    && !text.includes('.svg'),
  );
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<[^>]+>/g, '\n');
}

function cleanText(value) {
  return decodeHtml(String(value || ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function safeJsonParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options);

  if (!response.ok) {
    return null;
  }

  return response.json();
}

async function fetchText(url, options = {}) {
  const response = await fetchWithTimeout(url, options);

  if (!response.ok) {
    return '';
  }

  return response.text();
}

async function fetchWithTimeout(url, options = {}) {
  const { timeout = REQUEST_TIMEOUT, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isTechnicalLine(value) {
  const lower = cleanText(value).toLowerCase();

  return [
    'published time:',
    'warning:',
    'url source:',
    'markdown content:',
    'this is a cached snapshot',
    'consider explicitly specify a timeout',
    'skip to content',
    'accessibility feedback',
    'privacy policy',
    'terms of use',
    'usamos cookies',
    'central de privacidade',
    'aceitar cookies',
    'configurar cookies',
    'pronto! suas preferências',
    'ocorreu um erro',
    'trace-id:',
  ].some((phrase) => lower.includes(phrase));
}
