// Анализ текста по ключевым словам в зонах риска (background service worker)

const ASG_ZONES = ['red', 'orange', 'yellow', 'green'];

function asgNorm(t) {
  return String(t || '')
    // невидимые символы внутри слов ломают и сопоставление ключевых слов,
    // и границу слова: убираем на входе
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Транслитация похожих символов (Е952/е952 -> e952), чтобы поиск E-кодов
// не зависел от кириллицы/латиницы. Замещения 1:1 — индексы сохраняются.
function asgTranslit(t) {
  return t
    .replace(/а/g, 'a')
    .replace(/е/g, 'e')
    .replace(/о/g, 'o')
    .replace(/с/g, 'c')
    .replace(/р/g, 'p')
    .replace(/в/g, 'b');
}

// Слова выделяем регуляркой, а не по пробелам: в составе на Ozon пишут
// «хлопья неглазированные (без сахара, без глютена)» — по пробелу последнее
// слово получается «(без», и сравнение с исключением «без» не срабатывало.
const ASG_WORD_RE = /[a-zа-яё0-9]+/gi;

// «не содержит сахара», «не имеет сахара» — отрицание с глаголом перед
// совпадением. В список слов-исключений «содержит» добавить нельзя: тогда
// пропадало бы и «содержит мёд».
const ASG_NEG_WORD = asgTranslit('не');
const ASG_HAS_VERBS = ['содерж', 'содержащ', 'имеет'].map((w) => asgTranslit(w));

// Отрицание перед совпадением: «без сахара», «без добавленного сахара»,
// «без сахара и мёда». Проверяем до трёх слов непосредственно перед совпадением
// и до границы фразы (запятая/точка с запятой). Широкий коридор был плох тем, что
// «без сахара безвреда из фиников» гасил «финик», хотя «без» относилось
// к сахару, а не к финикам.
function asgNegatedBefore(t, start, excludes) {
  if (!excludes.length) return false;
  let prefix = t.slice(Math.max(0, start - 48), start);
  const cut = prefix.search(/[,;:.!?()»"]/);
  if (cut !== -1) prefix = prefix.slice(cut + 1);
  const words = (prefix.match(ASG_WORD_RE) || []).slice(-3);
  for (const w of words) {
    for (const e of excludes) {
      if (w === e) return true;
    }
  }
  // «не содержит сахара» — отрицание с глаголом перед совпадением
  for (let i = 0; i + 1 < words.length; i++) {
    if (words[i] !== ASG_NEG_WORD) continue;
    for (const v of ASG_HAS_VERBS) {
      if (words[i + 1].indexOf(v) === 0) return true;
    }
  }
  return false;
}

// Отрицание сразу после совпадения, внутри того же слова: «сахар|озаменитель».
// Смотрим только остаток текущего слова, иначе «фиников без добавления сахара»
// погасило бы «финик» из-за соседней фразы.
function asgNegatedAfter(t, end, excludes) {
  if (!excludes.length) return false;
  let j = end;
  while (j < t.length && /[a-zа-я0-9]/.test(t[j])) j++;
  const rest = t.slice(end, j);
  if (!rest) return false;
  return excludes.some((e) => rest.includes(e));
}

// Отрицание, стоящее после совпадения: «мёда в составе нет», «сахара не содержит».
// «без» сюда намеренно не входит: в связке «мёд без сахара» оно относится
// к сахару, а не к мёду.
const ASG_POST_NEGATIONS = ['нет', 'нету', 'не', 'отсутствует', 'отсутств', 'исключен', 'исключён'];

function asgNegatedAfterWords(t, end) {
  let tail = t.slice(end, end + 48);
  const cut = tail.search(/[,;:.!?()«"]/);
  if (cut > 0) tail = tail.slice(0, cut);
  const words = (tail.match(ASG_WORD_RE) || []).slice(0, 4);
  if (!words.length) return false;
  // текст транслитерирован, значит и список отрицаний должен быть в той же форме
  const normalized = ASG_POST_NEGATIONS.map((w) => asgTranslit(w));
  return words.some((w) => normalized.includes(w) || ASG_POST_NEGATIONS.includes(w));
}

// Совпадение должно начинаться на границе слова.
// Перед совпадением не должно быть буквы: это отсекает «вмЕСтО», «мЕдный»,
// «безасхарный», но оставляет склонения: сахар/сахара/сахаром, мед/меда/медом.
const ASG_WORD_CHAR = /[a-zа-яё]/i;

// Основы слов. Склонения в русском меняют окончание, поэтому ищем по основе:
// «агава» → «агав» ⊂ «агавы»; «финики» → «финик» ⊂ «фиников»;
// «глюкозный» → «глюкозн» ⊂ «глюкозного» (у прилагательных на -ый/-ий
// срезать нужно две буквы, а не одну).
function asgWordStem(word) {
  const w = String(word || '').trim();
  if (!w) return '';
  let stem = w;
  if (/[ыи]й$/i.test(stem)) stem = stem.slice(0, -2);
  else if (/[аеёиоуыэюяьй]$/i.test(stem)) stem = stem.slice(0, -1);
  return asgTranslit(stem);
}

// Ключевое слово превращается в список основ по словам:
// «кукурузный сироп» → [«кукурузн», «сироп»]
function asgKeywordStems(kwDisp) {
  return kwDisp.split(/\s+/).map(asgWordStem).filter(Boolean);
}

// После основы слова должно идти окончание, а не новый корень.
// «изомальт» ⊂ «изомальтосахарид» — но это разные вещества (изомальт E953
// и изомальтоолигосахарид), поэтому короткое слово не должно срабатывать.
// Русские окончания длиннее 4 букв не встречаются («финиковых», «кукурузного»).
const ASG_MAX_ENDING = 4;

function asgEndingOk(t, end) {
  let j = end;
  while (j < t.length && ASG_WORD_CHAR.test(t[j])) j++;
  return j - end <= ASG_MAX_ENDING;
}

// Первое вхождение основы с начала слова и без нового корня
function asgFindInWindow(t, needle, from, to) {
  let idx = from;
  while ((idx = t.indexOf(needle, idx)) !== -1) {
    if (idx + needle.length > to) return -1;
    const prev = idx > 0 ? t[idx - 1] : '';
    if (!ASG_WORD_CHAR.test(prev) && asgEndingOk(t, idx + needle.length)) return idx;
    idx += needle.length;
  }
  return -1;
}

// Многословные ключи ищем по близости: все слова основы должны встретиться
// рядом, в любом порядке («сироп кукурузный» = «кукурузный сироп»).
// Состав — список через запятую, поэтому перешагивать границу компонента
// нельзя: иначе «кукурузное волокно, сироп топинамбура» собиралось бы в
// «кукурузный сироп» (HFCS).
const ASG_NEAR = 70;

function asgSpansForStems(t, stems) {
  const out = [];
  const anchor = stems.slice().sort((a, b) => b.length - a.length)[0];
  const rest = stems.filter((w) => w !== anchor);
  let idx = 0;
  while ((idx = t.indexOf(anchor, idx)) !== -1) {
    const anchorEnd = idx + anchor.length;
    const prev = idx > 0 ? t[idx - 1] : '';
    if (!ASG_WORD_CHAR.test(prev) && asgEndingOk(t, anchorEnd)) {
      const from = Math.max(0, idx - ASG_NEAR);
      const to = Math.min(t.length, anchorEnd + ASG_NEAR);
      let start = idx;
      let end = anchorEnd;
      let ok = true;
      for (const w of rest) {
        const at = asgFindInWindow(t, w, from, to);
        if (at === -1) {
          ok = false;
          break;
        }
        start = Math.min(start, at);
        end = Math.max(end, at + w.length);
      }
      // между словами ключа не должно быть запятой — иначе это разные компоненты
      if (ok && /[,;]/.test(t.slice(start, end))) ok = false;
      if (ok) out.push({ start, end });
    }
    idx = anchorEnd;
  }
  return out;
}

// Границы одного компонента в перечне: запятая, точка с запятой, конец фразы.
// Исключение относится только к тому компоненту, где найдено совпадение:
// «сахар, краситель сахарный колер» — сахар тут настоящий, а «сахарный колер»
// относится к красителю в соседнем пункте.
function asgSegment(t, start, end) {
  let from = start;
  while (from > 0 && !/[,;:.!?()«"]/.test(t[from - 1])) from--;
  let to = end;
  while (to < t.length && !/[,;:.!?()«"]/.test(t[to])) to++;
  return t.slice(from, to);
}

// Контекстные слова должны быть словами, а не подстроками: «нот» означает
// вкусовые ноты, но подстрока «нот» сидит внутри «ра-зно-травье» и гасит
// настоящие совпадения («мёд луговой (разнотравье)»). Однословные правила
// ищем с начала слова и без нового корня, многословные — как фразы.
function asgContextBlocked(t, start, end, cx) {
  const segment = asgSegment(t, start, end);
  for (const c of cx) {
    if (c.phrase) {
      if (segment.includes(c.phrase)) return true;
      continue;
    }
    const at = asgFindInWindow(segment, c.word, 0, segment.length);
    if (at !== -1) return true;
  }
  return false;
}

// Все вхождения ключевых слов с учётом фильтров.
// Контекстные слова («ноты», «привкус») работают в широком окне: они указывают
// на вкусовое описание. Слова-исключения — только вплотную к совпадению.
function asgCollect(text, settings) {
  const t = asgTranslit(asgNorm(text));
  const zdef = (settings && settings.zones) || {};
  const ex = ((settings && settings.excludes) || []).map((e) => asgTranslit(asgNorm(e))).filter(Boolean);
  const cx = ((settings && settings.contextExcludes) || [])
    .map((e) => asgNorm(e))
    .filter(Boolean)
    .map((e) => (e.indexOf(' ') === -1 ? { word: asgWordStem(e) } : { phrase: asgTranslit(e) }))
    .filter((c) => c.word || c.phrase);
  const occ = [];

  for (const z of ASG_ZONES) {
    for (const raw of zdef[z] || []) {
      const kwDisp = asgNorm(raw);
      if (!kwDisp) continue;
      const stems = asgKeywordStems(kwDisp);
      if (!stems.length) continue;
      const spans = asgSpansForStems(t, stems);
      for (const span of spans) {
        const blocked =
          asgContextBlocked(t, span.start, span.end, cx) ||
          asgNegatedBefore(t, span.start, ex) ||
          asgNegatedAfter(t, span.end, ex) ||
          asgNegatedAfterWords(t, span.end);
        if (!blocked) occ.push({ start: span.start, end: span.end, keyword: kwDisp, zone: z });
      }
    }
  }

  // Совпадение, полностью содержащееся в более длинном, отбрасываем:
  // «сахар» внутри «изомальтоолигосахарид» — это одно и то же слово,
  // а не сахар в составе. Правило действует между всеми зонами.
  return occ.filter(
    (o) =>
      !occ.some(
        (o2) =>
          o2 !== o &&
          o2.start <= o.start &&
          o2.end >= o.end &&
          o2.end - o2.start > o.end - o.start
      )
  );
}

// Зона товара: красная > оранжевая > жёлтая > зелёная.
// Вхождения дополняются описанием риска из справочника компонентов (components.js)
function asgAnalyze(text, settings) {
  const occ = asgCollect(text, settings);
  const zones = {};
  for (const z of ASG_ZONES) zones[z] = [];

  for (const o of occ) {
    const list = zones[o.zone];
    const hit = list.find((m) => m.keyword === o.keyword);
    if (hit) {
      hit.count++;
    } else {
      const info = typeof asgComponentInfo === 'function' ? asgComponentInfo(o.keyword) : null;
      list.push({
        keyword: o.keyword,
        count: 1,
        name: (info && info.name) || o.keyword,
        risk: (info && info.risk) || ''
      });
    }
  }

  let zone = 'green';
  if (zones.red.length) zone = 'red';
  else if (zones.orange.length) zone = 'orange';
  else if (zones.yellow.length) zone = 'yellow';

  // Один и тот же компонент может найтись по названию и по E-коду
  // («сорбат калия» + «E202») — сливаем в одну строку с суммарным числом.
  for (const z of ASG_ZONES) {
    const byName = new Map();
    const merged = [];
    for (const m of zones[z]) {
      const key = m.name || m.keyword;
      const hit = byName.get(key);
      if (hit) {
        hit.count += m.count;
      } else {
        byName.set(key, m);
        merged.push(m);
      }
    }
    zones[z] = merged;
  }

  const matches = [];
  for (const z of ASG_ZONES) {
    for (const m of zones[z]) {
      matches.push({
        zone: z,
        keyword: m.keyword,
        count: m.count,
        name: m.name,
        risk: m.risk
      });
    }
  }

  return {
    zone,
    zones,
    matches,
    marked: zone !== 'green',
    textLength: String(text || '').length
  };
}

// Короткий фрагмент текста вокруг найденного слова (для подсказки)
function asgSnippet(text, keyword, radius) {
  const r = radius || 60;
  const orig = asgNorm(text);
  const t = asgTranslit(orig);
  const kw = keyword ? asgTranslit(asgNorm(keyword)) : '';
  const idx = kw ? t.indexOf(kw) : -1;
  if (idx === -1) return orig.slice(0, r * 2);
  const from = Math.max(0, idx - r);
  const to = Math.min(orig.length, idx + kw.length + r);
  return (from > 0 ? '…' : '') + orig.slice(from, to) + (to < orig.length ? '…' : '');
}

// Продовольственная ли верхняя категория? Неизвестная категория — не блокируем.
function asgIsFoodCategory(name, foodCategories) {
  const n = asgNorm(name);
  const cats = (foodCategories || []).map(asgNorm).filter(Boolean);
  if (!n || !cats.length) return true;
  return cats.some((c) => n.includes(c));
}
