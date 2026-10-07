// Background service worker:
//  - анализирует текст товара, присланный из открытой страницы (основной путь);
//  - хранит персистентный кэш результатов;
//  - резервно догружает страницу целиком (fetch → скрытая вкладка), если локального
//    текста не хватило (страница рендерится клиентом).
importScripts('defaults.js', 'analyzer.js', 'extractor.js', 'components.js');

const CACHE_LIMIT = 1500; // максимум товаров в кэше
const CACHE_KEY = 'asgCache';
const CACHE_FLUSH_MS = 1000; // как часто дописываем кэш на диск
const TAB_RENDER_WAIT = 900; // пауза после парсинга DOM в скрытой вкладке
const TAB_TIMEOUT = 30000;
const MIN_PAGE_HTML = 500; // короче — страница не загрузилась

// Ключи настроек, от которых зависит результат анализа. Изменение любого из них
// обесценивает кэш вердиктов (и требует пересчёта на открытых вкладках).
const CACHE_INVALIDATING_KEYS = [
  'zones',
  'excludes',
  'contextExcludes',
  'selectors',
  'foodCategories',
  'nonFoodCategories',
  'preferComposition',
  'maxDescChars'
];

let cache = new Map(); // url -> результат
let cacheDirty = false;
let cacheFlushTimer = null;
let cacheError = ''; // последняя ошибка записи кэша — видна в диагностике
let settings = null;
let loaderBusy = false;

// --- настройки ---

