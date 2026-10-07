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

// Подпись непищевого состава: «Состав материала», «Состав ткани», а также
// характеристики «Материал» и «Ткань». У одежды на Ozon подпись именно такая
// («Состав материала 40% фибра, 23% спандекс, 20% шерсть, 17% акрил»), и
// страница попадала в анализ как карточка продукта питания.
const ASG_MATERIAL_LABEL =
  /состав\s+(материал|ткан|издели|верха|подкладк)|^\s*(материал|материал\s+изделия|ткань)\s*[:—-]?\s*$/i;
// Начало подписи «Состав» вместе со значением в том же элементе:
// «Состав: концентрат сывороточного белка, …». Хвост не ограничен по длине.
const ASG_COMPOSITION_PREFIX =
  /^\s*(?:состав|ингредиенты|ингредиент[ы]?|ingredients|composition)\s*[:—-]\s*/i;

const ASG_MAX_COMPOSITION = 1500;
// Минимальная длина текста, который вообще может быть составом. Граница общая
// для извлекателя и для выбора источника в фоне (pickSource): если пороги
// разойдутся, достоверный состав не попадёт в анализ.
const ASG_MIN_COMPOSITION = 8;
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
  return String(t || '')
    // Ozon местами лепит невидимые символы: с zero-width после «Состав:»
    // строгая проверка подписи не проходит и настоящий состав теряется
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

// Признаки того, что блок «Состав» существует формально, но не содержит состава.
// «Состав:» — заглушка только когда после подписи ничего нет: значение вида
// «Состав: сорбитол, аспартам, лимонная кислота» — это настоящий состав,
// и раньше проба называла его заглушкой.
const ASG_EMPTY_COMPOSITION =
  /^(не указан|нет данных|нет\s|по запросу|см\.?\s|уточняйте|на упаковке|упаковке|изготовител|состав не|данные отсутствуют|информация|состав:\s*$)/i;

// Значение целиком из пунктиров: «—», «-.», «— —».
// Отдельное правило, а не часть ASG_EMPTY_COMPOSITION: перечень вкусов на Ozon
// начинается с тире («- глазурь молочно-шоколадная…»), и раньше такое значение
// отбрасывалось как заглушка «—», то есть настоящий состав терялся.
const ASG_PUNCT_ONLY = /^[—–\-·•.\s]+$/;

// Подпись «Состав» может быть приклеена к значению («Состав: уточняйте по
// запросу»), поэтому заглушку ищем и по тексту без подписи.
const ASG_LABEL_PREFIX = /^\s*состав\s*:\s*/i;

function asgIsEmptyComposition(t) {
  if (ASG_EMPTY_COMPOSITION.test(t) || ASG_PUNCT_ONLY.test(t)) return true;
  const stripped = t.replace(ASG_LABEL_PREFIX, '');
  return stripped !== t && asgIsEmptyComposition(stripped);
}

// Хвост из рекламы и условий хранения, который Ozon ставит следом за перечнем
// вкусов: «Условия хранения: … Участвуйте в акции магазина: скидка 20%».
// Обрезаем его: одна рекламная строка отбрасывала весь перечень — и по причине
// «похоже на рекламу». Ни одно из этих слов в составе ингредиентов не встречается.
const ASG_PROMO_TAIL =
  /(отзыв|рекоменд|услови\s+хранения|хранени|гарант|доставк|акци|скидк|промокод|купон|бонус|распродаж|участвуйте|отзывы)/i;

// Хвост с пищевой ценностью: Ozon дописывает его следом за перечнем ингредиентов
// («Содержание (расчётное) в 100 г: …, общего сахара 2,0 г»). Это не состав:
// у сахарной халвы там суммарные сахара из подсластителя-изомальта, и вердикт
// по «сахару» получался бы неверным. Объявлено здесь, рядом с рекламным
// хвостом: обе проверки работают в одной функции (asgTrimCompositionTails),
// и разносить их по файлу нельзя — правила разъедутся.
const ASG_NUTRITION_TAIL =
  /(содержание\s*[(（]|содержание\s+на\s*100|пищевая\s+ценность|питание\s+на|энергетическая\s+ценность|углеводы\b\s*:)/i;

// Начало с рекламной фразы «не содержит сахара и пальмового масла. Батончик…» —
// это не заглушка, а настоящий состав, у которого первая фраза рекламная.
// Такие кандидаты отбрасываем, только если за фразой нет перечня ингредиентов.
const ASG_COMPOSITION_CLAIM = /^(не содержит|не содержит\s|не имеет|не включает|без\s)/i;

// Глубина вложенности скобок в начале текста: сколько групп «открыто» на
// позиции i. Используется, чтобы не резать состав посреди перечня.
function asgBracketDepthAt(text, limit) {
  let depth = 0;
  const end = Math.min(limit, text.length);
  for (let i = 0; i < end; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') {
      if (depth > 0) depth--;
    }
  }
  return depth;
}

