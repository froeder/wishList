const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const cheerio = require('cheerio');

const REGION = 'southamerica-east1';
const REQUEST_TIMEOUT = 12000;
const UNAVAILABLE_PRICE = 'Preço indisponível';
const UNAVAILABLE_DESCRIPTION = 'Descrição indisponível.';

exports.scrapeProduct = onRequest(
  {
    region: REGION,
    timeoutSeconds: 30,
    memory: '512MiB',
    invoker: 'public',
  },
  async (request, response) => {
    setCorsHeaders(response);

    if (request.method === 'OPTIONS') {
      response.status(204).send('');
      return;
    }

    if (!['GET', 'POST'].includes(request.method)) {
      response.status(405).json({ error: 'Método não permitido.' });
      return;
    }

    try {
      const productUrl = normalizeUrl(request.body?.url || request.query?.url);
      const metadata = await scrapeProduct(productUrl);

      response.status(200).json({
        ok: true,
        metadata,
      });
    } catch (error) {
      logger.warn('scrapeProduct failed', {
        message: error.message,
        url: request.body?.url || request.query?.url,
      });

      response.status(400).json({
        ok: false,
        error: error.message || 'Não foi possível capturar os dados do produto.',
      });
    }
  },
);

exports.mercadoLivreOAuthCallback = onRequest(
  {
    region: REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    invoker: 'public',
  },
  async (request, response) => {
    setCorsHeaders(response);

    if (request.method === 'OPTIONS') {
      response.status(204).send('');
      return;
    }

    const { code, state, error, error_description: errorDescription } = request.query;

    if (request.query.format === 'json') {
      response.status(error ? 400 : 200).json({
        ok: !error,
        code: code || null,
        state: state || null,
        error: error || null,
        errorDescription: errorDescription || null,
      });
      return;
    }

    response
      .status(error ? 400 : 200)
      .type('html')
      .send(renderMercadoLivreCallbackPage({
        code,
        state,
        error,
        errorDescription,
      }));
  },
);

async function scrapeProduct(url) {
  const marketplace = detectMarketplace(url);
  const fallback = buildFallbackMetadata(url, marketplace);
  const candidates = [fallback];

  const apiCandidate = await fetchMarketplaceApi(url, marketplace);
  if (apiCandidate) {
    candidates.push(apiCandidate);
  }

  const documents = await fetchDocuments(url);
  for (const document of documents) {
    const parsed = parseHtmlMetadata(document.text);
    if (parsed) {
      candidates.push(parsed);
    }
  }

  const merged = mergeCandidates(candidates, fallback);

  return {
    title: merged.title || 'Item sem título',
    description: merged.description || UNAVAILABLE_DESCRIPTION,
    imageUrl: merged.imageUrl || '',
    price: merged.price || UNAVAILABLE_PRICE,
    source: 'cloud-function',
  };
}

async function fetchMarketplaceApi(url, marketplace) {
  try {
    if (marketplace === 'mercadolivre') {
      return await fetchMercadoLivreApi(url);
    }

    if (marketplace === 'shopee') {
      return await fetchShopeeApi(url);
    }
  } catch (error) {
    logger.info('Marketplace API failed', { marketplace, message: error.message });
  }

  return null;
}

