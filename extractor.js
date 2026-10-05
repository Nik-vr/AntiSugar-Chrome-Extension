// Извлечение данных со страницы товара. Работает и в контексте страницы
// (content script), и в service worker на распарсенном HTML-документе.

const ASG_SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'CANVAS'
]);

// Границы разделов: обрезаем найденный блок по началу следующего поля/раздела
const ASG_SECTION_BOUNDARY =
  /(отзыв|отзывы|характеристик|описани|рекоменд|доставк|гарант|бренд|производител|страна|энергетическ|услови|габарит|комплектац|назначение|дополнительн|важно|инструкц|употреб|производ|вес товара|срок годности|пищевая ценность|калорийност|цвет\b)/i;

// Признаки того, что это НЕ состав (реклама, навигация, цены, отзывы)
const ASG_NOT_COMPOSITION =
  /(отзыв|рейтинг|доставк|гарант|₽|руб|скидк|акци|бонус|пункт выдачи|купить|в корзин|посмотреть|сравнить|ваша корзин|рассрочк|баллы|рекомендов)/i;

// Признаки того, что это НЕ описание товара
const ASG_NOT_DESCRIPTION =
  /(отзыв|рейтинг|₽|скидк|доставк|рекоменд|похожие|вакансии|ozon карт|бонус)/i;

// Пункты меню и служебные ссылки — не категории товара
const ASG_NAV_NOISE =
  /^(акци|скидк|распродаж|новинк|хит|бренд|доставк|продавц|для бизнес|помогите|поддержк|контакт|о нас|ваканс|блог|каталог|все товары|товары дня|избранн|корзин|поиск|отзыв|фото|купон|рефераль|партнёр|лк|карт[ыа] банка|мобильное приложение|сертификат|рейтинг|вопросы)/i;

const ASG_COMPOSITION_LABEL =
  /^\s*(состав|состав\s+товара|состав\s+продукта|ингредиенты|ингредиент[ы]?(\s+и\s+состав)?|ingredients|composition)\s*[:—-]?\s*$/i;
const ASG_DESCRIPTION_LABEL = /^\s*(описани[ея]|описание\s+товара|description)\s*[:—-]?\s*$/i;

const ASG_MAX_COMPOSITION = 1500;
// Состав может быть длинным — ассорти с четырьмя вкусами легко переваливает за
// полторы тысячи символов. Для значения, стоящего рядом с подписью «Состав»,
// разрешаем больше; «далёкие» куски текста (весь контейнер характеристик,
// соседний блок) остаются ограниченными, иначе в анализ попадёт мусор.
const ASG_MAX_VALUE = 4000;
const ASG_MAX_DESCRIPTION = 4000;

// Контейнеры с характеристиками: внутри них ищем подпись «Состав»
const ASG_CHAR_CONTAINER_SEL =
  'table, dl, [data-widget*="characteristic" i], [data-test*="characteristic" i],' +
  ' [class*="characteristic" i], [class*="haracteristic" i], [class*="attribute" i],' +
  ' [class*="spec" i], [data-widget*="webChar" i]';

// Надёжность источника значения (меньше — лучше). Прямое значение рядом с
// подписью достовернее текста контейнера, который может захватить рекламу.
const ASG_TIER_SELECTOR = 1; // селектор из настроек
const ASG_TIER_SAME = 2; // значение в том же элементе, что и подпись
const ASG_TIER_SIBLING = 3; // следующий элемент после подписи
const ASG_TIER_PARENT = 4; // текст родителя без подписи
const ASG_TIER_PARENT_SIBLING = 5; // сосед родителя
const ASG_TIER_ATTRIBUTE = 6; // метка зашита в data-test/class
const ASG_TIER_CONTAINER = 7; // контейнер характеристик
const ASG_TIER_JSON = 8; // состояние страницы
const ASG_TIER_TEXT = 9; // текстовый скан всей страницы

