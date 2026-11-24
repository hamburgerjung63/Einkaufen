import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

// ALDI

const aldiUrl = 'https://www.aldi-nord.de/angebote.html';
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function extractOffers(html) {
  const script = html.match(/<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  const page = JSON.parse(script?.[1] || '{}').props?.pageProps;
  const data = JSON.parse(page?.apiData || '[]');
  const result = data.find(([key, entry]) => key === 'OFFER_GET' && entry.req?.week === 'current')?.[1].res;
  if (!result?.algoliaDataMap || !Array.isArray(result.categories)) {
    throw new Error('Die ALDI-Angebotsseite enthält keine lesbaren Wochenangebote.');
  }
  const offers = new Map();
  for (const action of result.categories) {
    for (const category of action.content || []) {
      for (const id of category.productIds || []) {
        const product = result.algoliaDataMap[id];
        if (!product?.name || product.isRecall) continue;
        for (const promotion of product.promotionPrices || []) {
          const { validFromLocalDate: start, validUntilLocalDate: end, priceValue } = promotion;
          if (!datePattern.test(start) || !datePattern.test(end) || end < start ||
              start > action.endDate || end < action.startDate || !Number.isFinite(priceValue) || priceValue <= 0) continue;
          const price = Math.round(priceValue * 100);
          const key = [id, start, end, price].join(':');
          if (offers.has(key)) continue;
          const slug = product.productSlug;
          const url = typeof slug === 'string' && /^[a-z0-9-]+$/.test(slug)
            ? new URL('/produkt/' + slug + '.html', aldiUrl).href : aldiUrl;
          offers.set(key, {
            key, name: product.name.trim(), unit: product.salesUnit || '', price, start, end,
            category: category.title || 'Weitere Angebote', url,
            deposit: product.isDepositProduct && Number.isFinite(product.depositValue)
              ? Math.round(product.depositValue * 100) : 0
          });
        }
      }
    }
  }
  if (!offers.size) throw new Error('Die ALDI-Angebotsseite enthält keine gültigen Aktionspreise.');
  return [...offers.values()];
}

// EDEKA

const edekaMarkets = Object.freeze({
  ef: '217045',
  eh: '210477',
  en: '217028'
});

const edekaEntities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decodeEdeka(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code) => {
    if (!code.startsWith('#')) return edekaEntities[code.toLowerCase()] ?? entity;
    const hex = code[1].toLowerCase() === 'x';
    const number = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
    return number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  });
}

function edekaDate(text) {
  return text.split('.').reverse().join('-');
}

function edekaCents(amount) {
  return amount ? Math.round(Number(amount.replace(',', '.')) * 100) : null;
}

function extractEdekaOffers(html, sourceUrl) {
  const week = html.match(/Gültig vom\s*<strong>(\d{2}\.\d{2}\.\d{4})<\/strong>\s*bis zum\s*<strong>(\d{2}\.\d{2}\.\d{4})<\/strong>/);
  if (!week) throw new Error('EDEKA-Angebotszeitraum fehlt.');
  const start = edekaDate(week[1]);
  const weekEnd = edekaDate(week[2]);
  const offers = new Map();
  const cards = html.matchAll(/<article\b[^>]*\bdata-tracking-event="(\[&quot;show_promotion&quot;,[^"]+)"[^>]*>([\s\S]*?)<\/article>/g);
  for (const [, tracking, card] of cards) {
    let metadata;
    try { [, metadata] = JSON.parse(decodeEdeka(tracking)); } catch { continue; }
    const name = metadata?.promotion_item_name?.trim();
    const id = metadata?.promotion_id;
    const fragment = card.match(/href="(#angebot-[a-f0-9-]+)"/i)?.[1];
    if (!name || !id || !fragment) continue;

    const standard = card.match(/>\s*(?:Festpreis|Rabattierter Preis) von\s+([\d]+[.,]\d{2})\s*€/i);
    const app = card.match(/>\s*App[- ]Preis von\s+([\d]+[.,]\d{2})\s*€/i);
    const price = edekaCents(standard?.[1]);
    const appPrice = edekaCents(app?.[1]);
    if (!price && !appPrice) continue;

    const expiration = metadata.promotion_item_expiration_date?.slice(0, 10);
    const end = /^\d{4}-\d{2}-\d{2}$/.test(expiration) && expiration < weekEnd ? expiration : weekEnd;
    if (end < start) continue;

    const unit = card.match(/<p\b[^>]*class="[^"]*\bline-clamp-2\b[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] || '';
    const key = [id, start, end].join(':');
    if (!offers.has(key)) offers.set(key, {
      key, name, unit: decodeEdeka(unit.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(),
      price, appPrice, start, end, category: metadata.promotion_item_category || 'Weitere Angebote',
      url: new URL(fragment, sourceUrl).href
    });
  }
  if (!offers.size) throw new Error('EDEKA-Angebotspreise fehlen.');
  return [...offers.values()];
}

