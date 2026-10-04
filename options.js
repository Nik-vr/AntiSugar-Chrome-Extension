const ZONE_NAMES = {
  red: 'Красная зона (высокий риск)',
  orange: 'Оранжевая зона (скрытые угрозы)',
  yellow: 'Жёлтая зона (компромиссы)',
  green: 'Зелёная зона (безопасно)'
};

const els = {};

document.addEventListener('DOMContentLoaded', async () => {
  for (const id of [
    'enabled', 'markClean', 'preferComposition', 'fetchStrategy',
    'foodCategories',
    'zone-red', 'zone-orange', 'zone-yellow', 'zone-green',
    'excludes', 'contextExcludes', 'hosts', 'sel-comp', 'sel-desc',
    'save', 'reset', 'save-msg',
    'test-url', 'test-btn', 'test-out', 'clear-cache', 'cache-info'
  ]) {
    els[id] = document.getElementById(id);
  }

  fillFrom(await chrome.storage.local.get(ASG_DEFAULTS));
  showCacheInfo();

  els.save.onclick = save;
  els.reset.onclick = async () => {
    await chrome.storage.local.set(ASG_DEFAULTS);
    fillFrom(ASG_DEFAULTS);
    flash('Сброшено (кэш очищен)');
    showCacheInfo();
  };
  els['test-btn'].onclick = runTest;
  els['clear-cache'].onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'clear-cache' });
    els['cache-info'].textContent = 'кэш очищен';
  };
});

function splitLines(v) {
  return String(v || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function fillFrom(s) {
  els.enabled.checked = !!s.enabled;
  els.markClean.checked = s.markClean !== false;
  els.preferComposition.checked = s.preferComposition !== false;
  els.fetchStrategy.value = s.fetchStrategy || 'auto';
  els.foodCategories.value = (s.foodCategories || []).join('\n');
  const z = s.zones || {};
  els['zone-red'].value = (z.red || []).join('\n');
  els['zone-orange'].value = (z.orange || []).join('\n');
  els['zone-yellow'].value = (z.yellow || []).join('\n');
  els['zone-green'].value = (z.green || []).join('\n');
  els.excludes.value = (s.excludes || []).join('\n');
  els.contextExcludes.value = (s.contextExcludes || []).join('\n');
  els.hosts.value = (s.hosts || []).join('\n');
  els['sel-comp'].value = ((s.selectors && s.selectors.composition) || []).join('\n');
  els['sel-desc'].value = ((s.selectors && s.selectors.description) || []).join('\n');
}

function collect() {
  return {
    cfgVersion: ASG_CFG_VERSION,
    enabled: els.enabled.checked,
    markClean: els.markClean.checked,
    preferComposition: els.preferComposition.checked,
    fetchStrategy: els.fetchStrategy.value,
    foodCategories: splitLines(els.foodCategories.value),
    zones: {
      red: splitLines(els['zone-red'].value),
      orange: splitLines(els['zone-orange'].value),
      yellow: splitLines(els['zone-yellow'].value),
      green: splitLines(els['zone-green'].value)
    },
    excludes: splitLines(els.excludes.value),
    contextExcludes: splitLines(els.contextExcludes.value),
    hosts: splitLines(els.hosts.value),
    selectors: {
      composition: splitLines(els['sel-comp'].value),
      description: splitLines(els['sel-desc'].value)
    }
  };
}

async function save() {
  await chrome.storage.local.set(collect());
  flash('Сохранено');
}

function flash(text) {
  els['save-msg'].textContent = text;
  setTimeout(() => (els['save-msg'].textContent = ''), 2500);
}

async function showCacheInfo() {
  const info = await chrome.runtime.sendMessage({ type: 'cache-info' }).catch(() => null);
  els['cache-info'].textContent =
    info && typeof info.size === 'number' ? 'в кэше товаров: ' + info.size : '';
}

async function runTest() {
  const url = els['test-url'].value.trim();
  els['test-out'].textContent = 'Загружаю страницу и анализирую (до ~30 сек)...';
  if (!/^https?:\/\//i.test(url)) {
    els['test-out'].textContent = 'Введите URL, начинающийся с http:// или https://';
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'analyze-url', url }).catch((e) => ({
    status: 'error',
    error: String(e)
  }));
  if (res.status !== 'ok') {
    els['test-out'].textContent = 'Ошибка: ' + (res.error || 'неизвестно');
    return;
  }
  const lines = [
    'Источник: ' + (res.source || '—') + ' (' + res.textLength + ' симв.)',
    'Кэш: ' + (res.cached ? 'да' : 'нет')
  ];
  if (res.topCategory) lines.push('Верхняя категория: ' + res.topCategory);
  if (res.skipped) {
    lines.push('Не продуктовая категория — оценка не проводится');
  } else {
    lines.push('Зона: ' + (ZONE_NAMES[res.zone] || res.zone));
    for (const z of ['red', 'orange', 'yellow', 'green']) {
      const ms = (res.zones && res.zones[z]) || [];
      if (ms.length) {
        lines.push(ZONE_NAMES[z] + ': ' + ms.map((m) => m.keyword + ' ×' + m.count).join(', '));
      }
    }
  }
  if (res.snippet) lines.push('', 'Фрагмент: ' + res.snippet);
  els['test-out'].textContent = lines.join('\n');
  showCacheInfo();
}
