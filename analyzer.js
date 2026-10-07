// Анализ текста по ключевым словам в зонах риска (background service worker)

const ASG_ZONES = ['red', 'orange', 'yellow', 'green'];

// Чем меньше ранг, тем опаснее зона
const ASG_ZONE_RANK = { red: 0, orange: 1, yellow: 2, green: 3 };

function asgNorm(t) {
  return String(t || '')
    // невидимые символы внутри слов ломают и сопоставление ключевых слов,
    // и границу слова: убираем на входе
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '')
    .toLowerCase()
    // «E 952», «Е-952», «(E–952)» → «e952»: код добавки пишут с разделителем,
    // и без нормализации поиск по ключевым словам его не находил.
    // Разделитель внутри слова не склеиваем: «изделие 500» не станет «изделие500».
    .replace(/(^|[^a-zа-яё0-9])[eе]\s*[-–—]?\s*(\d{3})(?!\d)/g, '$1e$2')
    .replace(/\s+/g, ' ')
    .trim();
}

// Транслитация похожих символов (Е952/е952 -> e952), чтобы поиск E-кодов
// не зависел от кириллицы/латиницы. Замещения 1:1 — индексы сохраняются.
// Один проход с картой вместо цепочки replace: функцию вызывают постоянно,
// и шесть промежуточных строк на каждый выход — заметная часть работы
// анализатора на тексте страницы.
const ASG_TRANSLIT_MAP = { а: 'a', е: 'e', о: 'o', с: 'c', р: 'p', в: 'b' };
const ASG_TRANSLIT_RE = /[аеосрв]/g;

function asgTranslit(t) {
  return t.replace(ASG_TRANSLIT_RE, (ch) => ASG_TRANSLIT_MAP[ch]);
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

// Слово-исключение из 5 и более букв сравнивается и по началу слова: так
// «заменитель» ловит «заменители», «заменителей», а корень «замен» — все
// «заменител…». Короткие слова («без») сравниваются строго, иначе «безвредный
// сахар» погасил бы настоящее совпадение.
const ASG_MIN_PREFIX_EXCLUDE = 5;

// Связка внутри одного слова: дефис, тире, косая черта, вертикальная черта.
// Пробел и запятая сюда не входят намеренно — они отделяют следующий
// компонент состава, а не этот.
const ASG_NEG_SEPARATOR_RE = /[-–—/\\|]/;

function asgExcludeWordHit(word, excludes) {
  for (const e of excludes) {
    if (word === e) return true;
    if (e.length >= ASG_MIN_PREFIX_EXCLUDE && word.indexOf(e) === 0) return true;
  }
  return false;
}

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
    if (asgExcludeWordHit(w, excludes)) return true;
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

// Отрицание сразу после совпадения: «сахар-заменитель», «сахар / заменитель».
// Совпадение всегда заканчивается на границе слова, поэтому «сахарозаменитель»
// сюда не попадает — его отсекает ограничение на длину окончания
// (ASG_MAX_ENDING).
// Связкой считаем только дефис, тире, косую и вертикальную черту (пробелы рядом
// с ними допустимы). Голый пробел и запятая — это уже следующий компонент: в
// «фиников без сахара» «без» относится к сахару, а «финики» обязаны остаться.
function asgNegatedAfter(t, end, excludes) {
  if (!excludes.length) return false;
  let j = end;
  while (j < t.length && ASG_WORD_CHAR.test(t[j])) j++;
  let p = j;
  while (p < t.length && /\s/.test(t[p])) p++;
  if (p >= t.length || !ASG_NEG_SEPARATOR_RE.test(t[p])) return false;
  let k = p;
  while (k < t.length && (ASG_NEG_SEPARATOR_RE.test(t[k]) || /\s/.test(t[k]))) k++;
  let m = k;
  while (m < t.length && ASG_WORD_CHAR.test(t[m])) m++;
  const next = t.slice(k, m);
  if (!next) return false;
  return asgExcludeWordHit(next, excludes);
}

// Отрицание, стоящее после совпадения: «мёда в составе нет», «сахара не содержит».
// «без» сюда намеренно не входит: в связке «мёд без сахара» оно относится
// к сахару, а не к мёду.
// Голое «не» тоже не входит: «аспартам не рекомендуется детям» — это не
// отрицание наличия. Из «не» признаётся только связка с глаголом наличия.
const ASG_POST_NEGATIONS = ['нет', 'нету', 'отсутствует', 'отсутств', 'исключен', 'исключён'];

const ASG_POST_NEG_VERBS = ['содерж', 'содержащ', 'имеет', 'обнаруж', 'найден', 'использ'];

// Текст в анализе транслитерирован, значит и списки должны быть в той же форме.
// Считаем один раз: раньше это выполнялось на каждое совпадение.
const ASG_POST_NEGATIONS_T = ASG_POST_NEGATIONS.map((w) => asgTranslit(w));
const ASG_POST_NEG_VERBS_T = ASG_POST_NEG_VERBS.map((w) => asgTranslit(w));

function asgNegatedAfterWords(t, end) {
  let tail = t.slice(end, end + 48);
  // Закрывающая скобка сразу после совпадения — артефакт разметки
  // («мёд) не содержит»), отрицание относится к тому же компоненту
  tail = tail.slice(/^\s*[)\]»]*/.exec(tail)[0].length);
  // А вот запятая — это уже следующий компонент: в «финики, сахар не
  // используется» «не» относится к сахару, а не к финикам
  const cut = tail.search(/[,;:.!?()«"]/);
  if (cut >= 0) tail = tail.slice(0, cut);
  const words = (tail.match(ASG_WORD_RE) || []).slice(0, 4);
  if (!words.length) return false;
  if (words.some((w) => ASG_POST_NEGATIONS_T.includes(w))) return true;
  for (let i = 0; i + 1 < words.length; i++) {
    if (words[i] !== ASG_NEG_WORD) continue;
    for (const v of ASG_POST_NEG_VERBS_T) {
      if (words[i + 1].indexOf(v) === 0) return true;
    }
  }
  return false;
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

// Конец полного слова, начавшегося в pos. Совпадение ищем по основе
// («сорбит» ⊂ «сорбитол»), но в отчёте показываем слово целиком: по
// «Сорбит (E420) [сорбит]» не видно, что в составе написано «сорбитол».
function asgWordEndAt(t, pos) {
  let j = pos;
  while (j < t.length && ASG_WORD_CHAR.test(t[j])) j++;
  return j;
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
      let end = asgWordEndAt(t, anchorEnd);
      let ok = true;
      for (const w of rest) {
        const at = asgFindInWindow(t, w, from, to);
        if (at === -1) {
          ok = false;
          break;
        }
        start = Math.min(start, at);
        end = Math.max(end, asgWordEndAt(t, at + w.length));
      }
      // между словами ключа не должно быть запятой — иначе это разные компоненты
      if (ok && /[,;]/.test(t.slice(start, end))) ok = false;
      if (ok) out.push({ start, end, word: t.slice(start, end) });
    }
    idx = anchorEnd;
  }
  return out;
}