// LIDL

const lidlIndex = 'https://www.lidl.de/c/online-prospekte/s10005610';
const lidlFlyerApi = 'https://endpoints.leaflets.schwarz/v4/flyer';
let lidlCache;
let lidlPending;

function lidlFlyerLinks(html, today) {
  const current = new Map();
  const links = html.matchAll(/href="(https:\/\/www\.lidl\.de\/l\/prospekte\/(aktionsprospekt-(\d\d)-(\d\d)-(\d{4})-(\d\d)-(\d\d)-(\d{4})-[a-z0-9]+)\/[^"]*)"/gi);
  for (const [, href, id, day, month, year, lastDay, lastMonth, lastYear] of links) {
    const start = year + '-' + month + '-' + day;
    const end = lastYear + '-' + lastMonth + '-' + lastDay;
    if (start <= today && today <= end) current.set(id, href.replaceAll('&amp;', '&'));
  }
  return [...current.entries()].slice(0, 6);
}

function lidlImage(url) {
  if (typeof url === 'string' && /^https:\/\/imgproxy\.leaflets\.schwarz\//.test(url)) return url;
  return '';
}

function lidlSpot(link, key) {
  const { left, top, width, height } = link;
  if (![left, top, width, height].every(Number.isFinite) || left < 0 || top < 0 ||
      width <= 0 || height <= 0 || left + width > 100.5 || top + height > 100.5) return null;
  return { key, left, top, width, height };
}

function extractLidlFlyer(data, id, url, today) {
  const flyer = data.flyer;
  const start = flyer?.offerStartDate, end = flyer?.offerEndDate;
  if (!start || !end || start > today || end < today || !Array.isArray(flyer.pages)) return null;
  const offers = new Map();
  const pages = [];
  for (const page of flyer.pages) {
    const image = lidlImage(page.zoom) || lidlImage(page.image);
    const spots = [];
    if (!Number.isInteger(page.number) || page.number < 1) continue;
    for (const link of page.links || []) {
      if (link.displayType !== 'product' || typeof link.id !== 'string') continue;
      const product = flyer.products?.[link.id];
      const name = product?.title?.trim();
      const price = Math.round(Number(product?.price) * 100);
      if (!name || !Number.isSafeInteger(price) || price <= 0 || (product.currencyText && product.currencyText !== 'EUR')) continue;
      const key = id + ':' + link.id;
      if (!offers.has(key)) offers.set(key, {
        key, name, price, unit: '', start, end, url, flyer: id, page: page.number,
        category: product.categoryPrimary?.split('/')[1] || 'Weitere Angebote',
        unverifiedStorePrice: true
      });
      const spot = lidlSpot(link, key);
      if (spot) spots.push(spot);
    }
    pages.push({ number: page.number, image, width: page.width, height: page.height, spots });
  }
  return { brochure: { id, url, start, end, pages }, offers: [...offers.values()] };
}

async function currentLidlOffers(today) {
  const now = Date.now();
  if (lidlCache?.day === today && lidlCache.until > now) return lidlCache.payload;
  if (lidlPending) return lidlPending;
  lidlPending = loadLidlOffers(today, now);
  try { return await lidlPending; }
  finally { lidlPending = undefined; }
}

async function loadLidlOffers(today, now) {
  try {
    const signal = AbortSignal.timeout(9000);
    const response = await fetch(lidlIndex, { signal });
    if (!response.ok) throw new Error('Lidl-Prospektübersicht HTTP ' + response.status);
    const links = lidlFlyerLinks(await response.text(), today);
    const results = await Promise.allSettled(links.map(async ([id, url]) => {
      const endpoint = new URL(lidlFlyerApi);
      endpoint.searchParams.set('flyer_identifier', id);
      const reply = await fetch(endpoint, { signal, headers: { Accept: 'application/json' } });
      if (!reply.ok) throw new Error('Lidl-Prospekt HTTP ' + reply.status);
      return extractLidlFlyer(await reply.json(), id, url, today);
    }));
    const available = results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
    if (!available.length) throw new Error('Keine aktuellen Lidl-Prospekte abrufbar.');
    const complete = results.length === available.length;
    const payload = {
      source: complete ? 'live' : 'partial', checked: new Date(now).toISOString(),
      offers: available.flatMap(entry => entry.offers), brochures: available.map(entry => entry.brochure)
    };
    lidlCache = { day: today, until: now + (complete ? 15 : 2) * 60_000, payload };
    return payload;
  } catch (error) {
    console.warn('Lidl-Prospekte konnten nicht geladen werden.', error.message);
    const saved = lidlCache?.payload;
    return {
      source: 'snapshot', checked: saved?.checked || null,
      offers: (saved?.offers || []).filter(offer => offer.end >= today),
      brochures: (saved?.brochures || []).filter(flyer => flyer.end >= today)
    };
  }
}

// REWE

const reweMarkets = Object.freeze({
  rn: ['540548', 'norderstedt', 'ulzburger-str-332'],
  rh: ['540551', 'henstedt-ulzburg', 'wilstedter-str-63']
});
const reweOrigins = 'https://www.rewe.de';
const reweCatalogCache = new Map();
const reweCategories = {
  'obst-und-gemuese': 'Obst & Gemüse', backshop: 'Backwaren', brot: 'Brot & Backwaren',
  kuehlung: 'Kühlung', tiefkuehl: 'Tiefkühl', fruehstueck: 'Frühstück',
  'kochen-und-backen': 'Kochen & Backen', 'schnell-und-einfach': 'Schnell & einfach',
  'suesses-und-salziges': 'Süßes & Salziges', 'fleisch-und-wurst': 'Fleisch & Wurst',
  'wein-und-spirituosen': 'Wein & Spirituosen', 'alkoholfreie-getraenke': 'Alkoholfreie Getränke',
  'freizeit-und-mode': 'Freizeit & Mode', 'tierbedarf': 'Tierbedarf',
  bier: 'Bier', haushalt: 'Haushalt', drogerie: 'Drogerie', bedientheke: 'Bedientheke',
  'markt-topangebote': 'Top-Angebote im Markt', 'thema-der-woche': 'Thema der Woche',
  'rewe-bonus-produkte': 'REWE Bonus', tier: 'Tierbedarf', tiefpreis: 'Tiefpreise'
};

function reweDecode(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code) => {
    if (!code.startsWith('#')) return {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '}[code.toLowerCase()] || entity;
    const hex = code[1].toLowerCase() === 'x';
    const number = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
    return number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  });
}