// Убрать хвост из рекламы и пищевой ценности — обе проверки нужны в одном
// месте, иначе правила разъезжаются: диагностика объясняла бы отказ по
// тексту, который в анализ уже не попадал.
function asgTrimCompositionTails(raw) {
  let t = asgCollapse(raw);
  t = asgCutTail(t, ASG_NUTRITION_TAIL, 20);
  t = asgCutTail(t, ASG_PROMO_TAIL, 20);
  return t;
}

// Отрезать рекламный или пищевой хвост, не разрывая перечень.
//
// Проблема, из-за которой появилась эта проверка: у батончиков «Умные сладости»
// Ozon пишет «начинка кокосовая (кондитерская начинка без сахара белая
// (жиры нелауринового типа на основе рафинированного кокосового масла,
// ПИЩЕВАЯ ЦЕННОСТЬ на 100 г: …». Слово «пищевая ценность» оказалось внутри
// незакрытой скобки, но правило резало по нему как по границе блока —
// перечень обрывался на середине слова, и анализ получал состав с незакрытой
// группой (в диагностике глубина скобок 2 при четырёх открытых).
//
// Что делаем: граница хвоста должна быть на целом числе закрытых скобок.
// Если в точке маркера есть незакрытая группа, режем там, где она
// закрывается, — так остаток перечня внутри скобок сохраняется. Откат назад
// к последней закрытой позиции пробовали: он выбрасывал всю начинку целиком
// и давал 217 символов вместо 326, то есть терял больше, чем возвращал.
//
// Если группа не закрывается до конца текста, резать нечем: оставляем всё.
  // Тогда в анализ попадут числа пищевой ценности, но потерять перечень
  // ингредиентов хуже — вердикт по усечённому составу недостоверен.
  //
  // Известное ограничение: у батончиков «Умные сладости» сама страница пишет
  // неухожденный текст — «пищевая ценность» стоит внутри ещё не закрытой
  // группы, и закрывается скобка только в самом конце элемента. Тогда хвост
  // остаётся в составе. Это осознанный размен: «общего сахара 2 г» из
  // пищевой ценности дал бы ложную красную зону, а потеря ингредиентов
  // делает весь вердикт недостоверным.
function asgCutTail(text, re, minIndex) {
  const floor = minIndex || 20;
  if (!re) return text;
  const m = re.exec(text);
  if (!m || m.index <= floor) return text;
  const at = m.index;
  if (asgBracketDepthAt(text, at) === 0) return asgCollapse(text.slice(0, at));

  // Граница приходится внутрь незакрытой группы. Ищем место, где группа
  // закроется, и режем по нему: так сохраняется остаток перечня внутри скобок.
  const close = asgBracketCloseAt(text, at);
  return close > floor ? asgCollapse(text.slice(0, close)) : text;
}

/**
 * Позиция, на которой скобки вернутся к нулю, если двигаться от позиции from.
 * -1 — закрытия на всём остатке текста нет.
 */