function asgCollapse(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

// Видимый текст документа без скриптов и стилей (обход дерева, без клонирования DOM)
function asgVisibleText(doc, limit) {
  const max = limit || 20000;
  const root = doc.body || doc.documentElement;
  if (!root) return '';
  const walker = doc.createTreeWalker(root, 4); // NodeFilter.SHOW_TEXT
  let out = '';
  let node;
  while ((node = walker.nextNode())) {
    const p = node.parentElement;
    if (!p || ASG_SKIP_TAGS.has(p.tagName)) continue;
    const v = node.nodeValue;
    if (v && v.trim()) {
      out += v + ' ';
      if (out.length >= max) break;
    }
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

// Признаки того, что блок «Состав» существует формально, но не содержит состава
const ASG_EMPTY_COMPOSITION =
  /^(не указан|нет данных|нет\s|по запросу|см\.?\s|уточняйте|на упаковке|упаковке|изготовител|состав не|данные отсутствуют|информация|состав:|—|-|\.)/i;

// Начало с рекламной фразы «не содержит сахара и пальмового масла. Батончик…» —
// это не заглушка, а настоящий состав, у которого первая фраза рекламная.
// Такие кандидаты отбрасываем, только если за фразой нет перечня ингредиентов.
const ASG_COMPOSITION_CLAIM = /^(не содержит|не содержит\s|не имеет|не включает|без\s)/i;

// Начала текстов, которые не могут быть составом.
// Рекламные блоки: «Преимущества: батончики без сахара; десерт без сахара; …».
// Строки характеристик: «Цель: Восстановление, Выносливость, …» — шесть пунктов
// через запятую выглядят как перечень ингредиентов, поэтому их тоже отсекаем.
// Граница слова задаётся через (?![\p{L}]) с флагом u: в JavaScript кириллица
// не относится к word characters, поэтому \b не срабатывает после русского
// слова. Флаг u обязателен — без него \p{L} трактуется как набор букв p, L, {.
const ASG_NOT_COMPOSITION_START = new RegExp(
  '^(?:преимущества|достоинства|плюсы|минусы|почему|зачем|сравнение|подборка|' +
    'подходит для|в наличии|цель|назначение|применение|способ применения|тип|форма|' +
    'длина|объ[её]м|объем|аромат|вкус|упаковка|комплектация|материал|вид|свойства)' +
    '(?![\\p{L}])',
  'iu'
);

// Есть ли за текстом перечень ингредиентов. Перечнем считаются пункты, где
// названы компоненты, а не перечисление отсутствий:
// «Не содержит: без глютена, без консервантов, без сахара» — пять пунктов,
// но ни одного ингредиента, это реклама, а не состав.
function asgLooksLikeList(t) {
  const parts = t.split(/[,;:]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) {
    // короткий перечень берём только с количествами: «кофе в зёрнах 100%»
    return /\d+\s*%|\d+\s*(г|мл|кг|мг|гр)\b/.test(t) && !asgOnlyAbsences(parts);
  }
  const named = parts.filter((p) => !/^(без|не содержит|не имеет|не включает)/i.test(p));
  if (named.length < 2) return false;
  return true;
}

// Перечисление только отсутствий: «без сахара, без глютена, без консервантов»
function asgOnlyAbsences(parts) {
  if (!parts.length) return true;
  return parts.every((p) => /^(без|не содержит|не имеет|не включает)/i.test(p));
}

// Оценка «похоже ли значение на состав». Метка «Состав» — главный сигнал,
// поэтому проверяем, что это не цена/доставка/отзывы и что это перечисление.
// Возвращаем число частей (больше — надёжнее) или -1, если это не состав.
function asgCompositionScore(text, maxLen) {
  const t = asgCollapse(text);
  const cap = maxLen || ASG_MAX_COMPOSITION;
  if (t.length < 8 || t.length > cap) return -1;
  if (ASG_NOT_COMPOSITION.test(t)) return -1;
  if (ASG_EMPTY_COMPOSITION.test(t)) return -1;
  if (ASG_NOT_COMPOSITION_START.test(t)) return -1;
  // «не содержит сахара…» — рекламное начало настоящего состава
  if (ASG_COMPOSITION_CLAIM.test(t) && !asgLooksLikeList(t)) return -1;
  if (
    /^(вес товара|страна|габарит|цвет(?![\p{L}])|срок годности|бренд|производител|пищевая ценность|калорийност|условия хранения|сертификат|страна изготовления)/iu.test(
      t
    )
  ) {
    return -1;
  }
  const parts = t.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  // «нет данных», «по запросу» и подобное — не состав
  if (
    parts.length <= 1 &&
    /^(нет\b|нет данных|не указано|по запросу|см\.?\s|упаковке|на упаковке|изготовител|—|-|\.)/i.test(
      t
    )
  ) {
    return -1;
  }
  return parts.length;
}

// Похож ли состав на завершённый: скобки сбалансированы, нет обрыва на
// запятой/союзе. Обрезанный состав (например «…глазурь (сахар») нельзя
// считать достоверным: в нём обрезаны и слова, и их окончания.
function asgCompositionWellFormed(text) {
  const t = asgCollapse(text);
  if (t.length < 15) return false;
  const open = (t.match(/[(«\[]/g) || []).length;
  const close = (t.match(/[)\]»]/g) || []).length;
  if (open !== close) return false;
  if (/[,;:]$/.test(t)) return false;
  if (/\b(и|или|а|но|из|с|по|для|без|при|от)\s*$/i.test(t)) return false;
  return true;
}

// Похож ли текст на перечень ингредиентов, а не на обычную фразу.
// Настоящий состав — это список (2+ части через запятую/точку с запятой)
// либо компонент с количеством («кофе в зёрнах 100%»).
function asgIngredientListLike(text) {
  const t = asgCollapse(text);
  if (!t) return false;
  const parts = t.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return true;
  return /\d+\s*%|\d+\s*(г|мл|кг|мг|гр)\b/.test(t);
}

// Значения, которые «принадлежат» элементу-метке, с указанием надёжности.
function asgLabeledValues(el, labelText, maxLen) {
  const max = maxLen || ASG_MAX_COMPOSITION;
  const lab = asgCollapse(labelText);
  const out = [];
  const t = asgCollapse(el.textContent);

  // значение, стоящее рядом с подписью, длинным быть может; куски подальше —
  // нет, иначе в анализ попадёт весь контейнер характеристик
  const add = (v, tier) => {
    const lim = tier <= ASG_TIER_SIBLING ? Math.max(max, ASG_MAX_VALUE) : max;
    const text = asgCollapse(v);
    if (text.length >= 5 && text.length <= lim) out.push({ text, tier });
  };

  const colon = t.indexOf(':');
  if (colon !== -1) {
    add(t.slice(colon + 1), ASG_TIER_SAME);
  } else if (t.length > lab.length + 5) {
    // «Состав» без двоеточия, но значение уже в этом же элементе
    add(t.slice(lab.length), ASG_TIER_SAME);
  }

  if (el.nextElementSibling) {
    add(el.nextElementSibling.textContent, ASG_TIER_SIBLING);
  }

  if (el.parentElement) {
    const parentText = asgCollapse(el.parentElement.textContent);
    if (parentText.length > lab.length + 5 && parentText.length <= max) {
      let v = asgCollapse(parentText.replace(lab, ' '));
      const b = ASG_SECTION_BOUNDARY.exec(v);
      if (b && b.index > 10) v = asgCollapse(v.slice(0, b.index));
      add(v, ASG_TIER_PARENT);
    }
    if (el.parentElement.nextElementSibling) {
      add(el.parentElement.nextElementSibling.textContent, ASG_TIER_PARENT_SIBLING);
    }
  }
  return out;
}

// Все кандидаты значения для метки (таблицы + элементы) с их надёжностью
function asgLabeledCandidates(doc, labelRe, maxLen) {
  const max = maxLen || ASG_MAX_COMPOSITION;
  const found = [];

  // таблицы: строка «Состав» → следующая ячейка; следующая строка; значение в той же ячейке
  try {
    const cells = doc.querySelectorAll('th, td');
    for (const c of cells) {
      const head = asgCollapse(c.textContent);
      if (head.length > 60 || !labelRe.test(head)) continue;
      const colon = head.indexOf(':');
      if (colon !== -1) {
        const tail = asgCollapse(head.slice(colon + 1));
        if (tail.length >= 5 && tail.length <= ASG_MAX_VALUE) {
          found.push({ text: tail, tier: ASG_TIER_SAME });
        }
      }
      const row = c.parentElement;
      const inRow = row ? Array.from(row.querySelectorAll('th, td')) : [];
      const idx = inRow.indexOf(c);
      for (let i = idx + 1; i < inRow.length; i++) {
        const v = asgCollapse(inRow[i].textContent);
        if (v.length >= 5 && v.length <= ASG_MAX_VALUE) {
          found.push({ text: v, tier: ASG_TIER_SIBLING });
        }
      }
      const nextRow = row && row.nextElementSibling;
      if (nextRow) {
        const v = asgCollapse(nextRow.textContent);
        if (v.length >= 5 && v.length <= max) {
          found.push({ text: v, tier: ASG_TIER_PARENT });
        }
      }
    }
  } catch (e) { /* ignore */ }

  // обычные элементы-метки
  try {
    const els = doc.querySelectorAll(
      'b, strong, span, div, h1, h2, h3, h4, h5, h6, dt, dd, label, p, li, summary, td'
    );
    for (const el of els) {
      const t = asgCollapse(el.textContent);
      if (t.length > 120 || !labelRe.test(t)) continue;
      for (const cand of asgLabeledValues(el, t, max)) found.push(cand);
    }
  } catch (e) { /* ignore */ }

  return found.filter(Boolean);
}

// Верхняя категория товара по хлебным крошкам.
// Возвращает { name, reliable }: reliable=true — крошки найдены однозначно,
// reliable=false — предположительно (использовать только как подсказку).
function asgTopCategory(doc) {
  const skip = new Set(['главная', 'home', 'каталог', '']);

  // 1) JSON-LD BreadcrumbList — самый надёжный источник
  const lists = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      const data = JSON.parse(s.textContent);
      const items = Array.isArray(data) ? data : [data];
      for (const it of items) {
        if (
          it &&
          typeof it === 'object' &&
          String(it['@type'] || '').toLowerCase() === 'breadcrumblist' &&
          Array.isArray(it.itemListElement)
        ) {
          lists.push(it.itemListElement);
        }
      }
    } catch (e) { /* невалидный JSON-LD */ }
  });
  for (const elems of lists) {
    const names = elems
      .map((e) => (e && e.name ? asgCollapse(e.name).toLowerCase() : ''))
      .filter(Boolean);
    const top = names.find((n) => !skip.has(n) && !ASG_NAV_NOISE.test(n));
    if (top) return { name: top, reliable: true };
  }

  // 2) контейнер крошек: список или элемент с маркером «breadcrumb»
  const anchors = doc.querySelectorAll('a[href]');
  for (const a of anchors) {
    const t = asgCollapse(a.textContent).toLowerCase();
    if (t !== 'главная' && t !== 'home') continue; // «каталог» — не точка отсчёта

    let container = a.closest ? a.closest('ol, ul') : null;
    let reliable = true;
    if (!container) {
      const marker = a.closest
        ? a.closest(
            '[aria-label*="breadcrumb" i], [aria-label*="хлеб" i],' +
            ' [class*="crumb" i], [class*="хлеб" i], [class*="breadcrumb" i]'
          )
        : null;
      if (marker) {
        container = marker;
      } else {
        // 3) подъём к предку, где ссылки похожи на категории (/category/…)
        container = null;
        let el = a.parentElement;
        for (let i = 0; i < 5 && el && el !== doc.body; i++) {
          const links = Array.from(el.querySelectorAll('a[href]'));
          let catish = 0;
          for (const l of links) {
            try {
              const p = new URL(l.getAttribute('href'), 'https://x').pathname;
              if (/^\/(category|cat|c)\//.test(p)) catish++;
            } catch (e) { /* не ссылка */ }
          }
          if (links.length >= 2 && links.length <= 12 && catish >= 2) {
            container = el;
            break;
          }
          el = el.parentElement;
        }
        if (!container) continue;
      }
    }
    if (!container) continue;

    const links = Array.from(container.querySelectorAll('a[href]'));
    const idx = links.indexOf(a);
    for (let i = idx + 1; i < links.length && i <= idx + 3; i++) {
      const nt = asgCollapse(links[i].textContent).toLowerCase();
      if (nt && !skip.has(nt) && !ASG_NAV_NOISE.test(nt) && nt.length < 60) {
        return { name: nt, reliable };
      }
    }
  }

  // 4) предположительный разбор текста («Продукты питания • Кофе • …»)
  try {
    const text = asgVisibleText(doc, 4000);
    const m = /Продукты\s+питания|Продукты/i.exec(text);
    if (m) {
      const name = asgCollapse(text.slice(m.index, m.index + 40)).split(/[•·|/»]/)[0];
      if (name && name.length < 60) return { name, reliable: false };
    }
  } catch (e) { /* ignore */ }

  return { name: null, reliable: false };
}

// name и description из JSON-LD
function asgJsonLdTexts(doc) {
  const out = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      const data = JSON.parse(s.textContent);
      const items = Array.isArray(data) ? data : [data];
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        if (typeof it.name === 'string') out.push(it.name);
        if (typeof it.description === 'string') out.push(it.description);
      }
    } catch (e) { /* невалидный JSON-LD */ }
  });
  return out;
}