function reweAttribute(tag, name) {
  return tag.match(new RegExp('\\s' + name + '="([^"]*)"'))?.[1];
}

function reweWeek(week) {
  const match = /^(\d{4})\/(\d{1,2})$/.exec(week);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 53) return null;
  const january = new Date(Date.UTC(Number(match[1]), 0, 4));
  const monday = new Date(january);
  monday.setUTCDate(january.getUTCDate() - (january.getUTCDay() + 6) % 7 + (Number(match[2]) - 1) * 7);
  const saturday = new Date(monday);
  saturday.setUTCDate(monday.getUTCDate() + 5);
  return { start:monday.toISOString().slice(0,10), end:saturday.toISOString().slice(0,10) };
}

function reweCategory(key) {
  if (reweCategories[key]) return reweCategories[key];
  return key ? key.replaceAll('-', ' ').replace(/^./, letter => letter.toUpperCase()) : 'Angebots-Highlights';
}

function reweMoney(amount) {
  return amount ? Math.round(Number(amount.replaceAll('.', '').replace(',', '.')) * 100) : 0;
}

function reweMarketUrls(branch) {
  const [id, city, address] = reweMarkets[branch];
  return {
    id,
    url: reweOrigins + '/angebote/' + city + '/' + id + '/rewe-' + address + '/',
    marketUrl: reweOrigins + '/marktseite/' + city + '/' + id + '/rewe-markt-' + address + '/'
  };
}