function asgBracketCloseAt(text, from) {
  let depth = asgBracketDepthAt(text, from);
  if (depth === 0) return from;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') {
      if (depth > 0) depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

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

// Начала блоков, которые не состав ни при каком расположении: отзывы,
// рекомендации, реклама. Отличаются от ASG_NOT_COMPOSITION тем, что смотрят
// только на начало текста, поэтому остаются в силе и в мягком режиме.
const ASG_NOT_COMPOSITION_HEAD =
  /^(отзыв|рейтинг|рекоменд|доставк|куп|скидк|бонус|акци|распродаж|подборк|сравнени)/iu;

// Оценка «похоже ли значение на состав». Метка «Состав» — главный сигнал,
// поэтому проверяем, что это не цена/доставка/отзывы и что это перечисление.
// Возвращаем число частей (больше — надёжнее) или -1, если это не состав.
// lenient — значение стоит прямо рядом с найденной подписью «Состав»: тогда
// даже упоминание «отзыв» или «рекомендов» внутри текста не приговор (такие
// пометки пишут в самом составе), а вот структурные проверки остаются.
function asgCompositionScore(text, maxLen, lenient, allowSingle) {
  const t = asgCollapse(text);
  const cap = maxLen || ASG_MAX_COMPOSITION;
  if (t.length < ASG_MIN_COMPOSITION || t.length > cap) return -1;
  if (!lenient && ASG_NOT_COMPOSITION.test(t)) return -1;
  if (ASG_NOT_COMPOSITION_HEAD.test(t)) return -1;
  if (asgIsEmptyComposition(t)) return -1;
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
  // Перечень — два и более пункта либо компонент с количеством. Одиночный
  // компонент («пюре яблочное») составом тоже является, но только когда стоит
  // рядом с подписью: издалека одна фраза — это не перечень.
  if (!asgIngredientListLike(t) && !allowSingle) return -1;
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

// Почему текст не признан составом: имя правила или пустая строка.
// Нужно для отчёта «Диагностика», чтобы не гадать, какая проверка сработала.
function asgCompositionReject(text, maxLen) {
  // Те же хвосты, что отрезает add(): иначе диагностика объясняет отказ по
  // тексту, который в анализ уже не попадал
  let collapsed = asgTrimCompositionTails(String(text || ''));
  const t = collapsed;
  const cap = maxLen || ASG_MAX_COMPOSITION;
  if (t.length < ASG_MIN_COMPOSITION) return 'слишком короткий';
  if (t.length > cap) return 'длиннее ' + cap + ' символов';
  if (ASG_NOT_COMPOSITION.test(t)) {
    const m = /(отзыв|рейтинг|доставк|гарант|₽|руб|скидк|акци|бонус|пункт выдачи|купить|в корзин|посмотреть|сравнить|ваша корзин|рассрочк|баллы|рекомендов)/i.exec(t);
    return 'похоже на рекламу или отзывы: «' + (m ? m[0] : '?') + '»';
  }
  if (asgIsEmptyComposition(t)) return 'заглушка «нет данных / по запросу»';
  if (ASG_NOT_COMPOSITION_START.test(t)) return 'строка характеристики или рекламы';
  if (ASG_COMPOSITION_CLAIM.test(t) && !asgLooksLikeList(t)) return 'рекламное начало без перечня';
  if (!asgIngredientListLike(t)) return 'нет перечня: одна часть без количества';
  const s = asgCompositionScore(t, cap);
  return s > 0 ? '' : 'не похоже на перечень';
}

// Скобки в составе: сколько открывающих, закрывающих и какова глубина
// вложенности в конце текста. Глубина > 0 означает, что текст обрывается внутри
// незакрытой группы.
function asgCompositionBrackets(text) {
  const t = asgCollapse(text);
  let open = 0;
  let close = 0;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '(' || ch === '«' || ch === '[') {
      open++;
      depth++;
    } else if (ch === ')' || ch === '»' || ch === ']') {
      close++;
      if (depth > 0) depth--;
    }
  }
  return { open, close, depth };
}

// Похож ли состав на завершённый: нет обрыва на запятой/союзе и внутри
// незакрытой скобки. Обрезанный состав (например «…глазурь (сахар») нельзя
// считать достоверным: в нём обрезаны и слова, и их окончания.
// Считаем именно глубину вложенности, а не равенство числа скобок: лишняя
// закрывающая скобка или опечатка в середине длинного состава обрывом не
// является. Раньше равенство требовалось строго, и из-за одной такой скобки
// терялся вердикт по полному составу: блок «Состав» найден, 32 компонента,
// опасные вещества перечислены, а флаг показывал «Состав не подтверждён».
function asgCompositionWellFormed(text) {
  const t = asgCollapse(text);
  // короткий состав из одного компонента («пюре яблочное») — завершённый
  if (t.length < ASG_MIN_COMPOSITION) return false;
  if (asgCompositionBrackets(t).depth > 0) return false;
  if (/[,;:]$/.test(t)) return false;
  // \b в JS не работает с кириллицей, поэтому границу задаём пробелом
  if (/(?:\s|^)(и|или|а|но|из|с|по|для|без|при|от)\s*$/i.test(t)) return false;
  return true;
}

// Похож ли текст на перечень ингредиентов, а не на обычную фразу.
// Настоящий состав — это список (2+ части через запятую/точку с запятой)
// либо компонент с количеством («кофе в зёрнах 100%»).
// Источники, которым можно верить: значение найдено по подписи «Состав» —
// рядом с ней, в её контейнере, в атрибутах или в состоянии страницы.
// Нельзя: весь текст родителя, блок после него и скан текста страницы, где
// попадает и реклама, и описание товара.
function asgTrustedComposition(tier) {
  return (
    tier === ASG_TIER_SELECTOR ||
    tier === ASG_TIER_SAME ||
    tier === ASG_TIER_SIBLING ||
    tier === ASG_TIER_ATTRIBUTE ||
    tier === ASG_TIER_CONTAINER ||
    tier === ASG_TIER_JSON
  );
}