// Границы одного компонента в перечне: запятая, точка с запятой, конец фразы.
// Исключение относится только к тому компоненту, где найдено совпадение:
// «сахар, краситель сахарный колер» — сахар тут настоящий, а «сахарный колер»
// относится к красителю в соседнем пункте.
// Радиус ограничен: в тексте без запятых сегментом становилась вся страница,
// и одно слово в её конце гасило все совпадения.
const ASG_SEGMENT_RADIUS = 120;

function asgSegment(t, start, end) {
  let from = start;
  const minFrom = Math.max(0, start - ASG_SEGMENT_RADIUS);
  while (from > minFrom && !/[,;:.!?()«"]/.test(t[from - 1])) from--;
  let to = end;
  const maxTo = Math.min(t.length, end + ASG_SEGMENT_RADIUS);
  while (to < maxTo && !/[,;:.!?()«"]/.test(t[to])) to++;
  return t.slice(from, to);
}

// Контекстные слова должны быть словами, а не подстроками: «нот» означает
// вкусовые ноты, но подстрока «нот» сидит внутри «ра-зно-травье» и гасит
// настоящие совпадения («мёд луговой (разнотравье)»). Однословные правила
// ищем с начала слова и без нового корня, многословные — как фразы,
// /выражение/ — как регулярное выражение по тому же (транслитерированному) тексту.
function asgContextBlocked(t, start, end, cx) {
  const segment = asgSegment(t, start, end);
  for (const c of cx) {
    if (c.re) {
      if (c.re.test(segment)) return true;
      continue;
    }
    if (c.phrase) {
      if (segment.includes(c.phrase)) return true;
      continue;
    }
    for (const w of c.words || []) {
      if (asgFindInWindow(segment, w, 0, segment.length) !== -1) return true;
    }
  }
  return false;
}

// Сколько первых букв основы искать как отдельный вариант. Нужно для слов
// с беглой гласной: основа «углеводов» не входит в «углеводы», а «углев» — входит.
const ASG_CONTEXT_PREFIX = 5;

function asgContextEntry(raw) {
  const e = asgNorm(raw);
  if (!e) return null;
  if (e.length > 2 && e[0] === '/' && e[e.length - 1] === '/') {
    // текст для проверки транслитерирован, поэтому и выражение переводим
    // в ту же форму: кириллическое «е» → латинское «e»
    try {
      return { re: new RegExp(asgTranslit(e.slice(1, -1)), 'i') };
    } catch (err) {
      return null;
    }
  }
  if (e.indexOf(' ') !== -1) return { phrase: asgTranslit(e) };
  const stem = asgWordStem(e);
  if (!stem) return null;
  const head = stem.slice(0, ASG_CONTEXT_PREFIX);
  const words = head && head !== stem ? [stem, head] : [stem];
  return { words };
}

// Подготовка правил анализа по настройкам (собирается один раз).
// Ключевые слова идут от опасных зон к безопасным: при равных совпадениях
// порядок влияет на то, какая запись победит в asgCollect, и он должен быть
// предсказуемым.
function asgPrepare(settings) {
  if (asgPrepCache && asgPrepCache.settings === settings) return asgPrepCache;
  const zdef = (settings && settings.zones) || {};
  const keywords = [];
  for (const z of ASG_ZONES) {
    for (const raw of zdef[z] || []) {
      const disp = asgNorm(raw);
      if (!disp) continue;
      const stems = asgKeywordStems(disp);
      if (!stems.length) continue;
      keywords.push({ disp, stems, zone: z });
    }
  }
  const ex = ((settings && settings.excludes) || [])
    .map((e) => asgTranslit(asgNorm(e)))
    .filter(Boolean);
  const cx = ((settings && settings.contextExcludes) || [])
    .map(asgContextEntry)
    .filter(Boolean);
  asgPrepCache = { settings, keywords, ex, cx };
  return asgPrepCache;
}

// Подготовленные правила для анализа: основы ключевых слов, слова-исключения,
// контекстные правила. Собираются один раз на набор настроек — иначе на каждый
// вызов asgAnalyze заново считаются основы всех ~50 ключевых слов, нормализуются
// списки и создаются регулярные выражения пользовательских правил.
// Ключ кэша — сами настройки: при их смене меняется и ссылка на объект.
let asgPrepCache = null;

// Все вхождения ключевых слов с учётом фильтров.
// Контекстные слова («ноты», «привкус») работают в широком окне: они указывают
// на вкусовое описание. Слова-исключения — только вплотную к совпадению.
function asgCollect(text, settings) {
  const src = asgNorm(text);
  const t = asgTranslit(src);
  const prep = asgPrepare(settings);
  const occ = [];

  for (const kw of prep.keywords) {
    for (const span of asgSpansForStems(t, kw.stems)) {
      const blocked =
        asgContextBlocked(t, span.start, span.end, prep.cx) ||
        asgNegatedBefore(t, span.start, prep.ex) ||
        asgNegatedAfter(t, span.end, prep.ex) ||
        asgNegatedAfterWords(t, span.end);
      if (!blocked) {
        occ.push({
          start: span.start,
          end: span.end,
          keyword: kw.disp,
          zone: kw.zone,
          // само найденное слово из исходного текста (транслитерация в отчёте
          // нечитаема), нужно для разбора ложных срабатываний
          word: src.slice(span.start, span.end)
        });
      }
    }
  }

  // Совпадение, полностью содержащееся в более длинном, отбрасываем:
  // «сахар» внутри «изомальтоолигосахарид» — это одно и то же слово,
  // а не сахар в составе. Правило действует между всеми зонами.
  // Отрезки одинаковой длины не взаимно уничтожаются: остаётся одно вхождение —
  // более специфичное слово («сахарин» вместо «сахар» при том же отрезке),
  // при равной длине — из более опасной зоны. Иначе «медовый» давал две записи
  // («мед» и «медов») и задвоенный счётчик.
  return occ.filter(
    (o) =>
      !occ.some((o2) => {
        if (o2 === o) return false;
        if (o2.start > o.start || o2.end < o.end) return false; // не содержит o
        const lenO = o.end - o.start;
        const lenO2 = o2.end - o2.start;
        if (lenO2 > lenO) return true;
        if (lenO2 < lenO) return false;
        if (o2.start !== o.start) return false;
        if (o2.keyword.length !== o.keyword.length) {
          return o2.keyword.length > o.keyword.length;
        }
        const r2 = ASG_ZONE_RANK[o2.zone];
        const r = ASG_ZONE_RANK[o.zone];
        if (r2 !== r) return r2 < r;
        // детерминированность: одинаковые записи не гасят друг друга
        return String(o2.keyword) < String(o.keyword);
      })
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
        // что именно совпало в тексте — нужно для отчёта: по одному ключевому
        // слову нельзя понять, мёд это или часть другого слова
        word: o.word || o.keyword,
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
        word: m.word || m.keyword,
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

// Проверка продовольственной категории живёт в defaults.js
// (asgCategoryDecision): её использует и content script, где analyzer.js
// не подключён.