function reweReferences(html, id, today) {
  const rows = new Map();
  for (const [tag] of html.matchAll(/<div\b[^>]*data-testid="sos-offer-span"[^>]*>/g)) {
    const nan = reweAttribute(tag, 'data-offer-nan'), week = reweAttribute(tag, 'data-offer-week');
    if (!/^\d+$/.test(nan || '') || reweAttribute(tag, 'data-offer-wwident') !== id || !week) continue;
    const period = reweWeek(week);
    if (!period || today < period.start || today > period.end) continue;
    const category = reweAttribute(tag, 'data-category') || '';
    if (!rows.has(nan)) rows.set(nan, { nan, week, category,
      crossOutPriceArrowStyle: reweAttribute(tag, 'data-cross-out-price-arrow-style') || 'false'
    });
  }
  return [...rows.values()];
}

function parseReweCard(markup, market, today, category = '') {
  const title = markup.match(/<a\b[^>]*data-testid="offer-title-link"[^>]*>/)?.[0];
  if (!title || reweAttribute(title, 'data-offer-wwident') !== market.id) return null;
  const name = reweDecode(reweAttribute(title, 'data-offer-title') || '').trim();
  const nan = reweAttribute(title, 'data-offer-nan');
  const week = reweAttribute(title, 'data-offer-week');
  const period = reweWeek(week);
  const number = '(\\d[\\d.]*,\\d{2})\\s*(?:&nbsp;|\\s)*€';
  const price = reweMoney(markup.match(new RegExp('class="cor-offer-price(?:__tag-price|-arrow__new)"[^>]*>\\s*' + number))?.[1]);
  if (!name || !nan || !period || today < period.start || today > period.end || price <= 0) return null;
  const additional = [...markup.matchAll(/<span\b[^>]*class="cor-offer-information__additional"[^>]*>([\s\S]*?)<\/span>/g)]
    .map(match => reweDecode(match[1].replace(/<[^>]*>/g, '')).trim());
  const description = additional.join(' ').replace(/^,\s*/, '').replace(/\s+,/g, ',');
  const depositMatch = description.match(new RegExp('(?:zzgl\\.?\\s*)?' + number + '\\s*Pfand', 'i'));
  const deposit = reweMoney(depositMatch?.[1]);
  const aria = reweDecode(reweAttribute(title, 'aria-label') || '');
  const bonus = reweMoney(aria.match(new RegExp('\\+\\s*' + number + '\\s*REWE Bonus', 'i'))?.[1]);
  const unit = (depositMatch ? description.replace(depositMatch[0], '').replace(/,\s*$/, '') : description).trim();
  return { key: 'rewe:' + week + ':' + nan, name, price, unit, deposit, bonus,
    ...period, weeklyOffer: true, category: reweCategory(category), url: market.url };
}

function rewePageCards(html, market, today) {
  return [...html.matchAll(/<article\b[^>]*\bclass="[^"]*cor-offer-renderer-tile\b[^"]*"[^>]*>[\s\S]*?<\/article>/g)]
    .map(([card]) => parseReweCard(card, market, today)).filter(Boolean);
}