// Обновление критериев не должно стирать правки пользователя: значения из
// ASG_DEFAULTS добавляются к сохранённым, повторы убираются.
// Обратная сторона: ключевое слово, убранное автором из списка, у пользователя
// останется — это осознанный выбор в пользу сохранности его правок.
function asgMergeList(base, user) {
  const out = [];
  const seen = new Set();
  for (const src of [base, user]) {
    if (!Array.isArray(src)) continue;
    for (const v of src) {
      const s = String(v == null ? '' : v).trim();
      if (!s) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

function asgMergeZones(base, user) {
  const out = {};
  for (const z of ASG_ZONE_ORDER) {
    out[z] = asgMergeList((base || {})[z], (user || {})[z]);
  }
  return out;
}

async function loadSettings() {
  if (settings) return settings;
  try {
    settings = await chrome.storage.local.get(ASG_DEFAULTS);
  } catch (e) {
    // без настроек анализ не имеет смысла, но падать нельзя: работаем на
    // значениях по умолчанию и говорим об этом в диагностике
    cacheError = 'чтение настроек: ' + e;
    settings = Object.assign({}, ASG_DEFAULTS);
    return settings;
  }
  if (settings.cfgVersion !== ASG_CFG_VERSION) {
    const migration = {
      cfgVersion: ASG_CFG_VERSION,
      zones: asgMergeZones(ASG_DEFAULTS.zones, settings.zones),
      excludes: asgMergeList(ASG_DEFAULTS.excludes, settings.excludes),
      contextExcludes: asgMergeList(ASG_DEFAULTS.contextExcludes, settings.contextExcludes),
      foodCategories: asgMergeList(ASG_DEFAULTS.foodCategories, settings.foodCategories),
      nonFoodCategories: asgMergeList(
        ASG_DEFAULTS.nonFoodCategories,
        settings.nonFoodCategories
      )
    };
    Object.assign(settings, migration);
    clearCache();
    chrome.storage.local.set(migration);
  }
  return settings;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // Кэш пишем мы сами, раз в секунду. Реагировать на эту же запись нельзя:
  // сброс settings заставлял бы заново читать настройки на каждый flush,
  // а в content script это запускало полный пересчёт страницы (цикл).
  const keys = Object.keys(changes);
  if (keys.length === 1 && keys[0] === CACHE_KEY) return;
  settings = null;
  if (CACHE_INVALIDATING_KEYS.some((k) => k in changes)) clearCache();
});

// --- кэш ---

function clearCache() {
  cache.clear();
  cacheDirty = false;
  if (cacheFlushTimer) {
    clearTimeout(cacheFlushTimer);
    cacheFlushTimer = null;
  }
  cacheError = '';
  chrome.storage.local.remove(CACHE_KEY).catch(() => {});
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
      .then(() => {
        cacheError = '';
      })
      .catch((e) => {
        // квота storage.local или сбой записи: молчать нельзя, иначе кэш
        // просто перестанет сохраняться и это никто не заметит
        cacheError = 'запись кэша: ' + e;
      });
  } catch (e) {
    cacheError = 'запись кэша: ' + e;
  }
}

// Значимая часть записи кэша: по ней решаем, изменился ли вердикт.
// fetchedAt и порядок ключей намеренно не участвуют: иначе каждое
// переизвлечение страницы считалось бы изменением и будило слушателей storage.
function cacheSignature(r) {
  if (!r) return '';
  return JSON.stringify([
    r.status,
    r.skipped,
    r.skipKind || null,
    r.reason || null,
    r.source || null,
    r.authoritative,
    r.zone,
    r.textLength,
    r.preview || null,
    r.zones
  ]);
}

// Что кладём на диск. Описание рисков не храним: оно берётся из components.js
// по названию компонента при показе, а в записи это треть объёма (при лимите
// 1500 товаров кэш весил бы 4,4 МБ и целиком переписывался каждую секунду).
function cacheRecord(result) {
  const stripMatches = (list) =>
    (list || []).map((m) => ({ keyword: m.keyword, count: m.count, word: m.word, name: m.name }));
  const out = {
    url: result.url,
    status: result.status,
    skipped: !!result.skipped,
    source: result.source || null,
    authoritative: result.authoritative === true,
    zone: result.zone || 'green',
    textLength: result.textLength || 0,
    preview: result.preview || '',
    topCategory: result.topCategory || null
  };
  if (result.skipped) {
    out.skipKind = result.skipKind || null;
    out.reason = result.reason || null;
    return out;
  }
  out.zones = {};
  for (const z of ASG_ZONE_ORDER) {
    const ms = (result.zones && result.zones[z]) || [];
    if (ms.length) out.zones[z] = stripMatches(ms);
  }
  out.matches = [];
  for (const z of ASG_ZONE_ORDER) {
    for (const m of (result.matches || []).filter((x) => x.zone === z)) {
      out.matches.push({
        zone: z,
        keyword: m.keyword,
        count: m.count,
        word: m.word || m.keyword,
        name: m.name || m.keyword
      });
    }
  }
  return out;
}

// Описание риска в кэше не хранится (см. cacheRecord) — восстанавливаем его из
// components.js при чтении, иначе панель на странице показывала бы голое
// название компонента без пояснения.
function withRisk(result) {
  if (!result || (!result.matches && !result.zones)) return result;
  const out = Object.assign({}, result);
  const attach = (m) => {
    if (!m || !m.keyword || m.risk) return m;
    const info = typeof asgComponentInfo === 'function' ? asgComponentInfo(m.keyword) : null;
    return info && info.risk ? Object.assign({}, m, { risk: info.risk }) : m;
  };
  if (Array.isArray(result.matches)) out.matches = result.matches.map(attach);
  if (result.zones) {
    const zones = {};
    for (const z of ASG_ZONE_ORDER) {
      if (result.zones[z]) zones[z] = result.zones[z].map(attach);
    }
    out.zones = zones;
  }
  return out;
}

// На диск пишем только то, что нужно для показа, а не весь результат.
function cacheSet(url, result) {
  const record = cacheRecord(result);
  const prev = cache.get(url);
  // Подпись считаем от записи кэша, а не от полного результата: в записи нет
  // описаний рисков, и сравнение разных форм всегда считало бы вердикт новым
  if (prev && cacheSignature(prev) === cacheSignature(record)) {
    // вердикт тот же — не пишем на диск и не поднимаем onChanged
    return;
  }
  cache.set(url, record);
  if (cache.size > CACHE_LIMIT) {
    // Вытесняем самые старые записи, кроме только что добавленной.
    // Обход конечный: удаление текущего ключа во время итерации по keys()
    // безопасно, а прежний while с keys().next() мог зациклиться навсегда,
    // если первой в Map лежит именно новая запись.
    for (const key of cache.keys()) {
      if (cache.size <= CACHE_LIMIT) break;
      if (key === url) continue;
      cache.delete(key);
    }
  }
  if (!cacheDirty) {
    cacheDirty = true;
    if (cacheFlushTimer) clearTimeout(cacheFlushTimer);
    cacheFlushTimer = setTimeout(flushCache, CACHE_FLUSH_MS);
  }
}

// MV3 выгружает service worker асинхронно: запись в onSuspend не гарантирована.
// Поэтому окно потери ограничено CACHE_FLUSH_MS, а здесь мы лишь пробуем
// дописать то, что ещё не попало на диск.
chrome.runtime.onSuspend.addListener(() => {
  if (!cacheDirty) return;
  cacheDirty = false;
  if (cacheFlushTimer) {
    clearTimeout(cacheFlushTimer);
    cacheFlushTimer = null;
  }
  try {
    chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(cache.entries()) });
  } catch (e) { /* ignore */ }
});

