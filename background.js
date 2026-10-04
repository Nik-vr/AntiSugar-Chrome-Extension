// Background service worker:
//  - анализирует текст товара, присланный из открытой страницы (основной путь);
//  - хранит персистентный кэш результатов;
//  - резервно догружает страницу целиком (fetch → скрытая вкладка), если локального
//    текста не хватило (страница рендерится клиентом).
importScripts('defaults.js', 'analyzer.js', 'extractor.js', 'components.js');

const CACHE_LIMIT = 1500; // максимум товаров в кэше
const CACHE_KEY = 'asgCache';
const CACHE_FLUSH_MS = 2000; // как часто дописываем кэш на диск
const TAB_RENDER_WAIT = 900; // пауза после парсинга DOM в скрытой вкладке
const TAB_TIMEOUT = 30000;

let cache = new Map(); // url -> результат
let cacheDirty = false;
let cacheFlushTimer = null;
let settings = null;
let loaderBusy = false;

// --- настройки ---

async function loadSettings() {
  if (settings) return settings;
  settings = await chrome.storage.local.get(ASG_DEFAULTS);
  // Критерии изменились (новая версия): обновляем списки зон и фильтров
  // из актуального источника, сохраняя личные настройки пользователя.
  if (settings.cfgVersion !== ASG_CFG_VERSION) {
    const migration = {
      cfgVersion: ASG_CFG_VERSION,
      zones: ASG_DEFAULTS.zones,
      excludes: ASG_DEFAULTS.excludes,
      contextExcludes: ASG_DEFAULTS.contextExcludes,
      foodCategories: ASG_DEFAULTS.foodCategories
    };
    Object.assign(settings, migration);
    clearCache();
    chrome.storage.local.set(migration);
  }
  return settings;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  settings = null;
  if (changes.zones || changes.excludes || changes.contextExcludes) clearCache();
});

// --- кэш ---

function clearCache() {
  cache.clear();
  cacheDirty = false;
  if (cacheFlushTimer) {
    clearTimeout(cacheFlushTimer);
    cacheFlushTimer = null;
  }
  chrome.storage.local.remove(CACHE_KEY);
}

async function cacheWarm() {
  if (cache.size) return;
  try {
    const s = await chrome.storage.local.get(CACHE_KEY);
    if (s[CACHE_KEY]) {
      for (const [k, v] of Object.entries(s[CACHE_KEY])) cache.set(k, v);
    }
  } catch (e) { /* ignore */ }
}

function flushCache() {
  cacheFlushTimer = null;
  if (!cacheDirty) return;
  cacheDirty = false;
  try {
    chrome.storage.local
      .set({ [CACHE_KEY]: Object.fromEntries(cache.entries()) })
      .catch(() => {});
  } catch (e) { /* ignore */ }
}

function cacheSet(url, result) {
  cache.set(url, result);
  if (cache.size > CACHE_LIMIT) {
    let oldest = cache.keys().next().value;
    while (cache.size > CACHE_LIMIT && oldest !== undefined) {
      cache.delete(oldest);
      oldest = cache.keys().next().value;
    }
  }
  if (!cacheDirty) {
    cacheDirty = true;
    if (cacheFlushTimer) clearTimeout(cacheFlushTimer);
    cacheFlushTimer = setTimeout(flushCache, CACHE_FLUSH_MS);
  }
}

chrome.runtime.onSuspend.addListener(() => {
  if (cacheDirty) {
    try {
      chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(cache.entries()) });
    } catch (e) { /* ignore */ }
  }
});

// --- выбор источника текста: точность важнее полноты ---

function pickSource(product, s) {
  const comp = asgCollapse(product.composition);
  const desc = asgCollapse(product.description);
  const page = asgCollapse(product.pageText);
  const max = s.maxDescChars || 20000;

  if (s.preferComposition !== false && comp.length >= 12) {
    return { text: comp.slice(0, 2000), source: 'состав' };
  }
  if (desc.length >= 60) {
    return { text: desc.slice(0, max), source: 'описание' };
  }
  return { text: page.slice(0, max), source: 'страница' };
}

// --- анализ уже полученного текста ---