function selectReweReferences(rows, limit) {
  const categories = new Map();
  for (const row of rows) {
    const group = categories.get(row.category) || [];
    if (!categories.has(row.category)) categories.set(row.category, group);
    group.push(row);
  }
  const selected = [];
  for (let offset = 0; selected.length < limit; offset++) {
    const before = selected.length;
    for (const group of categories.values()) {
      if (group[offset]) selected.push(group[offset]);
      if (selected.length === limit) break;
    }
    if (before === selected.length) break;
  }
  return selected;
}

function reweDetailRequest(rows, id) {
  return rows.map(({nan, week, crossOutPriceArrowStyle}) => ({
    id:nan, namespace:'cor', name:'offer-tile-by-nan',
    params:{ nan, wwIdent:id, week, showDuration:'auto', enableDetailDeeplink:'true', crossOutPriceArrowStyle }
  }));
}

async function reweHtml(url, signal) {
  try {
    const response = await fetch(url, { signal });
    if (response.ok) return await response.text();
  } catch {}
  return '';
}

async function reweArticleOffers(rows, market, today, signal) {
  const batches = [];
  for (let offset = 0; offset < rows.length; offset += 24) batches.push(rows.slice(offset, offset + 24));
  const results = await Promise.allSettled(batches.map(async batch => {
    const response = await fetch(reweOrigins + '/api/frontend-includes', {
      method:'POST', signal, headers:{Accept:'application/json', 'Content-Type':'application/json', 'Rd-Client-Href':market.url},
      body:JSON.stringify(reweDetailRequest(batch, market.id))
    });
    if (!response.ok) return [];
    const categories = new Map(batch.map(row => [row.nan, row.category]));
    const cards = await response.json();
    return cards.map(card => card.content ? parseReweCard(card.content, market, today, categories.get(card.id)) : null).filter(Boolean);
  }));
  return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}

function distinctReweOffers(offers) {
  return [...new Map(offers.map(offer => [offer.key, offer])).values()];
}

async function currentReweOffers(branch, today, snapshot) {
  const now = Date.now();
  const cache = reweCatalogCache.get(branch);
  if (cache?.day === today && cache.until > now) return cache.payload;
  const market = reweMarketUrls(branch);
  const signal = AbortSignal.timeout(8500);
  const [fullPage, highlightsPage] = await Promise.all([reweHtml(market.url, signal), reweHtml(market.marketUrl, signal)]);
  const highlights = rewePageCards(highlightsPage, market, today);
  const refs = reweReferences(fullPage, market.id, today);
  const details = refs.length ? await reweArticleOffers(selectReweReferences(refs, 120), market, today, signal) : [];
  const live = distinctReweOffers([...highlights, ...rewePageCards(fullPage, market, today), ...details]);
  const saved = (snapshot?.offers || []).filter(offer => offer.start <= today && offer.end >= today);
  const merged = distinctReweOffers([...saved, ...live]);
  const payload = {
    source: saved.length > live.length ? 'snapshot' : 'partial',
    checked: saved.length > live.length ? snapshot.checked : new Date(now).toISOString(),
    offers: merged, liveCount: live.length
  };
  reweCatalogCache.set(branch, { day:today, until:now + (merged.length ? 15 : 2) * 60_000, payload });
  return payload;
}

// Abruf von HTML-Angebotsseiten

const berlinDate = value => new Intl.DateTimeFormat('sv-SE', { timeZone:'Europe/Berlin' }).format(value);
const offerCache = new Map();

