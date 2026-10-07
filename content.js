// Content script: работает ТОЛЬКО на странице одного товара.
// Текст состава/описания читается из уже открытой страницы (без сети),
// значок появляется сразу, затем короткое окно наблюдения на до-рендер SPA.
(() => {
  if (window.__ASG_LOADED__) return;
  window.__ASG_LOADED__ = true;

  const BADGE_ATTR = 'asg-safety-badge';
  const WATCH_MS = 12000; // окно наблюдения за до-рендером
  const AWAIT_COMPOSITION_MS = 8000; // сколько ждём первый достоверный состав,
  // прежде чем показать «проверяем состав…»
  const COMPOSE_WAIT_MS = 18000; // сколько ждём блок «Состав» после окна наблюдения
  const COMPOSE_PROBE_MS = 1000; // как часто проверять появление состава в этом ожидании
  const POLL_MS = 1000; // медленный опрос: адрес, окна наблюдения
  const QUIET_MS = 1200; // столько страница должна быть «тихой» перед показом цвета
  const SETTLE_MS = 3000; // после этой тишины выборка считается финальной
  const MUTATION_DEBOUNCE_MS = 400; // пауза после изменений DOM перед реакцией
  const REACT_MIN_MS = 600; // не чаще одной реакции на изменения страницы
  const LATE_CHECK_MS = 3000; // как часто проверять поздно дорисованный состав
  const LATE_WATCH_MS = 300000; // сколько следим за ним после вердикта (5 мин)
  const LOCAL_TEXT_MIN = 250; // меньше — пробуем догрузить страницу целиком
  const SEND_TIMEOUT_MS = 15000; // сколько ждём ответ фона на обычный запрос
  const SEND_TIMEOUT_LOAD_MS = 45000; // догрузка страницы в фоне: до 30 с вкладка + запрос

  // Карточка ли это товара. У известных маркетплейсов формат URL свой: общая
  // проверка «есть /product/ или /catalog/» ломалась и на Мarketе
  // (/product--slug/123), и на листингах Ozon (/catalog/elektronika/).
  const PRODUCT_PATH_RULES = [
    { host: 'ozon.ru', re: /^\/product[-/]/i },
    { host: 'wildberries.ru', re: /\/catalog\/\d+\/detail/i },
    { host: 'market.yandex.ru', re: /^\/product--|^\/product\//i }
  ];
  // Признаки карточки и раздела в URL — для сайтов вне списка выше
  const GENERIC_PRODUCT_PATH_RE = /(product|good|item|tovar|card|detail|offer)/i;
  const LIST_PATH_RE =
    /\/(catalog|category|categories|search|brand|collection|shop|tag|filter|promo)(\/|$)/i;

  const ZONE_ORDER = ASG_ZONE_ORDER;
  const ZONE_LABEL = ASG_ZONE_LABEL;
  const ZONE_SHORT = ASG_ZONE_SHORT;
  const ZONE_ICON = ASG_ZONE_ICON;

  let settings = null;
  const errors = [];
  let state = { status: 'idle' };
  let lastExtract = null;
  let busy = false;
  let pendingAnalyze = null; // запрос, пришедший во время работы
  let fallbackTried = false;
  let lastHref = null;
  let lastBodyLen = 0;
  let lastGrowthAt = 0;
  let lastAnalyzedAt = 0;
  let watchUntil = 0;
  let composeWaitUntil = 0;
  let awaitUntil = 0;
  let lateWatchUntil = 0;
  let composeProbeAt = 0;
  let lastReactAt = 0;
  let watching = false;
  let pollTimer = null;
  let mutationObserver = null;
  let mutationTimer = null;
  let lastRenderedConfirmed = null;
  let lastPanel = false;
  let lastFinal = false;
  // Показывали ли уже цвет по настоящему составу (см. isConfirmed)
  let confirmedShown = false;
  // Кэш ответа «есть ли на странице подпись „Состав“»: проверка обходит DOM,
  // а спрашивают о ней часто (isConfirmed вызывается на каждом тике)
  let labelProbe = { at: 0, len: -1, present: false };

  // --- служебное ---

  function rememberError(msg) {
    errors.push(new Date().toLocaleTimeString() + ' ' + String(msg).slice(0, 250));
    if (errors.length > 8) errors.shift();
  }

  // Заметки о ходе работы — отдельно от ошибок, чтобы в отчёте было видно,
  // почему вердикт пересчитывался (например, блок «Состав» пришёл поздно).
  const notes = [];
  function rememberNote(msg) {
    notes.push(new Date().toLocaleTimeString() + ' ' + String(msg).slice(0, 200));
    if (notes.length > 8) notes.shift();
  }

  async function loadSettings() {
    try {
      settings = await chrome.storage.local.get(ASG_DEFAULTS);
    } catch (e) {
      settings = ASG_DEFAULTS;
    }
  }

  function hostAllowed() {
    if (!settings) return false;
    const h = location.hostname.toLowerCase();
    return (settings.hosts || []).some((p) => {
      p = String(p).trim().toLowerCase();
      if (!p) return false;
      return h === p || h.endsWith('.' + p);
    });
  }

  function categoryDecision(name) {
    return asgCategoryDecision(
      name,
      (settings && settings.foodCategories) || ASG_DEFAULTS.foodCategories,
      (settings && settings.nonFoodCategories) || ASG_DEFAULTS.nonFoodCategories
    );
  }

  // Микроразметка товара (JSON-LD Product) — надёжный признак карточки на
  // сайте, для которого у нас нет правила по URL.
  function hasProductMarkup() {
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        let data;
        try {
          data = JSON.parse(s.textContent);
        } catch (e) {
          continue;
        }
        const items = Array.isArray(data) ? data : [data];
        for (const it of items) {
          if (!it || typeof it !== 'object') continue;
          const t = Array.isArray(it['@type']) ? it['@type'] : [it['@type']];
          for (const x of t) {
            if (String(x || '').toLowerCase() === 'product') return true;
          }
        }
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function isProductPage() {
    let host = '';
    let path = '';
    try {
      host = location.hostname.toLowerCase();
      path = location.pathname;
    } catch (e) {
      return false;
    }
    for (const rule of PRODUCT_PATH_RULES) {
      if (host === rule.host || host.endsWith('.' + rule.host)) return rule.re.test(path);
    }
    // Сайт из настроек, но с незнакомой разметкой URL
    if (GENERIC_PRODUCT_PATH_RE.test(path)) return true;
    if (LIST_PATH_RE.test(path)) return false;
    return hasProductMarkup();
  }

  // Ответ фона обязателен: без таймаута выгруженный service worker оставлял бы
  // промис незавершённым навсегда, а ждать его бесконечно нельзя — иначе busy
  // не сбросится и значок навсегда застрянет на «Проверяю состав…».
  function send(msg, timeoutMs) {
    const limit = timeoutMs || SEND_TIMEOUT_MS;
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(
        () => finish({ status: 'error', error: 'фон не ответил за ' + limit + ' мс' }),
        limit
      );
      let p;
      try {
        p = chrome.runtime.sendMessage(msg);
      } catch (e) {
        finish({ status: 'error', error: String(e) });
        return;
      }
      Promise.resolve(p).then(
        (r) => finish(r),
        (e) => finish({ status: 'error', error: String(e) })
      );
    });
  }

  // Длина текста документа — признак «страница растёт». Полный textContent
  // тела на тяжёлой карточке Ozon занимает миллисекунды, а спрашивается на
  // каждой пачке изменений DOM, поэтому держим оценку и правим её по мутациям.
  // Точное значение пересчитываем при смене товара и при переходе через SPA.
  let bodyLen = 0;
  function bodyLenExact() {
    bodyLen = document.body ? (document.body.textContent || '').length : 0;
    return bodyLen;
  }
  function bodyLenApply(records) {
    for (const rec of records) {
      for (const n of rec.addedNodes || []) {
        if (n.nodeType === 1 && n.hasAttribute && n.hasAttribute(BADGE_ATTR)) continue;
        bodyLen += (n.textContent || '').length;
      }
      for (const n of rec.removedNodes || []) {
        if (n.nodeType === 1 && n.hasAttribute && n.hasAttribute(BADGE_ATTR)) continue;
        bodyLen -= (n.textContent || '').length;
      }
    }
    return bodyLen;
  }
  function bodyTextLen() {
    return bodyLen;
  }

  // --- подтверждение результата ---
  // Цвет не показываем, пока не убедимся, что состав собран полностью:
  // найден настоящий блок «Состав», страница догружена целиком или текст устоялся.
  // Это правило симметрично: и ложный зелёный, и ложный красный вредны,
  // поэтому предварительный вердикт по обрывочным данным не показывается.
  function isSettled() {
    const now = Date.now();
    return now - lastGrowthAt >= SETTLE_MS && now - lastAnalyzedAt >= SETTLE_MS;
  }

  // Страница «успокоилась»: текст не менялся последние QUIET_MS.
  function isQuiet() {
    return Date.now() - lastGrowthAt >= QUIET_MS;
  }

  // --- подтверждение результата ---
  // Цвет не показываем, пока страница не «успокоится»: первый разбор нередко
  // попадает на промежуточное состояние DOM (например, у товара сначала виден
  // один блок «Состав», а через секунду рендерится другой). Правило симметрично:
  // и ложный зелёный, и ложный красный вредны.
  // Вердикт «состав не найден» тоже показывается только после окна наблюдения:
  // пока оно идёт, на значке «Проверяю состав…». Соблазн показать серую оценку
  // раньше («подписи на странице нет — ждать нечего») уже приводил к ошибке:
  // Ozon дорисовывает описание и блок «Состав» при прокрутке, и на карточке
  // вафель расширение успевало сказать «состав не найден» по полудорисованной
  // странице. Если состав появится позже, значок обновится сам — за этим
  // следит MutationObserver, а не окно наблюдения.
  function isConfirmed(r) {
    if (!r || r.status === 'pending' || r.status === 'idle') return false;
    if (r.status !== 'ok') return true; // ошибка — показываем сразу
    if (r.skipped) return true; // «не продукты» — показываем сразу
    if (lastFinal) return true; // текст окончательно устоялся и пересчитан
    // Показанное подтверждение держится: рост страницы после вердикта (отзывы,
    // рекомендации, ленивые картинки) — это не повод отбирать флаг назад.
    // Иначе значок мигает «Проверяю состав…» → флаг → «Проверяю состав…».
    // Показанное подтверждение держится: рост страницы после вердикта (отзывы,
    // рекомендации, ленивые картинки) — это не повод отбирать флаг назад.
    // Иначе значок мигает «Проверяю состав…» → флаг → «Проверяю состав…».
    if (r.authoritative && confirmedShown) return true;
    if (r.authoritative && isQuiet()) {
      confirmedShown = true;
      return true;
    }
    return false;
  }

  // --- значок ---

  function badgeEl() {
    return document.querySelector('[' + BADGE_ATTR + ']');
  }

  function removeBadge() {
    const el = badgeEl();
    if (el) el.remove();
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Текст, который реально ушёл на анализ: берём локальную выжимку,
  // соответствующую источнику. Так в панели видно, что именно проверялось.
  const COMPOSITION_PREVIEW = 600;

  function analyzedText(source) {
    const e = lastExtract;
    if (!e) return { text: '', len: 0 };
    let full = '';
    if (source === 'состав') full = e.composition || '';
    else if (source === 'описание') full = e.description || '';
    else full = e.pageText || '';
    const text = asgCollapse(full).slice(0, COMPOSITION_PREVIEW);
    return { text, len: asgCollapse(full).length };
  }

  // Нашлось ли хоть что-то: нужно, чтобы показывать находки даже без цвета
  function hasMatches(r) {
    if (!r || !r.zones) return false;
    for (const z of ZONE_ORDER) {
      if ((r.zones[z] || []).length) return true;
    }
    return false;
  }

  // Подсветка найденных компонентов прямо в тексте состава: слово выделяется
  // цветом своей зоны риска. Ищем и по найденной форме слова («мальтита»), и по
  // ключевому слову («мальтит»), но только на границе слова — иначе «мёд»
  // подсветился бы внутри «мёда», а «сахар» внутри «сахарозы».
  function highlightHtml(text, matches) {
    const plain = String(text || '');
    if (!plain || !matches || !matches.length) return esc(plain);
    const isWordChar = (c) => /[a-zа-яё0-9]/i.test(c);
    const lower = plain.toLowerCase();
    const ranges = [];
    const seenNeedle = {};
    for (const m of matches) {
      const zone = ZONE_ORDER.indexOf(m.zone) !== -1 ? m.zone : null;
      if (!zone) continue;
      const needles = [];
      for (const w of [m.word, m.keyword]) {
        const v = String(w || '').toLowerCase();
        if (v && v.length >= 3 && !seenNeedle[v + '|' + zone]) {
          seenNeedle[v + '|' + zone] = true;
          needles.push(v);
        }
      }
      for (const needle of needles) {
        let from = 0;
        while (from <= lower.length - needle.length) {
          const at = lower.indexOf(needle, from);
          if (at === -1) break;
          const after = plain.charAt(at + needle.length);
          if (!isWordChar(plain.charAt(at - 1)) && !isWordChar(after)) {
            ranges.push({ start: at, end: at + needle.length, zone });
          }
          from = at + needle.length;
        }
      }
    }
    if (!ranges.length) return esc(plain);
    // Перекрывающиеся подсветки несовместимы: оставляем самое длинное
    // («изомальтоолигосахарид» целиком, а не его начало)
    ranges.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
    const keep = [];
    for (const r of ranges) {
      if (keep.some((k) => r.start < k.end && r.end > k.start)) continue;
      keep.push(r);
    }
    keep.sort((a, b) => a.start - b.start);
    let out = '';
    let pos = 0;
    for (const r of keep) {
      out +=
        esc(plain.slice(pos, r.start)) +
        '<span class="hl z-' + r.zone + '">' + esc(plain.slice(r.start, r.end)) + '</span>';
      pos = r.end;
    }
    return out + esc(plain.slice(pos));
  }

  function renderBadge(res) {
    // Прокрутку панели сохраняем: значок собирается заново, и без этого
    // открытая панель каждый раз прыгала бы в начало
    const prev = badgeEl();
    const prevScroll =
      prev && prev.shadowRoot
        ? {
            panel: (prev.shadowRoot.querySelector('.panel') || {}).scrollTop || 0,
            comp: (prev.shadowRoot.querySelector('.comp') || {}).scrollTop || 0
          }
        : null;
    removeBadge();
    const r = res || { status: 'idle' };
    const confirmed = isConfirmed(r);

    // До первого ответа фона плашки нет. Иначе на непищевой карточке мигало бы
    // «Проверяю состав…» — и только через секунду выяснялось бы, что товар не
    // еда и плашка исчезает. Видимая активность допустима только на страницах
    // продуктов питания, а выяснить это можно лишь по результату проверки.
    if (r.status === 'pending' || r.status === 'idle') {
      lastRenderedConfirmed = confirmed;
      return;
    }

    // До первого ответа фона плашки нет. Иначе на непищевой карточке мигало бы
    // «Проверяю состав…» — и только через секунду выяснялось бы, что товар не
    // еда и плашка исчезает. Видимая активность допустима только на страницах
    // продуктов питания, а выяснить это можно лишь по результату проверки.

    let icon = '';
    let cls = 'b-wait';
    let label = 'Проверяю состав…';
    let count = '';
    let zone = null;

    if (r.status === 'ok' && r.skipped) {
      // На непищевых страницах значок не показываем вовсе: расширение про
      // состав еды, и серая плашка «Не продукты» на каждой странице одежды
      // или электроники только мешает. Ответ виден в попапе.
      removeBadge();
      lastRenderedConfirmed = confirmed;
      return;
    }
    if (r.status === 'ok' && confirmed) {
      zone = ZONE_ORDER.indexOf(r.zone) !== -1 ? r.zone : 'green';
      if (zone === 'green' && settings && settings.markClean === false) return;
      // Цвет ставится только по достоверному составу — найденному по подписи
      // «Состав» и похожему на перечень. По описанию товара цвет не показываем:
      // там встречаются «тростниковый сахар», «мёд» и прочие слова не из состава,
      // и такой вердикт потом меняется, когда приходит настоящий состав.
      // Проверка строгая: если флага нет (старая версия content script на
      // открытой вкладке, запись из прежнего кэша) — цвет не рисуем.
      if (r.authoritative !== true) {
        icon = '?';
        cls = 'b-gray';
        // Если слова найдены, но не в блоке «Состав», говорить «не найден»
        // нельзя: панель и попап показывают список находок, и плашка
        // противоречила бы им. Не подтверждено — честная формулировка.
        label = hasMatches(r) ? 'Состав не подтверждён' : 'Состав не найден';
        zone = null;
      } else {
        icon = ZONE_ICON[zone];
        cls = 'b-' + zone;
        label = ZONE_SHORT[zone];
      }
      let total = 0;
      for (const z of ZONE_ORDER) {
        for (const m of (r.zones && r.zones[z]) || []) total += m.count;
      }
      count = total ? String(total) : '';
    } else if (r.status === 'error') {
      icon = '?';
      cls = 'b-gray';
      label = 'Ошибка проверки';
    } else if (r.status === 'ok') {
      // результат есть, но он зелёный и ещё не подтверждён — показываем «проверяем»
      icon = '…';
      cls = 'b-wait';
      label = 'Проверяю состав…';
    }

    const lines = [];
    // Строка «Источник: блок «Состав»» убрана: источник и так назван в
    // заголовке проверяемого текста («Состав — что проверяли» / «Описание — …»),
    // а повторялась она ещё и внизу панели. Пометку о кэше переносим вниз, к
    // прочим служебным пометкам, чтобы панель начиналась с сути.

    // Проблемные компоненты — красная, оранжевая и жёлтая зоны. Зелёная зона
    // проблемой не является: стевия и подобное подсвечены в самом составе.
    const problemZones = ['red', 'orange', 'yellow'];
    const hasProblems = problemZones.some(
      (z) => ((r.zones && r.zones[z]) || []).length > 0
    );

    // Полный блок проверяемого текста: собираем здесь, а вставляем под находки —
    // так панель читается как «вердикт → что нашли → в каком тексте». Раньше
    // один и тот же состав показывался дважды: полным текстом и фрагментом.
    const analyzed = analyzedText(r.source);
    const what =
      r.source === 'состав'
        ? 'Состав — что проверяли'
        : r.source === 'описание'
        ? 'Описание — что проверяли'
        : 'Текст страницы — что проверяли';
    const found = [];
    for (const z of ZONE_ORDER) {
      for (const m of (r.zones && r.zones[z]) || []) {
        found.push({ zone: z, word: m.word, keyword: m.keyword });
      }
    }
    const analyzedBlock = () => {
      if (!analyzed.text) return [];
      const cut = analyzed.text.length > COMPOSITION_PREVIEW;
      return [
        '<div class="zh">' + what + '</div>',
        '<div class="comp">' + highlightHtml(analyzed.text, found) + (cut ? '…' : '') + '</div>',
        cut
          ? '<div class="cnt">показаны первые ' + COMPOSITION_PREVIEW + ' символов из ' +
            analyzed.len + '</div>'
          : ''
      ];
    };

    if (r.status === 'ok' && r.authoritative !== true) {
      const e = lastExtract || {};
      let why;
      if (r.source === 'состав') {
        // Состав найден, но вердикт не подтверждён. Объясняем настоящую
        // причину: раньше здесь всегда писалось «слова найдены в описании»,
        // даже когда источником был блок «Состав».
        why =
          r.trustedComposition === false
            ? 'Состав собран по тексту страницы, а не из блока «Состав» — как ' +
              'доказательство такой текст не годится.'
            : 'Блок «Состав» найден, но перечень выглядит неполным или обрезанным, ' +
              'а опасных веществ в нём не найдено. Утверждать безопасность по такому ' +
              'тексту нельзя — сверьтесь с упаковкой.';
      } else {
        why =
          'Цвет не показываем: эти слова найдены не в составе, а в ' +
          (r.source === 'описание' ? 'описании товара' : 'тексте страницы') +
          '. Надёжная оценка — только по блоку «Состав».';
      }
      lines.push('<div class="cnt">' + esc(why) + '</div>');
      if (r.source === 'состав' && e.composition) {
        const detail =
          'разобрано символов: ' + String(e.composition).length +
          ', компонентов: ' + (e.compositionParts || 0) +
          (e.compositionWellFormed === false ? ', перечень не завершён' : '') +
          (e.compositionBrackets && e.compositionBrackets.depth > 0
            ? ' (не закрыта скобка)'
            : '');
        lines.push('<div class="cnt">' + esc(detail) + '</div>');
      }
    }

    if (r.status === 'ok' && hasProblems) {
      // Заголовок появляется только когда ниже действительно перечисляются
      // проблемные ингредиенты. Если находок нет, панель состоит только из
      // проверяемого состава — пустого заголовка быть не должно.
      lines.push('<div class="zh">На что обратить внимание:</div>');
      for (const z of problemZones) {
        const ms = (r.zones && r.zones[z]) || [];
        if (!ms.length) continue;
        lines.push('<div class="zh z-' + z + '">' + esc(ZONE_LABEL[z]) + '</div>');
        for (const m of ms) {
          // найденное слово из состава, если оно отличается от названия
          // компонента: «Сорбит (E420)» найден по слову «сорбитол»
          const name = m.name || m.keyword;
          const w =
            m.word && name.toLowerCase().indexOf(String(m.word).toLowerCase()) === -1
              ? ' · ' + esc(m.word)
              : '';
          lines.push(
            '<div class="cmp"><b>' +
              esc(name) +
              '</b> ×' +
              m.count +
              w +
              (m.risk ? '<br><span>' + esc(m.risk) + '</span>' : '') +
              '</div>'
          );
        }
      }
    }

    // Проверенный текст — сразу под находками, с подсветкой найденных слов.
    // Показываем всегда, в том числе при зелёном флаге: это то, что проверяли,
    // и без него «Безопасно» выглядит голословным.
    lines.push(...analyzedBlock());

    if (r.status === 'ok' && !zone && hasMatches(r)) {
      lines.push(
        '<div class="snip">Оценка по описанию: эти компоненты упомянуты в тексте ' +
          'товара, но не подтверждены блоком «Состав».</div>'
      );
    }
    if (r.status === 'ok' && !zone && !hasMatches(r)) {
      lines.push(
        '<div class="snip">Блок «Состав» на странице не найден или не подтверждён. ' +
          'Опасные вещества в тексте страницы не обнаружены, но это не доказывает ' +
          'их отсутствие в составе — проверьте упаковку.</div>'
      );
    }

    if (!confirmed && r.status === 'ok') {
      lines.push(
        '<div class="snip">Ждём, пока страница догрузит состав — итог может уточниться.</div>'
      );
    }
    // Пометка о кэше — внизу, вместе с прочими служебными: наверху панель
    // начинается с сути, а не со служебных надписей.
    if (zone && r.cached) {
      lines.push('<div class="cnt">Показан кэшированный вердикт.</div>');
    }
    if (r.status === 'error') {
      lines.push('<div class="snip">' + esc(r.error || 'ошибка') + '</div>');
    }
    lines.push('<button class="again" type="button">Перепроверить</button>');

    const host = document.createElement('div');
    host.setAttribute(BADGE_ATTR, '');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      ':host{position:fixed;top:14px;right:14px;z-index:2147483647;font:13px/1.4 system-ui,Arial,sans-serif}' +
      '.pill{display:flex;align-items:center;gap:6px;padding:5px 11px;border:0;border-radius:14px;' +
      'color:#fff;font:700 13px/1.2 system-ui,Arial,sans-serif;cursor:pointer;white-space:nowrap;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.35)}' +
      '.b-red{background:#d92d20}.b-orange{background:#f79009}.b-yellow{background:#f5d908;color:#574a06}' +
      '.b-green{background:#12b76a}.b-gray{background:#667085}.b-wait{background:#98a2b3}' +
      '.ic{font-size:14px;line-height:1}.ct{font-size:12px;font-weight:700}' +
      '.panel{display:none;margin-top:6px;width:340px;max-height:60vh;overflow:auto;' +
      'background:#fff;color:#1d2939;border-radius:10px;padding:9px 11px;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.28);text-align:left}' +
      '.panel.open{display:block}' +
      '.row{display:flex;gap:8px;justify-content:space-between;margin:3px 0}' +
      '.row b{font-weight:600;text-align:right}' +
      '.zh{font-weight:700;margin:8px 0 2px}' +
      '.z-red{color:#d92d20}.z-orange{color:#b54708}.z-yellow{color:#9a6700}.z-green{color:#067647}' +
      '.cmp{margin:3px 0 5px;padding-left:8px;border-left:2px solid #e4e7ec}' +
      '.cmp span{color:#475467}' +
      '.comp{margin-top:2px;padding:6px 8px;background:#f9fafb;border:1px solid #e4e7ec;' +
      'border-radius:6px;color:#344054;max-height:150px;overflow:auto;white-space:pre-wrap;' +
      'word-break:break-word;line-height:1.55}' +
      // подсветка найденных компонентов прямо в тексте состава
      '.hl{border-radius:3px;padding:0 2px;font-weight:700}' +
      '.hl.z-red{background:#fee4e2;color:#b42318}' +
      '.hl.z-orange{background:#fef0c7;color:#b54708}' +
      '.hl.z-yellow{background:#fff6c9;color:#7a5300}' +
      '.hl.z-green{background:#dcfae6;color:#067647}' +
      '.cnt{margin-top:2px;color:#98a2b3;font-size:11px}' +
      '.snip{margin-top:6px;color:#475467;font-size:12px;word-break:break-word}' +
      '.again{margin-top:8px;width:100%;padding:5px;border:1px solid #d0d5dd;border-radius:6px;' +
      'background:#f2f4f7;cursor:pointer;font:13px system-ui,Arial,sans-serif}' +
      '</style>' +
      '<button class="pill ' + cls + '" type="button">' +
      '<span class="ic">' + icon + '</span><span>' + esc(label) + '</span>' +
      (count ? '<span class="ct">' + esc(count) + '</span>' : '') +
      '</button>' +
      '<div class="panel">' + lines.join('') + '</div>';

    const pill = root.querySelector('.pill');
    const panel = root.querySelector('.panel');
    if (lastPanel) panel.classList.add('open');
    pill.addEventListener('click', () => {
      panel.classList.toggle('open');
      lastPanel = panel.classList.contains('open');
    });
    root.querySelector('.again').addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.remove('open');
      lastPanel = false;
      analyze(true, true); // ручная перепроверка считается финальной
    });

    (document.body || document.documentElement).appendChild(host);
    if (prevScroll) {
      const panelNew = root.querySelector('.panel');
      const compNew = root.querySelector('.comp');
      if (panelNew) panelNew.scrollTop = prevScroll.panel;
      if (compNew) compNew.scrollTop = prevScroll.comp;
    }
    lastRenderedConfirmed = confirmed;
  }

  function updateBadge(force) {
    const conf = isConfirmed(state);
    if (!force && conf === lastRenderedConfirmed) {
      // Значок мог исчезнуть вместе с перестроенным DOM страницы: тогда его
      // нужно вернуть. Исключение — непищевые страницы, где значка нет намеренно.
      if (badgeEl() || (state && state.skipped)) return;
    }
    renderBadge(state);
  }

  // --- анализ ---

  // На странице есть подпись «Состав», а значения пока нет: блок ещё подгружается.
  // Если подписи на странице нет вовсе — ждать нечего.
  // Ответ кэшируется: проверка обходит DOM, а спрашивают о ней на каждом тике.
  function asgCompositionLabelPresent() {
    if (!lastExtract || lastExtract.hasComposition) return false;
    const now = Date.now();
    if (
      labelProbe.at &&
      now - labelProbe.at < COMPOSE_PROBE_MS &&
      labelProbe.len === lastBodyLen
    ) {
      return labelProbe.present;
    }
    let present = false;
    try {
      present = asgHasCompositionLabel(document);
    } catch (e) {
      present = false;
    }
    labelProbe = { at: now, len: lastBodyLen, present };
    return present;
  }

  // Показывать вердикт рано опасно: пока блок «Состав» не подгрузился, товар
  // оценивается по описанию, где встречаются «тростниковый сахар» и прочие
  // слова не из состава — товар вспыхивает красным и потом меняет цвет. Поэтому
  // первые AWAIT_COMPOSITION_MS показываем «проверяем состав…», если есть хоть
  // какая-то chances найти настоящий состав.
  function asgAwaitComposition(res) {
    if (!res || res.status !== 'ok' || res.skipped) return false;
    if (res.authoritative) return false;
    if (awaitUntil <= Date.now()) return false;
    return asgCompositionLabelPresent();
  }

  async function analyze(force, final) {
    if (busy) {
      // Запрос, пришедший во время работы, не теряем: иначе кнопка
      // «Перепроверить» и пересчёт после смены настроек молча ничего не делали бы
      pendingAnalyze = {
        force: !!force || !!(pendingAnalyze && pendingAnalyze.force),
        final: !!final || !!(pendingAnalyze && pendingAnalyze.final)
      };
      return;
    }
    busy = true;
    try {
      // Полный текст страницы собирается извлекателем только когда
      // подтверждённого состава нет — ровно тогда, когда он может стать
      // источником в фоне. Диагностика запрашивает его принудительно.
      const data = asgExtractFromDoc(document, settings);
      lastExtract = data;
      lastBodyLen = bodyTextLen();
      lastAnalyzedAt = Date.now();

      // Фон берёт ровно один источник (pickSource), поэтому полный текст
      // страницы отправляем только тогда, когда он может понадобиться: 20 КБ
      // на каждый пересчёт — это лишняя нагрузка на IPC и структурное клонирование.
      const needFallback = !(
        settings &&
        settings.preferComposition !== false &&
        data.authoritative
      );

      let res = await send({
        type: 'analyze',
        product: {
          url: location.href,
          composition: data.composition,
          description: needFallback ? data.description : '',
          topCategory: data.topCategory,
          topCategoryReliable: !!data.topCategoryReliable,
          pageText: needFallback ? data.pageText : '',
          confident: !!data.confident,
          authoritative: !!data.authoritative,
          compositionTrusted: !!data.compositionTrusted,
          materialComposition: !!data.materialComposition,
          final: !!final,
          force: !!force
        }
      });

      // локального текста не хватило (клиентский рендер) — догружаем страницу
      const localLen =
        (data.pageText || '').length + (data.description || '').length;
      if (
        !fallbackTried &&
        needFallback &&
        localLen < LOCAL_TEXT_MIN &&
        res.status === 'ok' &&
        !res.skipped &&
        !force
      ) {
        fallbackTried = true;
        const fb = await send(
          { type: 'analyze-url', url: location.href },
          SEND_TIMEOUT_LOAD_MS
        );
        if (fb && fb.status === 'ok' && (fb.textLength || 0) > (res.textLength || 0)) {
          res = fb;
        }
      }

      if (asgAwaitComposition(res)) {
        // результат по не-составу: показываем «проверяем состав…» и ждём
        // настоящий блок, финальным считать такой расчёт нельзя
        rememberNote(
          'ждём блок «Состав»: пока считаем по ' +
            (ASG_SOURCE_LABEL[res.source] || 'тексту страницы')
        );
        res = Object.assign({}, res, { complete: false, awaitingComposition: true });
      } else if (final) {
        lastFinal = true;
      }

      state = res || { status: 'error', error: 'Нет ответа' };
      updateBadge(true);
    } catch (e) {
      rememberError('analyze: ' + e);
      state = { status: 'error', error: String(e) };
      updateBadge(true);
    } finally {
      busy = false;
      if (pendingAnalyze) {
        const p = pendingAnalyze;
        pendingAnalyze = null;
        // через таймер, а не сразу: не растим стек при частых событиях
        setTimeout(() => analyze(p.force, p.final), 0);
      }
    }
  }

  // --- наблюдение за до-рендером и SPA-переходами ---

  function stopTimers() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    watching = false;
  }

  function stopWatch() {
    stopTimers();
    updateBadge(true);
  }

  function startWatch() {
    stopTimers();
    watchUntil = Date.now() + WATCH_MS;
    watching = true;
    lastGrowthAt = Date.now();
    pollTimer = setInterval(tick, POLL_MS);
    startObserver();
  }

  // Наблюдение за DOM вместо опроса текста: Ozon дорисовывает описание и блок
  // «Состав» при прокрутке, иногда уже после вердикта. Прежний опрос
  // прекращался вместе с окном наблюдения, и такой состав не замечался никогда;
  // MutationObserver срабатывает ровно тогда, когда страница что-то дорисовала.
  function startObserver() {
    if (mutationObserver || !document.body) return;
    mutationObserver = new MutationObserver((records) => {
      // Перерисовку собственного значка изменением страницы не считаем
      let ownOnly = true;
      for (const rec of records) {
        const nodes = [];
        if (rec.addedNodes) for (const n of rec.addedNodes) nodes.push(n);
        if (rec.removedNodes) for (const n of rec.removedNodes) nodes.push(n);
        if (!nodes.length) {
          ownOnly = false;
          break;
        }
        for (const n of nodes) {
          if (n.nodeType === 1 && n.hasAttribute && n.hasAttribute(BADGE_ATTR)) continue;
          ownOnly = false;
          break;
        }
        if (!ownOnly) break;
      }
      if (ownOnly) return;
      bodyLenApply(records);
      if (mutationTimer) return;
      mutationTimer = setTimeout(() => {
        mutationTimer = null;
        onDomChanged();
      }, MUTATION_DEBOUNCE_MS);
    });
    try {
      mutationObserver.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
      mutationObserver = null;
    }
  }

  function stopObserver() {
    if (mutationTimer) {
      clearTimeout(mutationTimer);
      mutationTimer = null;
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
  }

  // Страница что-то дорисовала. Реагируем не чаще, чем раз в REACT_MIN_MS.
  function onDomChanged() {
    if (!settings || !settings.enabled || !hostAllowed() || !isProductPage()) return;
    if (location.href !== lastHref) {
      start(); // SPA-переход на другой товар
      return;
    }
    if (state && state.status === 'ok' && state.skipped) return;
    const now = Date.now();
    // Реагируем, пока страница ещё может дорисовать состав: окно наблюдения,
    // а после вердикта — ещё LATE_WATCH_MS
    if (now > lateWatchUntil) return;
    if (now - lastReactAt < REACT_MIN_MS) return;
    lastReactAt = now;

    const len = bodyTextLen();
    if (len > lastBodyLen) {
      lastBodyLen = len;
      lastGrowthAt = now;
      // Достоверный вердикт по составу пересчитывать на каждый прирост текста
      // незачем: дальше идут отзывы, рекомендации и прочая обвязка страницы.
      const stable = !!(state && state.status === 'ok' && state.authoritative === true);
      if (!stable) analyze(true, lastFinal);
      return;
    }

    // Текст не вырос, но состав мог дорисоваться отдельным блоком — проверяем
    // это, пока идёт позднее наблюдение
    if (lastExtract && lastExtract.hasComposition) return;
    if (now - lastAnalyzedAt < LATE_CHECK_MS) return;
    if (!asgCompositionLabelPresent()) return;
    if (!asgProbeCompositionReady(document, settings)) return;
    rememberNote('блок «Состав» дорисован позже — пересчёт по нему');
    analyze(true, true);
  }

  function tick() {
    if (location.href !== lastHref) {
      start(); // SPA-переход на другой товар
      return;
    }
    // Непищевой товар: состава тут не будет, ждать нечего. Держим только
    // проверку адреса (переход на другой товар в SPA), чтобы не гонять
    // извлечение и обход текста по странице одежды или электроники.
    if (state && state.status === 'ok' && state.skipped) return;
    const now = Date.now();
    if (now > watchUntil) {
      // Блок «Состав» на Ozon появляется позже основного текста. Если после
      // окна наблюдения его всё ещё нет, вердикт навсегда остался бы посчитанным
      // по описанию — а там маркетинговый текст, и он даёт ложные находки.
      // Поэтому ждём состав ещё COMPOSE_WAIT_MS и пересчитываем, как только он
      // появится. Проверка идёт раз в COMPOSE_PROBE_MS и только на тихой странице.
      if (composeWaitUntil > now && asgWeakComposition(lastExtract)) {
        if (now - composeProbeAt >= COMPOSE_PROBE_MS && isSettled()) {
          composeProbeAt = now;
          // Спрашиваем только факт появления значения у подписи: полное
          // извлечение здесь обошло бы ещё и описание, категорию и текст
          // страницы, а это повторяется раз в секунду до двух десятков раз
          if (asgProbeCompositionReady(document, settings)) {
            rememberNote('найден настоящий блок «Состав» — пересчёт по нему');
            analyze(true, true);
            stopWatch();
            return;
          }
        }
        return; // наблюдение продолжается, значок не трогаем
      }
      // окно наблюдения истекло — финализируем: считаем, что состав уже пришёл
      if (!lastFinal) analyze(true, true);
      stopWatch();
      return;
    }
    // Прирост текста отслеживает MutationObserver (onDomChanged). Здесь только
    // финализация: пока страница не устоялась, вердикт показывать рано.
    if (!lastFinal && isSettled()) {
      analyze(true, true);
    } else {
      updateBadge();
    }
  }

  function start() {
    lastHref = location.href;
    fallbackTried = false;
    pendingAnalyze = null;
    labelProbe = { at: 0, len: -1, present: false };
    bodyLenExact();
    lastBodyLen = bodyTextLen();
    lastAnalyzedAt = Date.now();
    lastGrowthAt = Date.now();
    lastFinal = false;
    confirmedShown = false; // новый товар — показываем заново
    lastReactAt = 0;
    composeWaitUntil = Date.now() + WATCH_MS + COMPOSE_WAIT_MS;
    awaitUntil = Date.now() + AWAIT_COMPOSITION_MS;
    lateWatchUntil = Date.now() + LATE_WATCH_MS;
    composeProbeAt = 0;
    state = { status: 'pending' };
    updateBadge(true);
    analyze(false, false);
    startWatch();
  }

  // --- диагностика ---

// Слабый источник состава: скан текста всей страницы или догадка «блок после
// родителя подписи». Такой «состав» часто оказывается маркетинговым текстом,
// поэтому настоящий блок «Состав» стоит дождаться, даже если что-то нашлось.
function asgWeakComposition(e) {
  if (!e || !e.hasComposition) return true;
  return e.compositionTier === ASG_TIER_PARENT_SIBLING || e.compositionTier === ASG_TIER_TEXT;
}

// Почему на этой странице расширение не работает. null — работает.
  function inactiveReason() {
    if (!settings || !settings.enabled) return 'расширение выключено в настройках';
    if (!hostAllowed()) return 'сайт ' + location.hostname + ' не в списке разрешённых';
    if (!isProductPage()) return 'страница не похожа на карточку товара';
    return null;
  }

  async function diagnose() {
    const s = settings || ASG_DEFAULTS;
    const reason = inactiveReason();
    // третий аргумент — «покажи полный текст страницы»: в отчёте он нужен
    // независимо от того, подтвердился состав или нет
    const fresh = reason ? null : asgExtractFromDoc(document, s, true);
    let cacheInfo = null;
    try {
      cacheInfo = await send({ type: 'cache-info' });
    } catch (e) { /* ignore */ }
    let probe = null;
    if (!reason) {
      // проба ищет слово «состав» по странице — это подсказка для настройки
      // селекторов, а не результат анализа, и на нерелевантных страницах
      // она только путает
      try {
        probe = asgProbeComposition(document);
      } catch (e) { /* ignore */ }
    }
    const e = fresh || {};
    return {
      host: location.hostname,
      url: location.href,
      // заголовок страницы: в сообщении о проблеме он показывает, о каком
      // товаре речь, иначе письмо приходит с одним адресом
      title: (document.title || '').slice(0, 120),
      version: ASG_VERSION,
      enabled: !!(settings && settings.enabled),
      hostAllowed: hostAllowed(),
      productPage: isProductPage(),
      reason: reason,
      topCategory: e.topCategory || null,
      pageIsFood: e.topCategory ? categoryDecision(e.topCategory) : null,
      // итоговое решение фона: 'food' по разделу или по составу, 'notFood',
      // 'unknown' (раздел не опознан, но состав пищевой — так разбирают,
      // например батончики в разделе «Спорт и отдых»)
      foodDecision: (state && state.foodDecision) || null,
      extraction: {
        skipped: !!reason,
        hasComposition: !!e.hasComposition,
        hasDescriptionBlock: !!e.hasDescriptionBlock,
        confident: !!e.confident,
        authoritative: !!e.authoritative,
        compositionTrusted: !!e.compositionTrusted,
        materialComposition: !!e.materialComposition,
        compositionBrackets: e.compositionBrackets || null,
        compositionTier: e.compositionTier || 0,
        compositionCandidates: e.compositionCandidates || 0,
        compositionCandidatesList: e.compositionCandidatesList || [],
        // selector | label | attrs | chars | full | none — докуда дошёл поиск состава
        compositionDeepScan: e.compositionDeepScan || 'none',
        compositionParts: e.compositionParts || 0,
        compositionWellFormed: !!e.compositionWellFormed,
        ingredientListLike: !!e.ingredientListLike,
        compositionLen: (e.composition || '').length,
        compositionPreview: (e.composition || '').slice(0, 300),
        descriptionLen: (e.description || '').length,
        descriptionPreview: (e.description || '').slice(0, 300),
        pageTextLen: (e.pageText || '').length,
        pageTextPreview: (e.pageText || '').slice(0, 200)
      },
      result: state,
      resultConfirmed: isConfirmed(state),
      watching,
      observer: !!mutationObserver,
      compositionProbe: probe,
      cache: cacheInfo,
      settingsUsed: {
        preferComposition: !!(settings && settings.preferComposition),
        markClean: settings && settings.markClean,
        foodCategories: (settings && settings.foodCategories) || [],
        nonFoodCategories: (settings && settings.nonFoodCategories) || []
      },
      errors,
      notes
    };
  }

  // --- сообщения ---

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'asg-status') {
      sendResponse({
        ok: true,
        active: !!(settings && settings.enabled) && hostAllowed(),
        reason: inactiveReason(),
        host: location.hostname,
        productPage: isProductPage(),
        confirmed: isConfirmed(state),
        state
      });
      return false;
    }
    if (msg && msg.type === 'asg-rescan') {
      analyze(true, true)
        .then(() => sendResponse({ ok: true, state }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg && msg.type === 'asg-diag') {
      diagnose().then(sendResponse);
      return true;
    }
    return false;
  });

  // Ключи настроек, влияющие на вердикт. Служебный кэш фона (asgCache) пишется
  // в то же хранилище и приходит сюда же: без этого фильтра каждое сохранение
  // кэша запускало полный пересчёт страницы, а тот снова писал кэш — то есть
  // бесконечный цикл «анализ → запись кэша → onChanged → анализ» каждую секунду.
  const SETTINGS_KEYS = [
    'enabled',
    'markClean',
    'preferComposition',
    'foodCategories',
    'nonFoodCategories',
    'zones',
    'excludes',
    'contextExcludes',
    'hosts',
    'selectors',
    'fetchStrategy',
    'maxDescChars'
  ];

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (!SETTINGS_KEYS.some((k) => k in changes)) return;
    await loadSettings();
    labelProbe = { at: 0, len: -1, present: false };
    if (!isProductPage()) return;
    if (!settings.enabled || !hostAllowed()) {
      stopWatch();
      stopObserver();
      removeBadge();
      return;
    }
    analyze(true, true); // критерии изменились — пересчитываем принудительно
  });

  // --- старт ---

  (async () => {
    await loadSettings();
    if (!settings || !settings.enabled) return;
    if (!hostAllowed()) return;
    if (!isProductPage()) return; // работаем только на странице одного товара
    start();
  })();
})();