// Группы надёжности для сравнения кандидатов. Внутри группы форма значения
// важнее номера источника, между группами — наоборот: значение рядом с подписью
// «Состав» не должно проигрывать перечню, собранному сканом всей страницы.
function asgTierGroup(tier) {
  if (tier <= ASG_TIER_SAME) return 1; // значение вплотную к подписи
  if (tier <= ASG_TIER_PARENT_SIBLING) return 2; // рядом с подписью
  if (tier <= ASG_TIER_JSON) return 3; // атрибуты, контейнер, состояние страницы
  return 4; // текстовый скан всей страницы
}

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

  // в <dl> значение иногда не соседний узел, а следующий <dd> того же родителя
  if (el.tagName === 'DT' && el.parentElement) {
    const dd = el.parentElement.querySelector('dd');
    if (dd && dd !== el.nextElementSibling) add(dd.textContent, ASG_TIER_SIBLING);
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

// Элементы, в которых вообще может стоять подпись «Состав».
// Один список на поиск кандидатов и на быструю проверку подписи, чтобы
// правила не разъезжались.
const ASG_LABEL_ELEMENT_SEL =
  'b, strong, span, div, h1, h2, h3, h4, h5, h6, dt, dd, label, p, li, summary, td, th';

// Максимум дочерних элементов у узла, который ещё может быть подписью со
// значением («Состав: сорбитол, …»). Крупный контейнер перечнем быть не может,
// а обход его textContent — самая дорогая операция на тяжёлой странице.
const ASG_MAX_LABEL_CHILDREN = 40;

// Текст элемента, если он заведомо небольшой. Возвращает null для крупных
// контейнеров: у них не бывает склеенной подписи и значения, а полный обход
// поддерева (textContent) для сотен вложенных div — это лишние мегабайты
// строк и регулярных выражений на каждом извлечении.
function asgElementText(el) {
  if (!el) return null;
  if (el.childElementCount > ASG_MAX_LABEL_CHILDREN) return null;
  const first = el.firstChild;
  if (first && first.nodeType === 3 && !first.nextSibling) {
    // один текстовый узел — самый частый случай, поддерево не обходим
    return first.nodeValue || '';
  }
  return el.textContent;
}

// Один проход по подписям: есть ли на странице пищевой «Состав» и есть ли
// «Состав материала» (одежда, текстиль). Результат нужен, чтобы решить, ждать
// ли появления состава, и чтобы не оценивать непищевой товар.
// Подпись считается пищевой только строгой проверкой (ASG_COMPOSITION_LABEL):
// в 1.5.0 здесь стояло /^состав/i, и «Состав материала» принимался за состав
// продукта — расширение ждало появления еды на странице перчаток.
function asgScanCompositionLabels(doc) {
  const out = { composition: false, material: false };
  try {
    for (const el of doc.querySelectorAll(ASG_LABEL_ELEMENT_SEL)) {
      const raw = asgElementText(el);
      if (raw === null) continue;
      const t = asgCollapse(raw);
      if (!t || t.length > 400) continue;
      const looksLikeComposition = /^состав|^ингредиент|^ingredients|^composition/i.test(t);
      const looksLikeMaterial = ASG_MATERIAL_LABEL.test(t);
      if (!looksLikeComposition && !looksLikeMaterial) continue;
      if (looksLikeMaterial) out.material = true;
      if (looksLikeComposition && ASG_COMPOSITION_LABEL.test(t)) out.composition = true;
      if (out.composition && out.material) break;
    }
  } catch (e) { /* ignore */ }
  return out;
}

// Есть ли на странице подпись пищевого состава (без диагностики: результат
// нужен каждый раз, когда решается, ждать ли появления блока).
function asgHasCompositionLabel(doc) {
  return asgScanCompositionLabels(doc).composition;
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
    const els = doc.querySelectorAll(ASG_LABEL_ELEMENT_SEL);
    for (const el of els) {
      const raw = asgElementText(el);
      if (raw === null) continue; // крупный контейнер: подписи со значением тут нет
      const t = asgCollapse(raw);
      if (!t) continue;
      // «Состав: <значение>» в одном элементе. Раньше такой элемент отбрасывался
      // по длине (значение состава всегда длиннее 120 символов) и строгой
      // проверке подписи, которой длинный хвост не соответствует.
      const pref = ASG_COMPOSITION_PREFIX.exec(t);
      if (pref) {
        found.push({ text: asgCollapse(t.slice(pref[0].length)), tier: ASG_TIER_SAME });
        continue;
      }
      if (t.length > 120 || !labelRe.test(t)) continue;
      for (const cand of asgLabeledValues(el, t, max)) found.push(cand);
    }
  } catch (e) { /* ignore */ }

  return found.filter(Boolean);
}

// Верхняя категория товара по хлебным крошкам.
// Возвращает { name, reliable }: reliable=true — крошки найдены однозначно,
// reliable=false — предположительно (использовать только как подсказку).
//
// Результат запоминаем на документ: обход всех ссылок страницы стоит
// десятки миллисекунд, а извлечение повторяется на каждой пачке изменений DOM.
// Ключ — адрес страницы, поэтому переход SPA на другой товар пересчитывает
// категорию заново.
const asgTopCategoryMemo = new WeakMap();

function asgTopCategoryMemoKey(doc) {
  try {
    return (doc.location && doc.location.href) || '';
  } catch (e) {
    return '';
  }
}