async function currentOffers(url, extract, fallback, source = 'live', timeout = 8500) {
  const now = Date.now();
  const today = berlinDate(new Date(now));
  const cache = offerCache.get(url);
  if (cache?.until > now && cache.day === today) return cache.payload;
  const signal = AbortSignal.timeout(timeout);
  let upstreamStatus;
  try {
    const response = await fetch(url, {
      signal,
      headers: { Accept: 'text/html', 'Accept-Language': 'de-DE,de;q=0.9' }
    });
    upstreamStatus = response.status;
    if (!response.ok) throw new Error('Angebotsseite HTTP ' + response.status);
    const offers = extract(await response.text(), url).filter(offer => offer.end >= today);
    if (!offers.length) throw new Error('Keine aktuellen Angebote.');
    const payload = { offers, source, checked: new Date(now).toISOString() };
    offerCache.set(url, { payload, day: today, until: now + 15 * 60_000 });
    return payload;
  } catch (error) {
    console.warn('Wochenangebote konnten nicht geladen werden.', new URL(url).pathname, error.message);
    const saved = cache?.payload || fallback || { offers: [], checked: null };
    const offers = saved.offers.filter(offer => offer.end >= today);
    return { ...saved, offers, source: 'snapshot', upstreamStatus: upstreamStatus || null };
  }
}



const project = new URL('./', import.meta.url);
const previousFile = new URL('.angebote-cache/angebote.json', project);
const bundledFile = new URL('angebote.json', project);
const output = new URL('dist/', project);
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());

async function readCatalogue(url) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function filterCurrent(catalogue) {
  return {
    ...catalogue,
    offers: (catalogue?.offers || []).filter(offer => offer.end >= today),
    brochures: (catalogue?.brochures || []).filter(flyer => flyer.end >= today)
  };
}

function selectPublished(previous, next) {
  const saved = filterCurrent(previous);
  const fresh = filterCurrent(next);
  if (!fresh.offers.length && !fresh.brochures.length) {
    return { ...saved, source: 'snapshot' };
  }
  if (!saved.offers.length && !saved.brochures.length) return fresh;
  if (saved.brochures.length && fresh.brochures.length && fresh.source === 'partial') {
    const brochures = [...new Map([...saved.brochures, ...fresh.brochures].map(flyer => [flyer.id, flyer])).values()];
    const offers = [...new Map([...saved.offers, ...fresh.offers].map(offer => [offer.key, offer])).values()];
    return { ...fresh, brochures, offers };
  }
  if (!saved.brochures.length && !fresh.brochures.length && fresh.source !== 'live') {
    const dates = new Set(fresh.offers.map(offer => offer.start));
    const retained = saved.offers.filter(offer => dates.has(offer.start));
    const offers = [...new Map([...retained, ...fresh.offers].map(offer => [offer.key, offer])).values()];
    if (offers.length > fresh.offers.length) {
      return { ...fresh, offers, checked: saved.checked || fresh.checked, source: 'snapshot' };
    }
  }
  return fresh;
}

const [initial, cache] = await Promise.all([readCatalogue(bundledFile), readCatalogue(previousFile)]);
const paths = [
  ['/api/aldi', () => currentOffers(aldiUrl, extractOffers)],
  ['/api/lidl', () => currentLidlOffers(today)],
  ...Object.keys(reweMarkets).map(branch => ['/api/rewe/' + branch, () => currentReweOffers(branch, today)]),
  ...Object.entries(edekaMarkets).map(([branch, id]) => ['/api/edeka/' + branch, async () => {
    const market = 'https://www.edeka.de/maerkte/' + id + '/';
    const full = await currentOffers(market + 'angebote/', extractEdekaOffers, undefined, 'live', 6000);
    return full.offers.length ? full : currentOffers(market, extractEdekaOffers, undefined, 'partial', 4000);
  }])
];

const snapshots = {};
for (const [path, load] of paths) {
  const previous = selectPublished(initial[path], cache[path]);
  let current;
  try {
    current = await load();
  } catch (error) {
    console.warn(path, error.message);
  }
  const published = selectPublished(previous, current);
  snapshots[path] = published;
  console.log(path, published.offers.length + ' Artikel', published.source);
}

await Promise.all([mkdir(output, { recursive: true }), mkdir(new URL('./', previousFile), { recursive: true })]);
const json = JSON.stringify(snapshots);
await Promise.all([
  copyFile(new URL('index.html', project), new URL('index.html', output)),
  copyFile(new URL('app-icon.png', project), new URL('app-icon.png', output)),
  writeFile(new URL('angebote.json', output), json + '\n'),
  writeFile(previousFile, json + '\n')
]);