// Тексты всех <script>, с раскодированием \uXXXX-последовательностей:
// состояние страницы часто хранит кириллицу именно в таком виде
function asgScriptTexts(doc) {
  const out = [];
  let scripts;
  try {
    scripts = doc.querySelectorAll('script');
  } catch (e) {
    return out;
  }
  for (const s of scripts) {
    const t = s.textContent || '';
    if (!t) continue;
    const capped = t.length > 400000 ? t.slice(0, 400000) : t;
    out.push(
      capped.indexOf('\\u') !== -1
        ? capped.replace(/\\u([0-9a-fA-F]{4})/g, (m, h) =>
            String.fromCharCode(parseInt(h, 16))
          )
        : capped
    );
  }
  return out;
}

// Состав из JSON-состояния страницы. Формы:
// {"Состав":"..."}, {"Состав":["...",...]}, {"title":"Состав","value":"..."}
function asgCompositionFromSources(doc) {
  const pools = [];
  try {
    pools.push((doc.documentElement && doc.documentElement.innerHTML) || '');
  } catch (e) { /* ignore */ }
  for (const t of asgScriptTexts(doc)) pools.push(t);

  const patterns = [
    /"(?:состав|composition|ingredients?)"\s*:\s*"((?:[^"\\]|\\.){8,800})"/i,
    /"(?:состав|composition|ingredients?)"\s*:\s*\[((?:[^[\]]){8,800})\]/i,
    /"(?:состав|composition|ingredients?)"[\s\S]{0,300}?"(?:value|текст|описание|description)"\s*:\s*"((?:[^"\\]|\\.){8,800})"/i,
    /"(?:title|name|key|param)"\s*:\s*"(?:состав|composition|ingredients?)"[\s\S]{0,300}?"(?:value|текст)"\s*:\s*"((?:[^"\\]|\\.){8,800})"/i,
    /"(?:состав|composition|ingredients?)"[\s\S]{0,300}?"(?:value|текст|описание|description)"\s*:\s*\[((?:[^[\]]){8,800})\]/i
  ];

  for (const pool of pools) {
    if (!pool) continue;
    for (const re of patterns) {
      const m = re.exec(pool);
      if (!m) continue;
      let raw = m[1];
      if (raw.indexOf('","') !== -1) {
        raw = raw.replace(/["']/g, ' ').replace(/,/g, ', ');
      }
      const v = asgCollapse(raw.replace(/[{}[\]]/g, ' '));
      if (asgCompositionScore(v) > 0) return v;
    }
  }
  return null;
}

// Блок «Состав». Кандидаты ранжируются по надёжности источника, а не по числу
// запятых: иначе рекламный текст с обилием запятых побеждает настоящий состав.
function asgFindComposition(doc, selectors) {
  const cands = [];
  const add = (text, tier) => {
    const t = asgCollapse(text);
    // прямые значения (рядом с подписью) допускаем длинными — ассорти с
    // несколькими вкусами иначе отбрасывается целиком
    const cap = tier <= ASG_TIER_SIBLING ? ASG_MAX_VALUE : ASG_MAX_COMPOSITION;
    const parts = asgCompositionScore(t, cap);
    if (parts > 0) cands.push({ text: t, tier, parts });
  };

  // 1) селекторы из настроек
  for (const sel of selectors || []) {
    if (!sel) continue;
    try {
      doc.querySelectorAll(sel).forEach((el) => add(el.textContent, ASG_TIER_SELECTOR));
    } catch (e) { /* некорректный селектор */ }
  }

  // 2) элементы, у которых метка зашита в атрибуты
  try {
    const marked = doc.querySelectorAll(
      '[data-test*="состав" i], [data-test*="composition" i], [data-test*="ingredient" i],' +
      ' [data-widget*="состав" i], [class*="состав" i], [class*="composition" i],' +
      ' [id*="состав" i], [aria-label*="состав" i]'
    );
    for (const el of marked) {
      if (ASG_SKIP_TAGS.has(el.tagName)) continue;
      add(el.textContent, ASG_TIER_ATTRIBUTE);
    }
  } catch (e) { /* ignore */ }

  // 3) кандидаты по подписи «Состав»
  for (const c of asgLabeledCandidates(doc, ASG_COMPOSITION_LABEL, ASG_MAX_COMPOSITION)) {
    add(c.text, c.tier);
  }

  // 4) внутри контейнеров характеристик
  try {
    const containers = doc.querySelectorAll(ASG_CHAR_CONTAINER_SEL);
    for (const cont of containers) {
      const els = cont.querySelectorAll('span, div, dt, dd, td, th, p, b, strong, li, label');
      for (const el of els) {
        const t = asgCollapse(el.textContent);
        if (!t || t.length > 60) continue;
        if (!/^состав\s*[:—-]?\s*$/i.test(t)) continue;
        for (const cand of asgLabeledValues(el, t, ASG_MAX_COMPOSITION)) {
          add(cand.text, Math.min(cand.tier, ASG_TIER_CONTAINER));
        }
      }
    }
  } catch (e) { /* ignore */ }

  // 5) JSON-состояние страницы
  const fromJson = asgCompositionFromSources(doc);
  if (fromJson) add(fromJson, ASG_TIER_JSON);

  // 6) текстовый скан всей страницы
  // Только с двоеточием: «Состав: …». Без двоеточия слово «состав» почти всегда
  // встречается в обычном тексте («по составу есть три источника белка…»), и
  // такой обрывок маркетинга раньше становился «составом».
  try {
    const text = asgVisibleText(doc, 80000);
    const m = /состав\s*:\s*([\s\S]{8,1500})/i.exec(text);
    if (m) {
      let v = asgCollapse(m[1]);
      const b = ASG_SECTION_BOUNDARY.exec(v);
      if (b && b.index > 20) v = asgCollapse(v.slice(0, b.index));
      add(v, ASG_TIER_TEXT);
    }
  } catch (e) { /* ignore */ }

  if (!cands.length) return null;
  // 1) завершённость (обрезанный состав не берём, если есть целый);
  // 2) надёжность источника; 3) компактность; 4) число компонентов
  cands.sort((a, b) => {
    const wa = asgCompositionWellFormed(a.text) ? 0 : 1;
    const wb = asgCompositionWellFormed(b.text) ? 0 : 1;
    if (wa !== wb) return wa - wb;
    if (a.tier !== b.tier) return a.tier - b.tier;
    const la = a.text.length <= 500 ? 0 : a.text.length <= 900 ? 1 : 2;
    const lb = b.text.length <= 500 ? 0 : b.text.length <= 900 ? 1 : 2;
    if (la !== lb) return la - lb;
    return b.parts - a.parts;
  });
  const best = cands[0];
  return {
    text: best.text,
    tier: best.tier,
    candidates: cands.length
  };
}

// Блок «Описание»: селекторы из настроек + подпись «Описание».
// Блок должен быть похож на описание товара, а не на контейнер со всей
// страницей (отзывы, рекомендации, цены).
function asgFindDescriptionBlock(doc, selectors) {
  const parts = [];
  const add = (t) => {
    const v = asgCollapse(t);
    if (!v) return;
    if (v.length > ASG_MAX_DESCRIPTION) return;
    if (ASG_NOT_DESCRIPTION.test(v)) return;
    parts.push(v);
  };

  for (const sel of selectors || []) {
    if (!sel) continue;
    try {
      doc.querySelectorAll(sel).forEach((el) => {
        const t =
          el.tagName === 'META' ? el.getAttribute('content') || '' : el.textContent;
        add(t);
      });
    } catch (e) { /* некорректный селектор */ }
  }

  const labeled = asgLabeledCandidates(doc, ASG_DESCRIPTION_LABEL, ASG_MAX_DESCRIPTION)
    .map((c) => c.text)
    .filter((v) => asgCollapse(v).length >= 40);
  if (labeled.length) {
    labeled.sort((a, b) => b.length - a.length);
    add(labeled[0]);
  }
  return parts.length ? asgCollapse(parts.join(' ')) : null;
}

// Описание для анализа: найденные блоки + JSON-LD + метатеги + заголовник
function asgFindDescription(doc, selectors) {
  const parts = [];
  const block = asgFindDescriptionBlock(doc, selectors);
  if (block) parts.push(block);
  for (const t of asgJsonLdTexts(doc)) parts.push(t);
  ['meta[name="description"]', 'meta[property="og:description"]'].forEach((sel) => {
    const el = doc.querySelector(sel);
    const c = el && el.getAttribute('content');
    if (c) parts.push(c);
  });
  const title = doc.querySelector('title');
  if (title) parts.push(title.textContent);
  const text = asgCollapse(parts.join(' '));
  return text || null;
}

// Диагностика: что удалось найти по слову «состав».
// Нужна, когда на конкретном сайте разметка отличается от ожидаемой.
function asgProbeComposition(doc) {
  const out = {
    wordInHtml: false,
    escapedInHtml: false,
    charContainers: 0,
    labeled: []
  };

  let html = '';
  try {
    html = (doc.documentElement && doc.documentElement.innerHTML) || '';
  } catch (e) { /* ignore */ }
  if (!html) return out;

  out.wordInHtml = /состав/i.test(html);
  out.escapedInHtml = /\\u0?42[14]/i.test(html) && /\\u0?43/.test(html);
  try {
    out.charContainers = doc.querySelectorAll(ASG_CHAR_CONTAINER_SEL).length;
  } catch (e) { /* ignore */ }
  if (!out.wordInHtml) return out;

  try {
    const els = doc.querySelectorAll(
      'div, span, p, b, strong, dt, dd, td, th, li, label, h1, h2, h3, h4, h5, h6, summary'
    );
    for (const el of els) {
      const t = asgCollapse(el.textContent);
      if (!t || t.length > 400) continue;
      if (!/^состав/i.test(t)) continue;
      const next = el.nextElementSibling;
      out.labeled.push({
        tag: el.tagName.toLowerCase(),
        cls:
          typeof el.className === 'string'
            ? el.className.split(/\s+/).slice(0, 3).join(' ')
            : '',
        dataTest: el.getAttribute('data-test') || '',
        dataWidget: el.getAttribute('data-widget') || '',
        text: t.slice(0, 80),
        nextText: next ? asgCollapse(next.textContent).slice(0, 80) : '',
        parentTextLen: el.parentElement
          ? asgCollapse(el.parentElement.textContent).length
          : 0
      });
      if (out.labeled.length >= 8) break;
    }
  } catch (e) { /* ignore */ }

  return out;
}

// Итоговая выжимка со страницы товара
function asgExtractFromDoc(doc, settings) {
  const max = (settings && settings.maxDescChars) || 20000;
  const out = {
    composition: null,
    description: null,
    descriptionBlock: null,
    hasComposition: false,
    hasDescriptionBlock: false,
    confident: false,
    // Зелёный флаг («опасных веществ нет») доказуем только блоком «Состав».
    // Описание товара — маркетинговый текст: оно может не содержать состава
    // вообще, поэтому безопасность по нему утверждать нельзя.
    authoritative: false,
    topCategory: null,
    topCategoryReliable: false,
    pageText: ''
  };

  const compSelectors =
    (settings && settings.selectors && settings.selectors.composition) || [];
  const descSelectors =
    (settings && settings.selectors && settings.selectors.description) || [];

  try {
    const cat = asgTopCategory(doc);
    out.topCategory = cat.name;
    out.topCategoryReliable = cat.reliable;
  } catch (e) {
    /* ignore */
  }
  try {
    const comp = asgFindComposition(doc, compSelectors);
    if (comp) {
      out.composition = comp.text;
      out.compositionTier = comp.tier;
      out.compositionCandidates = comp.candidates;
    } else {
      out.composition = null;
      out.compositionTier = 0;
      out.compositionCandidates = 0;
    }
  } catch (e) { /* ignore */ }
  try {
    out.descriptionBlock = asgFindDescriptionBlock(doc, descSelectors);
    out.description = asgFindDescription(doc, descSelectors);
  } catch (e) { /* ignore */ }
  try { out.pageText = asgVisibleText(doc, max); } catch (e) { /* ignore */ }

  out.hasComposition = !!out.composition;
  out.hasDescriptionBlock = !!out.descriptionBlock;
  out.confident = out.hasComposition || out.hasDescriptionBlock;
  out.compositionParts = out.composition
    ? out.composition.split(/[,;]/).map((s) => s.trim()).filter(Boolean).length
    : 0;
  out.compositionWellFormed = asgCompositionWellFormed(out.composition || '');
  out.ingredientListLike = asgIngredientListLike(out.composition || '');
  // Зелёный флаг доказуем только завершённым блоком «Состав», который при этом
  // выглядит как перечень ингредиентов. Описание — маркетинговый текст,
  // обрезанный состав может содержать обрыв слова, а обычная фраза с
  // подписью «Состав» — вовсе не перечень.
  out.authoritative =
    out.hasComposition && out.compositionWellFormed && out.ingredientListLike;
  return out;
}