function asgTopCategoryCached(doc) {
  const key = asgTopCategoryMemoKey(doc);
  const hit = asgTopCategoryMemo.get(doc);
  if (hit && hit.key === key) return hit.value;
  const value = asgTopCategory(doc);
  asgTopCategoryMemo.set(doc, { key, value });
  return value;
}

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

  // 2) контейнер крошек по маркеру разметки: берём первую осмысленную ссылку
  // независимо от того, называется она «Главная» или нет.
  // У Ozon первая крошка — «Ozon», поэтому поиск от «Главной» (шаг 3) на
  // карточках Ozon не находил ничего: верхняя категория оставалась неизвестной,
  // и одежда с косметикой попадали в анализ как продукты питания.
  const crumbBoxes = doc.querySelectorAll(
    '[data-widget*="breadcrumb" i], [data-widget*="breadcrumbs" i],' +
    ' [aria-label*="breadcrumb" i], [aria-label*="хлеб" i],' +
    ' [class*="breadcrumb" i], [class*="crumb" i], [class*="хлеб" i]'
  );
  for (const box of crumbBoxes) {
    const links = Array.from(box.querySelectorAll('a[href]'));
    if (links.length < 2 || links.length > 12) continue;
    for (const l of links) {
      const t = asgCollapse(l.textContent).toLowerCase();
      if (!t || t.length > 60) continue;
      if (skip.has(t) || t === 'ozon' || t === 'озон' || t === 'market') continue;
      if (ASG_NAV_NOISE.test(t)) continue;
      return { name: t, reliable: true };
    }
  }

  // 3) контейнер крошек: список или элемент с маркером «breadcrumb»
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
  const patterns = [
    /"(?:состав|composition|ingredients?)"\s*:\s*"((?:[^"\\]|\\.){8,800})"/i,
    /"(?:состав|composition|ingredients?)"\s*:\s*\[((?:[^[\]]){8,800})\]/i,
    /"(?:состав|composition|ingredients?)"[\s\S]{0,300}?"(?:value|текст|описание|description)"\s*:\s*"((?:[^"\\]|\\.){8,800})"/i,
    /"(?:title|name|key|param)"\s*:\s*"(?:состав|composition|ingredients?)"[\s\S]{0,300}?"(?:value|текст)"\s*:\s*"((?:[^"\\]|\\.){8,800})"/i,
    /"(?:состав|composition|ingredients?)"[\s\S]{0,300}?"(?:value|текст|описание|description)"\s*:\s*\[((?:[^[\]]){8,800})\]/i
  ];

  const scan = (pool) => {
    if (!pool) return null;
    for (const re of patterns) {
      const m = re.exec(pool);
      if (!m) continue;
      let raw = m[1];
      if (raw.indexOf('","') !== -1) {
        raw = raw.replace(/["']/g, ' ').replace(/,/g, ', ');
      }
      const v = asgCollapse(raw.replace(/[{}[\]]/g, ' '));
      // значение найдено прямо рядом с подписью в данных страницы, поэтому
      // одиночный компонент («пюре яблочное») здесь допустим
      if (asgCompositionScore(v, ASG_MAX_COMPOSITION, true, true) > 0) return v;
    }
    return null;
  };

  // 1) Разметка целиком: состояние страницы лежит и в inline-скриптах, и в
  //    data-атрибутах, поэтому innerHTML — самый полный источник.
  let html = '';
  try {
    html = (doc.documentElement && doc.documentElement.innerHTML) || '';
  } catch (e) { /* ignore */ }
  const fromHtml = scan(html);
  if (fromHtml) return fromHtml;

  // 2) Только если разметка не дала результата — раскодируем \uXXXX в скриптах.
  //    Это дорого (до 400 КБ на скрипт), а содержимое inline-скриптов уже было
  //    в разметке: считаем второй раз только ради раскодированной кириллицы.
  for (const t of asgScriptTexts(doc)) {
    const v = scan(t);
    if (v) return v;
  }
  return null;
}

// Названия товара: одиночный «состав», совпадающий с названием, — это не
// состав. Сравниваем без знаков и регистра: «Гранола - Кранч шоколадные с
// клубникой и бананом Bionova» и заголовок страницы отличаются лишь хвостом.
function asgProductTitles(doc) {
  const out = [];
  const add = (t) => {
    const v = asgCollapse(t)
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (v.length >= 12) out.push(v);
  };
  try {
    const h1 = doc.querySelector('h1');
    if (h1) add(h1.textContent);
    // Заголовок документа — это doc.title (содержимое <title>).
    // documentElement.title — атрибут title у <html>, он почти всегда пустой,
    // из-за чего название страницы в сравнении не участвовало.
    add(doc.title || '');
  } catch (e) { /* ignore */ }
  return out;
}

function asgLooksLikeTitle(titles, text) {
  const raw = asgCollapse(text);
  const v = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (v.length < 12) return false;
  if (!titles.some((t) => t.indexOf(v) !== -1 || v.indexOf(t) !== -1)) return false;
  // Отбрасываем именно название, а не любой текст, совпавший с заголовком.
  // У названия — много слов и либо тире-разбивка («Гранола - Кранч
  // шоколадные с клубникой и бананом Bionova»), либо несколько слов с
  // заглавной. Короткий состав, который по закону совпадает с заголовком
  // («гречневая мука», «пюре яблочное»), остаётся составом.
  const words = v.split(' ').length;
  if (words < 4) return false;
  const caps = (raw.match(/(?:^|\s)[A-ZА-ЯЁ][^\s]*/g) || []).length;
  return /\s[-–—]\s/.test(raw) || caps >= 2;
}

// opts.skipDeep — не выполнять самые дорогие шаги (состояние страницы и скан
// всего текста). Они дают только слабые источники (tier 8 и 9), поэтому
// дешёвая проверка «появился ли настоящий блок «Состав»» их пропускает.
function asgFindComposition(doc, selectors, opts) {
  const cands = [];
  const skipDeep = !!(opts && opts.skipDeep);
  const titles = asgProductTitles(doc);
  // одиночный компонент отличаем от названия товара по заголовку страницы;
  // если заголовка нет, отличить нечем — и одиночную фразу не берём
  const mayBeSingle = titles.length > 0;
  const add = (text, tier) => {
    let t = asgCollapse(text);
    // прямые значения (рядом с подписью) допускаем длинными — ассорти с
    // несколькими вкусами иначе отбрасывается целиком; и оцениваем их мягче:
    // подпись «Состав» найдена, значит это её значение
    const direct = tier <= ASG_TIER_SIBLING;
    const cap = direct ? ASG_MAX_VALUE : ASG_MAX_COMPOSITION;
    // хвост «Содержание (расчётное) в 100 г: …» — это пищевая ценность,
    // а не состав: у сахарной халвы там «общего сахара 2 г», и это не сахар
    // хвост из пищевой ценности и рекламы отрезаем по границе блока, а не
    // посреди перечня: иначе «пищевая ценность» внутри незакрытой скобки
    // обрывал состав на середине (см. asgCutTail)
    t = asgTrimCompositionTails(t);
    const listLike = asgIngredientListLike(t);
    // одиночная фраза вместо состава, если она совпадает с названием товара
    if (!listLike && asgLooksLikeTitle(titles, t)) return;
    const parts = asgCompositionScore(t, cap, direct, direct && mayBeSingle);
    if (parts > 0) cands.push({ text: t, tier, parts, listLike: listLike });
  };

  // Кандидат, которого не может улучшить ни один следующий шаг: доверенный
  // источник, перечень и завершённость. Порядок сортировки ниже сравнивает
  // сначала надёжность источника, поэтому такой кандидат уже победитель —
  // а значит самые дорогие шаги (состояние страницы и текстовый скан всей
  // страницы) можно не выполнять. На тяжёлой карточке это экономит полную
  // сериализацию DOM и раскодирование всех inline-скриптов.
  const strongCandidate = () =>
    cands.some(
      (c) => asgTrustedComposition(c.tier) && c.listLike && asgCompositionWellFormed(c.text)
    );

  // 1) селекторы из настроек
  for (const sel of selectors || []) {
    if (!sel) continue;
    try {
      doc.querySelectorAll(sel).forEach((el) => add(el.textContent, ASG_TIER_SELECTOR));
    } catch (e) { /* некорректный селектор */ }
  }

// Что выполнили из дорогих шагов — видно в диагностике
  let deepScan = 'selector';
  if (!strongCandidate()) {
    deepScan = 'label';

    // 2) кандидаты по подписи «Состав». Шаг точный и недорогой, поэтому идёт
    //    первым: если он уже нашёл доверительный перечень, следующие два шага
    //    (поиск по атрибутам и обход контейнеров характеристик) можно не
    //    выполнять — они дают только более слабые источники (tier 6 и 7),
    //    а на тяжёлой карточке стоят дороже всех остальных шагов вместе.
    for (const c of asgLabeledCandidates(doc, ASG_COMPOSITION_LABEL, ASG_MAX_COMPOSITION)) {
      add(c.text, c.tier);
    }

    if (!strongCandidate()) {
      deepScan = 'attrs';

      // 3) элементы, у которых метка зашита в атрибуты
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

      if (!strongCandidate()) {
        deepScan = 'chars';

        // 4) внутри контейнеров характеристик
        try {
          const containers = doc.querySelectorAll(ASG_CHAR_CONTAINER_SEL);
          // Вложенные контейнеры дают те же элементы: без этого один и тот же
          // узел обрабатывался столько раз, на сколько контейнеров он попадает
          const seen = new WeakSet();
          for (const cont of containers) {
            const els = cont.querySelectorAll(
              'span, div, dt, dd, td, th, p, b, strong, li, label'
            );
            for (const el of els) {
              if (seen.has(el)) continue;
              seen.add(el);
              const raw = asgElementText(el);
              if (raw === null) continue;
              const t = asgCollapse(raw);
              if (!t || t.length > 60) continue;
              if (!/^состав\s*[:—-]?\s*$/i.test(t)) continue;
              for (const cand of asgLabeledValues(el, t, ASG_MAX_COMPOSITION)) {
                add(cand.text, Math.min(cand.tier, ASG_TIER_CONTAINER));
              }
            }
          }
        } catch (e) { /* ignore */ }

        if (!strongCandidate() && !skipDeep) {
          deepScan = 'full';

          // 5) JSON-состояние страницы
          const fromJson = asgCompositionFromSources(doc);
          if (fromJson) add(fromJson, ASG_TIER_JSON);

          // 6) текстовый скан всей страницы
          // Только с двоеточием: «Состав: …». Без двоеточия слово «состав» почти
          // всегда встречается в обычном тексте («по составу есть три источника
          // белка…»), и такой обрывок маркетинга раньше становился «составом».
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
        }
      }
    }
  }

  if (!cands.length) return null;
  // 1) доверие источнику — безусловно: значение, найденное по подписи «Состав»,
  //    не может проиграть обрывку, собранному сканом текста всей страницы,
  //    даже если тот выглядит перечнем (иначе одно-компонентный состав
  //    «пюре яблочное» на пастиле уходил в серый «не подтверждён»);
  // 2) внутри группы надёжности — форма значения: селектор из настроек не
  //    должен проигрывать [class*="spec"], но и одиночная фраза рядом с
  //    подписью не должна вытеснять перечень из того же блока;
  // 3) перечень лучше одиночного компонента;
  // 4) завершённость (обрезанный состав не берём, если есть целый);
  // 5) номер источника; 6) компактность; 7) число компонентов
  cands.sort((a, b) => {
    const trustedA = asgTrustedComposition(a.tier) ? 1 : 0;
    const trustedB = asgTrustedComposition(b.tier) ? 1 : 0;
    if (trustedA !== trustedB) return trustedB - trustedA;
    const ga = asgTierGroup(a.tier);
    const gb = asgTierGroup(b.tier);
    if (ga !== gb) return ga - gb;
    if (a.listLike !== b.listLike) return a.listLike ? -1 : 1;
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
    candidates: cands.length,
    deepScan,
    // список кандидатов для диагностики: что вообще рассматривалось и почему
    // выбран именно этот — снимает гадание по отчёту
    list: cands.slice(0, 8).map((c) => ({
      tier: c.tier,
      len: c.text.length,
      head: c.text.slice(0, 70)
    }))
  };
}

// Дешёвая проверка «появился ли блок «Состав» с настоящим значением».
// Пока страница дорисовывается, это спрашивается раз в секунду: полное
// извлечение обходило бы ещё и описание, категорию и текст страницы, а здесь
// нужен только факт появления значения рядом с подписью.
function asgProbeCompositionReady(doc, settings) {
  try {
    const sel = (settings && settings.selectors && settings.selectors.composition) || [];
    const comp = asgFindComposition(doc, sel, { skipDeep: true });
    if (!comp) return false;
    // слабые источники — те же, что и в asgWeakComposition у content script
    return comp.tier !== ASG_TIER_PARENT_SIBLING && comp.tier !== ASG_TIER_TEXT;
  } catch (e) {
    return false;
  }
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

// Описание для анализа: найденные блоки + JSON-LD + метатеги + заголовник.
// block — уже найденный блок «Описание»: asgExtractFromDoc вызывает эту функцию
// вместе с asgFindDescriptionBlock, и второй раз искать его незачем.
function asgFindDescription(doc, selectors, block) {
  const parts = [];
  const found = block !== undefined ? block : asgFindDescriptionBlock(doc, selectors);
  if (found) parts.push(found);
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
    // одиночный компонент отличаем от названия по заголовку страницы
    const mayBeSingle = asgProductTitles(doc).length > 0;
    const els = doc.querySelectorAll(ASG_LABEL_ELEMENT_SEL);
    for (const el of els) {
      const raw = asgElementText(el);
      if (raw === null) continue;
      const t = asgCollapse(raw);
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
        nextText: next ? asgCollapse(next.textContent).slice(0, 300) : '',
        // проходит ли соседний текст проверку состава и почему нет — чтобы по
        // отчёту было видно, кандидат отброшен или его просто не нашли
        nextScore: next
          ? asgCompositionScore(next.textContent, ASG_MAX_VALUE, true, mayBeSingle)
          : null,
        nextLen: next ? asgCollapse(next.textContent).length : 0,
        nextReject: next ? asgCompositionReject(next.textContent, ASG_MAX_VALUE) : null,
        parentTextLen: el.parentElement
          ? asgCollapse(el.parentElement.textContent).length
          : 0
      });
      if (out.labeled.length >= 8) break;
    }
  } catch (e) { /* ignore */ }

  return out;
}