async function fetchMercadoLivreApi(url) {
  const { itemId, productId } = extractMercadoLivreIds(url);
  const headers = getMercadoLivreHeaders();

  if (itemId) {
    const item = await fetchJson(`https://api.mercadolibre.com/items/${itemId}`, { headers });

    if (!item?.title) {
      return null;
    }

    const description = await fetchJson(`https://api.mercadolibre.com/items/${itemId}/description`, { headers })
      .catch(() => null);

    return cleanCandidate({
      title: item.title,
      description: description?.plain_text || item.subtitle || '',
      imageUrl: item.secure_thumbnail || item.thumbnail || item.pictures?.[0]?.secure_url || item.pictures?.[0]?.url || '',
      price: formatMarketplacePrice(item.price, item.currency_id),
    });
  }

  if (!productId) {
    return null;
  }

  const product = await fetchJson(`https://api.mercadolibre.com/products/${productId}`, { headers });

  if (!product?.name && !product?.title) {
    return null;
  }

  const productItems = await fetchJson(`https://api.mercadolibre.com/products/${productId}/items`, { headers })
    .catch(() => null);
  const winningItem = product?.buy_box_winner
    || productItems?.results?.[0]
    || productItems?.[0]
    || null;
  const winningItemId = winningItem?.id || product?.buy_box_winner_id;
  const item = winningItemId
    ? await fetchJson(`https://api.mercadolibre.com/items/${winningItemId}`, { headers }).catch(() => null)
    : winningItem;

  const attributesDescription = Array.isArray(product.attributes)
    ? product.attributes
      .filter((attribute) => attribute.name && attribute.value_name)
      .slice(0, 5)
      .map((attribute) => `${attribute.name}: ${attribute.value_name}`)
      .join(' | ')
    : '';

  return cleanCandidate({
    title: product.name || product.title || item?.title,
    description: product.short_description?.content || product.description || attributesDescription || item?.subtitle || '',
    imageUrl: product.pictures?.[0]?.secure_url || product.pictures?.[0]?.url || item?.secure_thumbnail || item?.thumbnail || '',
    price: formatMarketplacePrice(item?.price || winningItem?.price, item?.currency_id || winningItem?.currency_id || 'BRL'),
  });
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
    const json = await fetchJson(endpoint, { headers: getJsonHeaders(url) }).catch(() => null);
    const item = json?.data?.item || json?.data || json?.item;
    const title = item?.title || item?.name || json?.data?.name;

    if (!title) {
      continue;
    }

    return cleanCandidate({
      title,
      description: item?.description || json?.data?.description || '',
      imageUrl: resolveShopeeImage(item?.image || item?.images?.[0] || json?.data?.image),
      price: formatMarketplacePrice(resolveShopeePrice(item), 'BRL'),
    });
  }

  return null;
}