// --- выбор источника текста: точность важнее полноты ---

// Нашлось ли хоть что-то в разборе: нужно, чтобы решить, еда ли перед нами,
// когда раздел не опознан.
function asgHasAnyMatch(res) {
  if (!res || !res.zones) return false;
  for (const z of ASG_ZONE_ORDER) {
    if ((res.zones[z] || []).length) return true;
  }
  return false;
}

function pickSource(product, s) {
  const comp = asgCollapse(product.composition);
  const desc = asgCollapse(product.description);
  const page = asgCollapse(product.pageText);
  const max = s.maxDescChars || 20000;

  if (s.preferComposition !== false && comp.length >= ASG_MIN_COMPOSITION) {
    // 4000, а не 2000: состав-ассорти с несколькими вкусами длиннее.
    // Порог длины — общий с извлекателем (ASG_MIN_COMPOSITION): если он больше,
    // достоверный короткий состав («сахар, мёд») уходил в описание и вердикт
    // показывался как «состав не подтверждён».
    return { text: comp.slice(0, 4000), source: 'состав' };
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
    if (hit && typeof hit.authoritative === 'boolean') return { ...withRisk(hit), cached: true };
  }

  const base = { url, status: 'ok', fetchedAt: Date.now() };
  const topCategory = product.topCategory || null;

  // «Не продукты» — оценка не проводится. Запись кэшируется: вердикт стабилен.
  const skipped = (skipKind, reason) => ({
    ...base,
    skipped: true,
    skipKind,
    reason,
    source: null,
    textLength: 0,
    zone: 'green',
    zones: { red: [], orange: [], yellow: [], green: [] },
    matches: [],
    marked: false,
    // поле обязательно: по нему решается, годится ли запись из кэша
    // (без него кэшированные «не продукты» никогда не читались)
    authoritative: false,
    snippet: ''
  });

  // 1) Непищевой состав: «Состав материала» (одежда, текстиль). Признак прямо
  // со страницы и потому надёжнее категории, которая определяется не всегда:
  // без него карточка перчаток оценивалась как продукт.
  if (product.materialComposition === true) {
    const result = skipped('material', 'состав материала');
    cacheSet(url, result);
    return { ...result, cached: false };
  }

// 2) Верхняя категория: не еда — не оцениваем. Решение принимаем, только
  // если категория определена надёжно (крошки/JSON-LD): иначе лучше ошибиться
  // в сторону «проанализировать».
  //
  // Раздел вне обоих списков («Спорт и отдых», куда Ozon складывает
  // батончики и протеиновые смеси) такими правилами не ловится: решение по
  // нему принимает содержимое страницы — см. foodDecision ниже.
  const categoryDecision = asgCategoryDecision(
    topCategory,
    s.foodCategories,
    s.nonFoodCategories
  );
  if (product.topCategoryReliable !== false && categoryDecision === 'notFood') {
    const result = skipped('category', topCategory);
    cacheSet(url, result);
    return { ...result, cached: false };
  }

  // 3) зоны риска по выбранному источнику
  const pick = pickSource(product, s);
  // «complete» — выборка достоверна: нашли настоящий блок «Состав»/«Описание»,
  // либо страницу догрузили целиком, либо текст устоялся (final от content script).
  const complete = !!product.assumeComplete || !!product.confident || !!product.final;
  const res = asgAnalyze(pick.text, s);

  // Решение по неопознанному разделу — содержимое страницы. Достоверный блок
  // «Состав», в котором нашлись сахар или подсластители, доказывает, что перед
  // нами еда: батончики и протеиновые смеси на Ozon лежат в «Спорт и отдых»,
  // а косметика и одежда подсластителей в составе не содержат.
  const foodByPage = !!(product.compositionTrusted === true && asgHasAnyMatch(res));
  if (
    product.topCategoryReliable !== false &&
    categoryDecision !== 'food' &&
    !foodByPage
  ) {
    const result = skipped('category', topCategory || 'раздел не опознан');
    cacheSet(url, result);
    return { ...result, cached: false };
  }
  const foodDecision = foodByPage ? 'food' : categoryDecision;

  // Источник — настоящий блок «Состава» (подпись, селектор, контейнер,
  // состояние страницы), даже если перечень не прошёл проверку завершённости.
  const trustedComposition = pick.source === 'состав' && product.compositionTrusted === true;
  // Перечень полный: завершённый и похожий на список ингредиентов.
  // Проверка строгая (=== true): если флаг потерялся (старая вкладка после
  // обновления расширения, запись из старого кэша), полным он не считается.
  const completeList = pick.source === 'состав' && product.authoritative === true;
  // «authoritative» — вердикт можно показывать цветом.
  // Предупреждение (красный/оранжевый/жёлтый) показываем и по неполному
  // перечню: найденное вещество в составе действительно есть, а обрезка могла
  // только что-то скрыть — молчать об этом хуже, чем показать предупреждение.
  // Зелёный флаг («опасных веществ не найдено») требует полного перечня:
  // иначе обрезанный состав давал бы ложную безопасность.
  const authoritative = trustedComposition && (completeList || res.zone !== 'green');
  const firstMatch =
    (res.zones[res.zone] && res.zones[res.zone][0]) ||
    (res.zones.green && res.zones.green[0]) ||
    null;

  const result = {
    ...base,
    skipped: false,
    topCategory,
    // решение о том, еда ли товар: 'food' — по разделу или по составу,
    // 'unknown' — раздел не опознан, но состав пищевой (видно в диагностике)
    foodDecision,
    source: pick.source,
    complete,
    authoritative,
    // Диагностика: из какого источника взято и полон ли перечень
    trustedComposition,
    completeList,
    textLength: pick.text.length,
    // Начало текста, который реально ушёл в анализ. Нужно для отчёта о прогоне
    // набора URL и для диагностики: видно, какой именно фрагмент страницы
    // был принят за состав.
    preview: pick.text.slice(0, 200),
    zone: res.zone,
    zones: res.zones,
    matches: res.matches,
    marked: res.marked,
    snippet: firstMatch ? asgSnippet(pick.text, firstMatch.keyword) : ''
  };
  // Кэшируем только вердикты по настоящему блоку «Состав»: они стабильны.
  // Предварительные вердикты по обрывочному тексту не кэшируем, иначе
  // ошибочный цвет «закрепился» бы и повторялся на каждой следующей загрузке.
  if (complete && authoritative) cacheSet(url, result);
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
      if (html && html.length > MIN_PAGE_HTML) return html;
    } catch (e) { /* антибот или сбой — идём во вкладку */ }
    if (s.fetchStrategy === 'fetch') throw new Error('Страница недоступна по запросу');
  }
  return htmlFromTab(url);
}