// Итоговая выжимка со страницы товара.
// wantPageText: полный текст страницы нужен только там, где фон может взять
// его источником (состав не подтвердился) и в диагностике. Обход всех текстовых
// узлов на тяжёлой карточке — самая дорогая часть извлечения, а при
// подтверждённом составе он всё равно не используется.
function asgExtractFromDoc(doc, settings, wantPageText) {
  const max = (settings && settings.maxDescChars) || 20000;
  const out = {
    composition: null,
    description: null,
    descriptionBlock: null,
    // какие шаги поиска состава выполнялись (см. asgFindComposition):
    // selector | label | attrs | chars | full | none — видно в диагностике
    compositionDeepScan: 'none',
    hasComposition: false,
    hasDescriptionBlock: false,
    confident: false,
    // «Состав материала» на странице: одежда, текстиль — не продукт питания
    materialComposition: false,
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
    const cat = asgTopCategoryCached(doc);
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
      out.compositionCandidatesList = comp.list || [];
      out.compositionDeepScan = comp.deepScan || 'full';
    } else {
      out.composition = null;
      out.compositionTier = 0;
      out.compositionCandidates = 0;
      out.compositionCandidatesList = [];
      out.compositionDeepScan = 'none';
    }
  } catch (e) { /* ignore */ }
  // Блок описания ищется один раз: asgFindDescription берёт его же, а считать
  // дважды — значит платить за полный обход подписей дважды.
  try {
    out.descriptionBlock = asgFindDescriptionBlock(doc, descSelectors);
    out.description = asgFindDescription(doc, descSelectors, out.descriptionBlock);
  } catch (e) { /* ignore */ }

  out.hasComposition = !!out.composition;
  out.hasDescriptionBlock = !!out.descriptionBlock;
  out.confident = out.hasComposition || out.hasDescriptionBlock;
  // Непищевой товар: ищем подпись «Состав материала» только когда пищевого
  // состава нет — на остальных страницах признак не нужен, а обход подписей
  // стоит времени.
  if (!out.hasComposition) {
    try {
      out.materialComposition = asgScanCompositionLabels(doc).material;
    } catch (e) { /* ignore */ }
  }
  out.compositionParts = out.composition
    ? out.composition.split(/[,;]/).map((s) => s.trim()).filter(Boolean).length
    : 0;
  out.compositionWellFormed = asgCompositionWellFormed(out.composition || '');
  out.ingredientListLike = asgIngredientListLike(out.composition || '');
  // Источник — настоящий блок «Состава» (подпись, селектор, контейнер,
  // состояние страницы), даже если перечень не прошёл проверку завершённости.
  // Нужен, чтобы предупреждение (красный/оранжевый/жёлтый) можно было показать
  // и по неполному перечню: найденное вещество действительно в составе.
  out.compositionTrusted = out.hasComposition && asgTrustedComposition(out.compositionTier);
  // Скобки — для диагностики: по ним видно, почему перечень признан обрезанным
  out.compositionBrackets = out.hasComposition
    ? asgCompositionBrackets(out.composition)
    : null;
  // Состав из одного компонента («пюре яблочное») тоже достоверен, если стоит
  // рядом с подписью «Состав» и не повторяет название товара.
  out.singleComponent =
    out.hasComposition && !out.ingredientListLike && out.compositionParts === 1;
  out.compositionIsTitle =
    out.singleComponent && asgLooksLikeTitle(asgProductTitles(doc), out.composition || '');
  // Зелёный флаг доказуем только завершённым блоком «Состав», который при этом
  // выглядит как перечень ингредиентов. Описание — маркетинговый текст,
  // обрезанный состав может содержать обрыв слова, а обычная фраза с
  // подписью «Состав» — вовсе не перечень. Текст, собранный сканом страницы,
  // доказательством тоже не является: там легко попасть в описание.
  out.authoritative =
    out.hasComposition &&
    asgTrustedComposition(out.compositionTier) &&
    out.compositionWellFormed &&
    (out.ingredientListLike || (out.singleComponent && !out.compositionIsTitle));
  // Полный текст страницы собираем, только если он может стать источником
  // (состав не подтвердился) или явно запрошен — так идёт диагностика.
  if (wantPageText === true || !out.authoritative) {
    try {
      out.pageText = asgVisibleText(doc, max);
    } catch (e) { /* ignore */ }
  }
  return out;
}
