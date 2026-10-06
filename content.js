// Content script: работает ТОЛЬКО на странице одного товара.
// Текст состава/описания читается из уже открытой страницы (без сети),
// значок появляется сразу, затем короткое окно наблюдения на до-рендер SPA.
(() => {
  if (window.__ASG_LOADED__) return;
  window.__ASG_LOADED__ = true;

  const BADGE_ATTR = 'asg-safety-badge';
  const PRODUCT_PATH_RE = /\/(product|catalog|card)\//i;
  const WATCH_MS = 20000; // окно наблюдения за до-рендером
  const AWAIT_COMPOSITION_MS = 8000; // сколько ждём первый достоверный состав,
  // прежде чем показать серый «состав не найден»
  const COMPOSE_WAIT_MS = 40000; // сколько ждём блок «Состав» после окна наблюдения
  const COMPOSE_PROBE_MS = 1000; // как часто проверять появление состава в этом ожидании
  const POLL_MS = 400; // как часто проверяем, изменился ли текст
  const QUIET_MS = 1200; // столько страница должна быть «тихой» перед показом цвета
  const SETTLE_MS = 3000; // после этой тишины выборка считается финальной
  const RENDER_DELTA = 200; // минимальный прирост текста для повторной проверки
  const LOCAL_TEXT_MIN = 250; // меньше — пробуем догрузить страницу целиком

  const ZONE_ORDER = ['red', 'orange', 'yellow', 'green'];
  const ZONE_LABEL = {
    red: 'Зона высокого риска',
    orange: 'Зона обмана и скрытых угроз',
    yellow: 'Зона компромиссов',
    green: 'Зона безопасности'
  };
  const ZONE_SHORT = {
    red: 'Высокий риск',
    orange: 'Скрытые угрозы',
    yellow: 'Компромиссы',
    green: 'Безопасно'
  };
  const ZONE_ICON = { red: '!', orange: '!', yellow: '!', green: '✓' };

  let settings = null;
  const errors = [];
  let state = { status: 'idle' };
  let lastExtract = null;
  let busy = false;
  let fallbackTried = false;
  let lastHref = null;
  let lastBodyLen = 0;
  let lastGrowthAt = 0;
  let lastAnalyzedAt = 0;
  let watchUntil = 0;
  let composeWaitUntil = 0;
let awaitUntil = 0;
  let composeProbeAt = 0;
  let watching = false;
  let pollTimer = null;
  let recheckTimer = null;
  let lastRenderedConfirmed = null;
  let lastPanel = false;
  let lastFinal = false;

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

  function isFoodCategory(name) {
    const n = String(name || '').trim().toLowerCase();
    const cats = (settings && settings.foodCategories
      ? settings.foodCategories
      : [])
      .map((c) => String(c).trim().toLowerCase())
      .filter(Boolean);
    if (!n || !cats.length) return true;
    return cats.some((c) => n.includes(c));
  }

  function isProductPage() {
    try {
      return PRODUCT_PATH_RE.test(location.pathname);
    } catch (e) {
      return false;
    }
  }

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch((e) => ({
      status: 'error',
      error: String(e)
    }));
  }

  function bodyTextLen() {
    return document.body ? (document.body.textContent || '').length : 0;
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
function isConfirmed(r) {
  if (!r || r.status === 'pending' || r.status === 'idle') return false;
  if (r.status !== 'ok') return true; // ошибка — показываем сразу
  if (r.skipped) return true; // «не продукты» — показываем сразу
  if (lastFinal) return true; // текст окончательно устоялся и пересчитан
  if (r.authoritative && isQuiet()) return true; // настоящий состав + страница тихая
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

  function renderBadge(res) {
    removeBadge();
    const r = res || { status: 'idle' };
    const confirmed = isConfirmed(r);

    let icon = '';
    let cls = 'b-wait';
    let label = 'Проверяю состав…';
    let count = '';
    let zone = null;

    if (r.status === 'ok' && r.skipped) {
      icon = '–';
      cls = 'b-gray';
      label = 'Не продукты';
    } else if (r.status === 'ok' && confirmed) {
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
        label = r.source === 'состав' ? 'Состав не подтверждён' : 'Состав не найден';
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
    if (zone || (r.status === 'ok' && r.skipped)) {
      lines.push(
        '<div class="row"><span>Источник</span><b>' +
          esc(
            r.source === 'состав'
              ? 'блок «Состав»'
              : r.source === 'описание'
              ? 'блок «Описание»'
              : r.source === 'страница'
              ? 'текст страницы'
              : '—'
          ) +
          '</b></div>'
      );
      if (r.cached) lines.push('<div class="row"><span>Кэш</span><b>да</b></div>');
    }

    // Всегда показываем, какой именно текст проверяли — в том числе при зелёном
    const analyzed = analyzedText(r.source);
    if (analyzed.text) {
      const cut = analyzed.text.length > COMPOSITION_PREVIEW;
      lines.push(
        '<div class="zh">' +
          (r.source === 'страница' ? 'Текст страницы — что проверяли' : 'Состав — что проверяли') +
          '</div>' +
          '<div class="comp">' + esc(analyzed.text) + (cut ? '…' : '') + '</div>' +
          (cut
            ? '<div class="cnt">показаны первые ' + COMPOSITION_PREVIEW +
              ' символов из ' + analyzed.len + '</div>'
            : '')
      );
    }

    if (r.status === 'ok' && r.authoritative !== true && !r.skipped) {
      lines.push(
        '<div class="cnt">Цвет не показываем: эти слова найдены не в составе, а в ' +
          'описании товара. Надёжная оценка — только по блоку «Состав».</div>'
      );
    }

    if (r.status === 'ok' && (zone || hasMatches(r))) {
      for (const z of ZONE_ORDER) {
        const ms = (r.zones && r.zones[z]) || [];
        if (!ms.length) continue;
        // Показываем все зоны, а не только старшую: сорбитол в «скрытых
        // угрозах» не должен пропадать из-за аспартама в «высоком риске»
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
      if (r.snippet) lines.push('<div class="snip">' + esc(r.snippet) + '</div>');
      if (!zone && hasMatches(r)) {
        lines.push(
          '<div class="snip">Оценка по описанию: эти компоненты упомянуты в тексте ' +
            'товара, но не подтверждены блоком «Состав».</div>'
        );
      }
      if (!zone && !hasMatches(r)) {
        lines.push(
          '<div class="snip">Блок «Состав» на странице не найден или не подтверждён. ' +
            'Опасные вещества в тексте страницы не обнаружены, но это не доказывает ' +
            'их отсутствие в составе — проверьте упаковку.</div>'
        );
      }
    }

    if (!confirmed && r.status === 'ok') {
      lines.push(
        '<div class="snip">Ждём, пока страница догрузит состав — итог может уточниться.</div>'
      );
    }
    if (r.status === 'ok' && r.skipped) {
      lines.push(
        '<div class="snip">Категория «' +
          esc(r.reason || '?') +
          '» — анализ не проводился.</div>'
      );
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
      'border-radius:6px;color:#344054;max-height:130px;overflow:auto;white-space:pre-wrap;' +
      'word-break:break-word}' +
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
    lastRenderedConfirmed = confirmed;
  }

  function updateBadge(force) {
    const conf = isConfirmed(state);
    if (!force && conf === lastRenderedConfirmed) return;
    renderBadge(state);
  }

  // --- анализ ---

  // На странице есть подпись «Состав», а значения пока нет: блок ещё подгружается.
  // Если подписи на странице нет вовсе — ждать нечего.
  function asgCompositionLabelPresent() {
    if (!lastExtract || lastExtract.hasComposition) return false;
    try {
      return asgProbeComposition(document).labeled.length > 0;
    } catch (e) {
      return false;
    }
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
    if (busy) return;
    busy = true;
    try {
      const data = asgExtractFromDoc(document, settings);
      lastExtract = data;
      lastBodyLen = bodyTextLen();
      lastAnalyzedAt = Date.now();

      let res = await send({
        type: 'analyze',
        product: {
          url: location.href,
          composition: data.composition,
          description: data.description,
          topCategory: data.topCategory,
          topCategoryReliable: !!data.topCategoryReliable,
          pageText: data.pageText,
          confident: !!data.confident,
          authoritative: !!data.authoritative,
          final: !!final,
          force: !!force
        }
      });

      // локального текста не хватило (клиентский рендер) — догружаем страницу
      const localLen =
        (data.pageText || '').length + (data.description || '').length;
      if (
        !fallbackTried &&
        localLen < LOCAL_TEXT_MIN &&
        res.status === 'ok' &&
        !res.skipped &&
        !force
      ) {
        fallbackTried = true;
        const fb = await send({ type: 'analyze-url', url: location.href });
        if (fb && fb.status === 'ok' && (fb.textLength || 0) > (res.textLength || 0)) {
          res = fb;
        }
      }

      if (asgAwaitComposition(res)) {
        // результат по не-составу: показываем «проверяем состав…» и ждём
        // настоящий блок, финальным считать такой расчёт нельзя
        rememberNote('ждём блок «Состав»: пока считаем по ' + (res.source || 'странице'));
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
    }
  }

  // --- наблюдение за до-рендером и SPA-переходами ---

  function stopWatch() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (recheckTimer) {
      clearTimeout(recheckTimer);
      recheckTimer = null;
    }
    watching = false;
    updateBadge(true);
  }

  function startWatch() {
    if (pollTimer) clearInterval(pollTimer);
    if (recheckTimer) clearTimeout(recheckTimer);
    watchUntil = Date.now() + WATCH_MS;
    watching = true;
    lastGrowthAt = Date.now();
    pollTimer = setInterval(tick, POLL_MS);
  }
  function tick() {
    if (location.href !== lastHref) {
      start(); // SPA-переход на другой товар
      return;
    }
    const now = Date.now();
    if (now > watchUntil) {
      // Блок «Состав» на Ozon появляется позже основного текста. Если после
      // окна наблюдения его всё ещё нет, вердикт навсегда остался бы посчитанным
      // по описанию — а там маркетинговый текст, и он даёт ложные находки.
      // Поэтому ждём состав ещё COMPOSE_WAIT_MS и пересчитываем, как только он
      // появится. Проверка идёт раз в COMPOSE_PROBE_MS и только на тихой странице.
      if (composeWaitUntil > now && asgWeakComposition(lastExtract)) {
        const len = bodyTextLen();
        if (len > lastBodyLen) {
          lastGrowthAt = now;
          lastBodyLen = len;
        }
        if (now - composeProbeAt >= COMPOSE_PROBE_MS && isSettled()) {
          composeProbeAt = now;
          const fresh = asgExtractFromDoc(document, settings);
          if (!asgWeakComposition(fresh)) {
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
    const len = bodyTextLen();
    if (len > lastBodyLen) {
      // текст ещё меняется (SPA догружает описание) — пересчитываем
      lastGrowthAt = now;
      lastBodyLen = len;
      if (recheckTimer) clearTimeout(recheckTimer);
      recheckTimer = setTimeout(() => {
        recheckTimer = null;
        analyze(true, false);
      }, 400);
      return;
    }
// текст устоялся: финализируем результат (тогда его можно показывать),
// иначе просто перерисуем значок (например, сменился статус подтверждения)
if (!lastFinal && isSettled()) {
      analyze(true, true);
    } else {
      updateBadge();
    }
  }

  function start() {
    lastHref = location.href;
    fallbackTried = false;
    lastBodyLen = bodyTextLen();
    lastAnalyzedAt = Date.now();
    lastGrowthAt = Date.now();
    lastFinal = false;
    composeWaitUntil = Date.now() + WATCH_MS + COMPOSE_WAIT_MS;
    awaitUntil = Date.now() + AWAIT_COMPOSITION_MS;
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
    const fresh = reason ? null : asgExtractFromDoc(document, s);
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
      version: ASG_VERSION,
      enabled: !!(settings && settings.enabled),
      hostAllowed: hostAllowed(),
      productPage: isProductPage(),
      reason: reason,
      topCategory: e.topCategory || null,
      pageIsFood: e.topCategory ? isFoodCategory(e.topCategory) : null,
      extraction: {
        skipped: !!reason,
        hasComposition: !!e.hasComposition,
        hasDescriptionBlock: !!e.hasDescriptionBlock,
        confident: !!e.confident,
        authoritative: !!e.authoritative,
        compositionTier: e.compositionTier || 0,
        compositionCandidates: e.compositionCandidates || 0,
        compositionCandidatesList: e.compositionCandidatesList || [],
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
      compositionProbe: probe,
      cache: cacheInfo,
      settingsUsed: {
        preferComposition: !!(settings && settings.preferComposition),
        markClean: settings && settings.markClean,
        foodCategories: (settings && settings.foodCategories) || []
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

  chrome.storage.onChanged.addListener(async (_changes, area) => {
    if (area !== 'local') return;
    await loadSettings();
    if (!isProductPage()) return;
    if (!settings.enabled || !hostAllowed()) {
      stopWatch();
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