// Медленный путь: загрузить страницу самим и проанализировать.
// Используется как fallback и при прогоне набора URL в настройках.
// force — пересчитать заново, не доверяя кэшу: нужен для регрессионных прогонов,
// иначе старый (возможно ошибочный) вердикт маскирует правку.
async function analyzeUrl(url, force) {
  const s = await loadSettings();
  await cacheWarm();

  if (!force) {
    const hit = cache.get(url);
    if (hit && typeof hit.authoritative === 'boolean') return { ...withRisk(hit), cached: true };
  }
  if (loaderBusy) return { url, status: 'error', error: 'Страница уже загружается' };

  loaderBusy = true;
  try {
    const html = await loadPageHtml(url, s);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const data = asgExtractFromDoc(doc, s);
    return await analyzeProduct({
      ...data,
      url,
      force: true, // результат уже получен свежим: в analyzeProduct кэш не нужен
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
        sendResponse(await analyzeUrl(msg.url, !!msg.force));
      } else if (msg && msg.type === 'get-settings') {
        sendResponse(await loadSettings());
      } else if (msg && msg.type === 'clear-cache') {
        clearCache();
        sendResponse({ ok: true, size: 0 });
      } else if (msg && msg.type === 'cache-info') {
        await cacheWarm();
        sendResponse({
          ok: true,
          size: cache.size,
          limit: CACHE_LIMIT,
          error: cacheError || '',
          dirty: cacheDirty
        });
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