async function analyzeProduct(product) {
  const s = await loadSettings();
  await cacheWarm();

  const url = product.url;
  if (!product.force) {
    const hit = cache.get(url);
    // записи без поля authoritative — из прежних версий, им не доверяем
    if (hit && typeof hit.authoritative === 'boolean') return { ...hit, cached: true };
  }

  const base = { url, status: 'ok', fetchedAt: Date.now() };
  const topCategory = product.topCategory || null;

  // 1) верхняя категория: не продукты — не анализируем.
  // Проверяем только если категория определена надёжно (крошки/JSON-LD):
  // иначе лучше ошибиться в сторону «проанализировать».
  if (
    product.topCategoryReliable !== false &&
    !asgIsFoodCategory(topCategory, s.foodCategories)
  ) {
    const result = {
      ...base,
      skipped: true,
      reason: topCategory,
      source: null,
      textLength: 0,
      zone: 'green',
      zones: { red: [], orange: [], yellow: [], green: [] },
      matches: [],
      marked: false,
      snippet: ''
    };
    await cacheSet(url, result);
    return { ...result, cached: false };
  }

  // 2) зоны риска по выбранному источнику
  const pick = pickSource(product, s);
  // «complete» — выборка достоверна: нашли настоящий блок «Состав»/«Описание»,
  // либо страницу догрузили целиком, либо текст устоялся (final от content script).
  const complete = !!product.assumeComplete || !!product.confident || !!product.final;
// «authoritative» — можно утверждать «опасных веществ не найдено».
// Только настоящий завершённый блок «Состав». Проверка строгая (=== true):
// если флаг потерялся (старая вкладка после обновления расширения, запись
// из старого кэша), зелёный флаг показываться не должен.
const authoritative = pick.source === 'состав' && product.authoritative === true;
  const res = asgAnalyze(pick.text, s);
  const firstMatch =
    (res.zones[res.zone] && res.zones[res.zone][0]) ||
    (res.zones.green && res.zones.green[0]) ||
    null;

  const result = {
    ...base,
    skipped: false,
    topCategory,
    source: pick.source,
    complete,
    authoritative,
    textLength: pick.text.length,
    zone: res.zone,
    zones: res.zones,
    matches: res.matches,
    marked: res.marked,
    snippet: firstMatch ? asgSnippet(pick.text, firstMatch.keyword) : ''
  };
// Кэшируем только результаты с настоящим блоком «Состав»: они стабильны.
  // Предварительные вердикты по обрывочному тексту не кэшируем, иначе
  // ошибочный цвет «закрепился» бы и повторялся на каждой следующей загрузке.
  if (complete && authoritative) await cacheSet(url, result);
  return { ...result, cached: false };
}

// --- резервная догрузка страницы ---

async function fetchHtml(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      credentials: 'include',
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function htmlFromTab(url) {
  return new Promise((resolve, reject) => {
    let tabId = null;
    let settled = false;
    const finish = (err, html) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (typeof tabId === 'number') {
        try {
          chrome.tabs.onUpdated.removeListener(onUpdated);
        } catch (e) { /* ignore */ }
        chrome.tabs.remove(tabId).catch(() => {});
      }
      if (err) reject(err);
      else resolve(html);
    };
    const onUpdated = (tid, info) => {
      if (tid !== tabId || info.status !== 'interactive') return;
      setTimeout(async () => {
        try {
          const [inj] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => document.documentElement.outerHTML
          });
          const html = (inj && inj.result) || '';
          if (html.length < 500) finish(new Error('Страница не загрузилась'));
          else finish(null, html);
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)));
        }
      }, TAB_RENDER_WAIT);
    };
    const timer = setTimeout(
      () => finish(new Error('Таймаут загрузки вкладки')),
      TAB_TIMEOUT
    );
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs
      .create({ url, active: false })
      .then((tab) => {
        tabId = tab.id;
      })
      .catch((e) => finish(new Error('Не удалось открыть вкладку: ' + e)));
  });
}

async function loadPageHtml(url, s) {
  if ((s.fetchStrategy || 'auto') !== 'tab') {
    try {
      const html = await fetchHtml(url, 8000);
      if (html && html.length > 500) return html;
    } catch (e) { /* антибот или сбой — идём во вкладку */ }
    if (s.fetchStrategy === 'fetch') throw new Error('Страница недоступна по запросу');
  }
  return htmlFromTab(url);
}

// Медленный путь: загрузить страницу самим и проанализировать.
// Используется как fallback и в разделе «Проверка» настроек.
async function analyzeUrl(url) {
  const s = await loadSettings();
  await cacheWarm();

  const hit = cache.get(url);
  if (hit) return { ...hit, cached: true };
  if (loaderBusy) return { url, status: 'error', error: 'Страница уже загружается' };

  loaderBusy = true;
  try {
    const html = await loadPageHtml(url, s);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const data = asgExtractFromDoc(doc, s);
    return await analyzeProduct({
      ...data,
      url,
      force: false,
      assumeComplete: true // страница загружена целиком
    });
  } catch (e) {
    return {
      url,
      status: 'error',
      marked: false,
      matches: [],
      error: String((e && e.message) || e),
      fetchedAt: Date.now()
    };
  } finally {
    loaderBusy = false;
  }
}

// --- сообщения ---

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.type === 'analyze' && msg.product && msg.product.url) {
        sendResponse(await analyzeProduct(msg.product));
      } else if (msg && msg.type === 'analyze-url' && msg.url) {
        sendResponse(await analyzeUrl(msg.url));
      } else if (msg && msg.type === 'get-settings') {
        sendResponse(await loadSettings());
      } else if (msg && msg.type === 'clear-cache') {
        clearCache();
        sendResponse({ ok: true, size: 0 });
      } else if (msg && msg.type === 'cache-info') {
        await cacheWarm();
        sendResponse({ ok: true, size: cache.size });
      } else {
        sendResponse({ status: 'error', error: 'Неизвестный запрос' });
      }
    } catch (e) {
      sendResponse({ status: 'error', error: String(e) });
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get({});
  if (existing.enabled === undefined) chrome.storage.local.set(ASG_DEFAULTS);
});