async function fetchDocuments(url) {
  const requests = [
    {
      url,
      headers: getHtmlHeaders(url),
    },
    {
      url: `https://r.jina.ai/http://${encodeURIComponent(url)}`,
      headers: getHtmlHeaders(url),
    },
  ];

  const results = await Promise.allSettled(
    requests.map(async (request) => {
      const text = await fetchText(request.url, { headers: request.headers });
      return { text };
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

  const $ = cheerio.load(html);
  const jsonLd = parseJsonLdMetadata($);
  const meta = parseMetaMetadata($);
  const scriptData = parseEmbeddedScriptMetadata(html);
  $('script, style, noscript, svg').remove();
  $('br, p, div, h1, h2, h3, li').after('\n');
  const title = meta.title || jsonLd.title || scriptData.title || cleanText($('title').first().text());
  const description = meta.description || jsonLd.description || scriptData.description || findDescriptionFromText($('body').text());
  const imageUrl = meta.imageUrl || jsonLd.imageUrl || scriptData.imageUrl || '';
  const price = meta.price || jsonLd.price || scriptData.price || findPrice(html);

  return cleanCandidate({
    title,
    description,
    imageUrl,
    price,
  });
}

function parseJsonLdMetadata($) {
  const scripts = $('script[type="application/ld+json"]')
    .map((_, element) => $(element).text())
    .get();

  for (const script of scripts) {
    const parsed = safeJsonParse(script);
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

function parseMetaMetadata($) {
  const title = getMetaContent($, ['og:title', 'twitter:title', 'title']);
  const description = getMetaContent($, ['og:description', 'twitter:description', 'description']);
  const imageUrl = getMetaContent($, ['og:image:secure_url', 'og:image', 'twitter:image']);
  const rawPrice = getMetaContent($, [
    'product:price:amount',
    'price:amount',
    'og:price:amount',
    'twitter:data1',
  ]);
  const currency = getMetaContent($, [
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

function parseEmbeddedScriptMetadata(html) {
  const candidate = {};
  const snippets = [
    ...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi),
  ]
    .map((match) => match[1])
    .filter((script) => /price|product|description|image|title|name/i.test(script))
    .slice(0, 20);

  for (const script of snippets) {
    candidate.price ||= findPrice(script);
    candidate.title ||= findJsonLikeValue(script, ['title', 'name', 'productName']);
    candidate.description ||= findJsonLikeValue(script, ['description', 'shortDescription']);
    candidate.imageUrl ||= findJsonLikeValue(script, ['image', 'imageUrl', 'thumbnail', 'thumbnailUrl']);

    if (candidate.title && candidate.price) {
      break;
    }
  }

  return cleanCandidate(candidate);
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

function getMetaContent($, names) {
  for (const name of names) {
    const value = $(`meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`)
      .first()
      .attr('content');

    if (value) {
      return value;
    }
  }

  return '';
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
    || findProductNode(value.itemListElement)
    || null;
}

function findJsonLikeValue(source, keys) {
  for (const key of keys) {
    const match = source.match(new RegExp(`["']${escapeRegExp(key)}["']\\s*:\\s*["']([^"']{3,500})["']`, 'i'));

    if (match?.[1]) {
      return decodeEscapes(match[1]);
    }
  }

  return '';
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

function findDescriptionFromText(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => cleanText(line))
    .filter((line) => isUsefulText(line) && !isTechnicalLine(line) && line.length > 24 && !findPrice(line));

  return lines[0] || '';
}

function extractMercadoLivreIds(url) {
  const normalized = decodeURIComponent(url);
  const productMatch = normalized.match(/\/p\/(MLB)-?(\d{7,})/i);
  const itemMatch = productMatch ? null : normalized.match(/\/(MLB)-?(\d{7,})/i)
    || normalized.match(/[?&]item_id=(MLB)-?(\d{7,})/i);

  return {
    itemId: itemMatch ? `${itemMatch[1].toUpperCase()}${itemMatch[2]}` : '',
    productId: productMatch ? `${productMatch[1].toUpperCase()}${productMatch[2]}` : '',
  };
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

function detectMarketplace(url) {
  const hostname = new URL(url).hostname.toLowerCase();

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

function getHtmlHeaders(url) {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    referer: new URL(url).origin,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  };
}

function getJsonHeaders(url = 'https://www.google.com') {
  return {
    accept: 'application/json,text/plain,*/*',
    'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    referer: new URL(url).origin,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  };
}

function getMercadoLivreHeaders() {
  const headers = getJsonHeaders('https://www.mercadolivre.com.br');
  const token = getMercadoLivreToken();

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  return headers;
}

function getMercadoLivreToken() {
  return process.env.MERCADO_LIVRE_ACCESS_TOKEN || '';
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timeoutId);
  }
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
  const lower = String(text || '').toLowerCase();
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

function safeJsonParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function cleanText(value) {
  return decodeEscapes(String(value || ''))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEscapes(value) {
  return String(value || '')
    .replace(/\\u([\dA-F]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function setCorsHeaders(response) {
  response.set('Access-Control-Allow-Origin', '*');
  response.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.set('Access-Control-Allow-Headers', 'Content-Type');
}

function renderMercadoLivreCallbackPage({ code, state, error, errorDescription }) {
  const escapedCode = escapeHtml(code || '');
  const escapedState = escapeHtml(state || '');
  const escapedError = escapeHtml(error || '');
  const escapedErrorDescription = escapeHtml(errorDescription || '');

  if (error) {
    return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mercado Livre OAuth</title>
  <style>${callbackPageCss()}</style>
</head>
<body>
  <main>
    <p class="eyebrow">Mercado Livre</p>
    <h1>Autorizacao recusada</h1>
    <p>O Mercado Livre retornou um erro no processo de autorizacao.</p>
    <dl>
      <dt>Erro</dt>
      <dd>${escapedError}</dd>
      <dt>Detalhe</dt>
      <dd>${escapedErrorDescription || 'Sem detalhe informado.'}</dd>
    </dl>
  </main>
</body>
</html>`;
  }

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mercado Livre OAuth</title>
  <style>${callbackPageCss()}</style>
</head>
<body>
  <main>
    <p class="eyebrow">Mercado Livre</p>
    <h1>Callback criada</h1>
    <p>O Mercado Livre redirecionou para esta URL com sucesso.</p>
    <dl>
      <dt>Authorization code</dt>
      <dd><code>${escapedCode || 'Nenhum code recebido ainda.'}</code></dd>
      <dt>State</dt>
      <dd><code>${escapedState || 'Nenhum state recebido.'}</code></dd>
    </dl>
    <p class="muted">Este codigo expira rapido. O proximo passo e trocar esse code por tokens na Cloud Function.</p>
  </main>
</body>
</html>`;
}

function callbackPageCss() {
  return `
    :root { color: #172026; background: #f5f7fb; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; }
    main { width: min(100%, 680px); background: #fff; border: 1px solid #dbe4ea; border-radius: 8px; padding: 28px; box-shadow: 0 18px 50px rgba(23, 32, 38, 0.12); }
    h1 { margin: 6px 0 10px; line-height: 1.1; }
    p { color: #4d5d68; }
    dl { display: grid; gap: 8px; margin: 22px 0; }
    dt { color: #63717d; font-size: 0.78rem; font-weight: 800; text-transform: uppercase; }
    dd { margin: 0; padding: 12px; background: #f8fafc; border: 1px solid #dbe4ea; border-radius: 8px; overflow-wrap: anywhere; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .eyebrow { margin: 0; color: #b45309; font-size: 0.78rem; font-weight: 800; text-transform: uppercase; }
    .muted { color: #63717d; }
  `;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
