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
    'foodCategories', 'nonFoodCategories',
    'zone-red', 'zone-orange', 'zone-yellow', 'zone-green',
    'excludes', 'contextExcludes', 'hosts', 'sel-comp', 'sel-desc',
    'save', 'reset', 'save-msg',
    'test-url', 'test-btn', 'test-out', 'clear-cache', 'cache-info',
    'report-msg', 'report-count', 'report-btn', 'report-manual',
    'report-msg-status', 'report-link', 'report-endpoint'
  ]) {
    els[id] = document.getElementById(id);
  }

  const saved = await chrome.storage.local.get(ASG_DEFAULTS);
  fillFrom(saved);
  showCacheInfo();

  els.save.onclick = save;
  els.reset.onclick = async () => {
    await chrome.storage.local.set(ASG_DEFAULTS);
    // Кэш вердиктов посчитан по прежним критериям: сбрасываем его вместе
    // с настройками, иначе старые оценки останутся в силе
    await chrome.runtime.sendMessage({ type: 'clear-cache' }).catch(() => null);
    fillFrom(ASG_DEFAULTS);
    flash('Сброшено (кэш очищен)');
    showCacheInfo();
  };
  els['test-btn'].onclick = runTest;
  els['clear-cache'].onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'clear-cache' });
    els['cache-info'].textContent = 'кэш очищен';
  };

  // --- сообщение о проблеме ---
  // Считаем введённое, чтобы человек видел, сколько осталось: лимит задан
  // в разметке (maxlength), но счётчик нужен и для подсказки.
  const countMsg = () => {
    els['report-count'].textContent = String(els['report-msg'].value.length);
  };
  els['report-msg'].addEventListener('input', countMsg);
  countMsg();

  // Адрес можно переопределить для отладки, поэтому пишем его в настройки сразу
  // при вводе. Пустое поле означает «использовать зашитый в расширение адрес».
  const saveReportSettings = () => {
    chrome.storage.local
      .set({ reportEndpoint: els['report-endpoint'].value.trim() })
      .catch(() => null);
  };
  els['report-endpoint'].addEventListener('change', saveReportSettings);

  els['report-btn'].onclick = async () => {
    const btn = els['report-btn'];
    const status = els['report-msg-status'];
    const link = els['report-link'];
    btn.disabled = true;
    link.style.display = 'none';

    // Адрес зашит в расширение: пустое поле у пользователя не мешает отправке.
    const endpoint = asgReportEndpoint({ reportEndpoint: els['report-endpoint'].value });

    if (!endpoint) {
      status.textContent =
        'Отправка отключена — нажмите «Подготовить вручную», чтобы отправить письмом.';
      btn.disabled = false;
      return;
    }
    if (!asgReportEndpointOk(endpoint)) {
      status.textContent = 'Адрес должен начинаться с https://';
      btn.disabled = false;
      return;
    }

    status.textContent = 'Отправляю...';
    try {
      saveReportSettings();
      const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab || tab.id === undefined) throw new Error('нет вкладки');
      const diag = await chrome.tabs.sendMessage(tab.id, { type: 'asg-diag' });
      if (!diag) throw new Error('страница не отвечает — откройте её и нажмите F5');

      const res = await chrome.runtime.sendMessage({
        type: 'report-send',
        endpoint: endpoint,
        payload: asgReportPayload(diag, els['report-msg'].value)
      });

      if (res && res.ok) {
        status.textContent = 'Отправлено. Спасибо!';
        els['report-msg'].value = '';
        countMsg();
      } else {
        status.textContent =
          'Не отправилось: ' + ((res && res.error) || 'неизвестная ошибка') +
          '. Нажмите «Подготовить вручную», чтобы отправить письмом.';
      }
    } catch (e) {
      status.textContent =
        'Не получилось: ' + (e && e.message ? e.message : e) +
        '. Нажмите «Подготовить вручную».';
    } finally {
      btn.disabled = false;
    }
  };

  // Запасной путь: без сервера. Отчёт в буфер, письмо — по ссылке.
  els['report-manual'].onclick = async () => {
    const status = els['report-msg-status'];
    const link = els['report-link'];
    status.textContent = 'Готовлю...';
    link.style.display = 'none';
    try {
      const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab || tab.id === undefined) throw new Error('нет вкладки');
      const diag = await chrome.tabs.sendMessage(tab.id, { type: 'asg-diag' });
      if (!diag) throw new Error('страница не отвечает — откройте её и нажмите F5');
      const res = asgSendReport(diag, els['report-msg'].value);
      // Письмо открывает пользователь: расширение не переходит по mailto само,
      // в 1.6.0 это приводило к падению браузера
      link.href = res.href;
      link.style.display = '';
      status.textContent = res.copied
        ? 'Отчёт скопирован в буфер. Нажмите «Открыть письмо» и вставьте отчёт в конец письма.'
        : 'Отчёт не удалось скопировать — сохраните отчёт из блока «Диагностика». Нажмите «Открыть письмо».';
    } catch (e) {
      status.textContent = 'Не получилось: ' + (e && e.message ? e.message : e);
    }
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
  els.nonFoodCategories.value = (s.nonFoodCategories || []).join('\n');
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
  // Поле пустое, когда используется зашитый адрес: так видно, что настраивать
// ничего не нужно, и случайная правка его не сломает.
els['report-endpoint'].value =
    s.reportEndpoint && s.reportEndpoint !== ASG_REPORT_ENDPOINT ? s.reportEndpoint : '';
}

function collect() {
  return {
    cfgVersion: ASG_CFG_VERSION,
    enabled: els.enabled.checked,
    markClean: els.markClean.checked,
    preferComposition: els.preferComposition.checked,
    fetchStrategy: els.fetchStrategy.value,
    foodCategories: splitLines(els.foodCategories.value),
    nonFoodCategories: splitLines(els.nonFoodCategories.value),
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
    },
    // Пустое поле — используется зашитый в расширение адрес. Записываем именно
    // пустую строку, а не значение по умолчанию: иначе при следующем обновлении
    // адреса в коде старое значение из настроек продолжило бы перекрывать новое.
    reportEndpoint: els['report-endpoint'].value.trim()
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
  if (!info || typeof info.size !== 'number') {
    els['cache-info'].textContent = '';
    return;
  }
  els['cache-info'].textContent =
    'в кэше товаров: ' + info.size + (info.error ? ' · ' + info.error : '');
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
