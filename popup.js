document.addEventListener('DOMContentLoaded', async () => {
  const els = {
    enabled: document.getElementById('enabled'),
    markClean: document.getElementById('markClean'),
    status: document.getElementById('status'),
    result: document.getElementById('result'),
    pill: document.getElementById('pill'),
    rSource: document.getElementById('r-source'),
    rCache: document.getElementById('r-cache'),
    rowZones: document.getElementById('row-zones'),
    rZones: document.getElementById('r-zones'),
    msg: document.getElementById('msg'),
    diagOut: document.getElementById('diag-out'),
    copy: document.getElementById('copy')
  };

  // Подписи зон и источников — общие с content script (defaults.js),
  // чтобы одинаковые надписи не расходились в двух файлах
  const ZONE_SHORT = ASG_ZONE_SHORT;
  const SOURCE_LABEL = ASG_SOURCE_LABEL;

  const settings = await chrome.storage.local.get(ASG_DEFAULTS);
  els.enabled.checked = !!settings.enabled;
  els.markClean.checked = settings.markClean !== false;
  const ver = chrome.runtime.getManifest().version;
  document.getElementById('ver').textContent = 'АнтиСахар v' + ver;

  els.enabled.onchange = () => chrome.storage.local.set({ enabled: els.enabled.checked });
  els.markClean.onchange = () =>
    chrome.storage.local.set({ markClean: els.markClean.checked });

  document.getElementById('rescan').onclick = async () => {
    els.msg.textContent = 'Перепроверяю...';
    try {
      await sendToTab({ type: 'asg-rescan' });
    } catch (e) {
      els.msg.textContent = 'Страница не отвечает. Обновите её (F5).';
    }
    refresh();
  };

  document.getElementById('clearCache').onclick = async () => {
    const r = await chrome.runtime.sendMessage({ type: 'clear-cache' }).catch(() => null);
    els.msg.textContent = r && r.ok ? 'Кэш очищен' : 'Не удалось очистить кэш';
  };

  document.getElementById('diag').onclick = async () => {
    els.diagOut.style.display = 'block';
    els.diagOut.textContent = 'Собираю данные...';
    els.copy.disabled = true;
    try {
      const d = await sendToTab({ type: 'asg-diag' });
      lastDiagText = JSON.stringify(d, null, 2);
      els.diagOut.textContent = lastDiagText;
      els.copy.disabled = false;
    } catch (e) {
      els.diagOut.textContent = 'Страница не отвечает. Откройте страницу товара и обновите её (F5).';
    }
  };

  // --- сообщение разработчику о проблеме -----------------------------------------
  // Значок открывает короткую форму прямо в попапе: страница с товаром уже
  // открыта, ничего переключать не нужно.
  const reportForm = document.getElementById('report-form');
  const reportMsg = document.getElementById('report-msg');
  const reportCount = document.getElementById('report-count');
  const reportStatus = document.getElementById('report-msg-status');
  const reportLink = document.getElementById('report-link');

  const updateCount = () => {
    reportCount.textContent = String(reportMsg.value.length);
  };
  reportMsg.addEventListener('input', updateCount);
  updateCount();

  document.getElementById('report-open').onclick = () => {
    reportStatus.textContent = '';
    reportLink.style.display = 'none';
    reportForm.style.display = reportForm.style.display === 'none' ? '' : 'none';
    if (reportForm.style.display !== 'none') reportMsg.focus();
  };
  document.getElementById('report-cancel').onclick = () => {
    reportForm.style.display = 'none';
    reportStatus.textContent = '';
  };
// Основной путь — отправка на сервер разработчика. Адрес зашит в расширение,
// пользователю настраивать ничего не надо.
  document.getElementById('report-send').onclick = async () => {
    const btn = document.getElementById('report-send');
    btn.disabled = true;
    reportLink.style.display = 'none';

    const cfg = (await chrome.storage.local.get(ASG_DEFAULTS)) || {};
    const endpoint = asgReportEndpoint(cfg);

    if (!endpoint) {
      reportStatus.textContent =
        'Отправка отключена в настройках. Нажмите «Вручную», чтобы отправить письмом.';
      btn.disabled = false;
      return;
    }

    reportStatus.textContent = 'Отправляю...';
    try {
      const diag = await sendToTab({ type: 'asg-diag' });
      if (!diag) throw new Error('страница не отвечает — откройте её и нажмите F5');

      const res = await chrome.runtime.sendMessage({
        type: 'report-send',
        endpoint: endpoint,
        payload: asgReportPayload(diag, reportMsg.value)
      });

      if (res && res.ok) {
        reportMsg.value = '';
        updateCount();
        reportStatus.textContent = 'Отправлено. Спасибо!';
      } else {
        reportStatus.textContent =
          'Не отправилось: ' + ((res && res.error) || 'неизвестная ошибка') +
          '. Нажмите «Вручную», чтобы отправить письмом.';
      }
    } catch (e) {
      reportStatus.textContent =
        'Не получилось: ' + (e && e.message ? e.message : e) + '. Нажмите «Вручную».';
    } finally {
      btn.disabled = false;
    }
  };

  // Запасной путь: без сервера. Отчёт в буфер, письмо — по ссылке.
  document.getElementById('report-manual').onclick = async () => {
    const btn = document.getElementById('report-send');
    btn.disabled = true;
    reportStatus.textContent = 'Готовлю...';
    reportLink.style.display = 'none';
    try {
      const diag = await sendToTab({ type: 'asg-diag' });
      if (!diag) throw new Error('страница не отвечает — откройте её и нажмите F5');
      const res = asgSendReport(diag, reportMsg.value);
      reportMsg.value = '';
      updateCount();
      reportLink.href = res.href;
      reportLink.style.display = '';
      reportStatus.textContent = res.copied
        ? 'Отчёт в буфере. Нажмите «Открыть письмо» и вставьте отчёт в конец.'
        : 'Отчёт не скопирован — приложите его из «Диагностики». Нажмите «Открыть письмо».';
    } catch (e) {
      reportStatus.textContent = 'Не получилось: ' + (e && e.message ? e.message : e);
    } finally {
      btn.disabled = false;
    }
  };

  // Копирование диагностики в буфер обмена
  let lastDiagText = '';
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) { /* пробуем запасной способ */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  document.getElementById('copy').onclick = async () => {
    if (!lastDiagText) return;
    const ok = await copyText(lastDiagText);
    els.msg.textContent = ok
      ? 'Диагностика скопирована в буфер обмена'
      : 'Не удалось скопировать — выделите текст вручную';
  };

  document.getElementById('options').onclick = () => chrome.runtime.openOptionsPage();

  async function sendToTab(msg) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined) throw new Error('нет вкладки');
    return await chrome.tabs.sendMessage(tab.id, msg);
  }

  function render(st) {
    if (!st) {
      els.status.className = 'hint off';
      els.status.textContent =
        'Страница не отвечает. Откройте страницу товара и обновите её (F5).';
      els.result.style.display = 'none';
      return;
    }
    if (st.reason) {
      els.status.className = st.productPage && st.active ? 'hint off' : 'hint';
      els.status.textContent =
        st.reason.charAt(0).toUpperCase() + st.reason.slice(1) + ' — оценка не выполнялась.';
      els.result.style.display = 'none';
      return;
    }
    if (!st.productPage) {
      els.status.className = 'hint';
      els.status.textContent = 'Открыта не страница товара — оценка не требуется.';
      els.result.style.display = 'none';
      return;
    }
    if (!st.active) {
      els.status.className = 'hint off';
      els.status.textContent = 'Расширение выключено или сайт не в списке маркетплейсов.';
      els.result.style.display = 'none';
      return;
    }
    els.status.className = 'hint';
    els.status.textContent = 'Страница товара: ' + st.host;
    els.result.style.display = '';

    const s = st.state || { status: 'idle' };
    const confirmed = st.confirmed !== false;
    if (s.status === 'pending' || s.status === 'idle' || (!confirmed && !s.skipped)) {
      els.pill.className = 'pill b-gray';
      els.pill.textContent = 'Проверяю состав…';
      els.rSource.textContent = '—';
      els.rCache.textContent = '—';
      els.rowZones.style.display = 'none';
      return;
    }
    if (s.status === 'error') {
      els.pill.className = 'pill b-gray';
      els.pill.textContent = 'Ошибка проверки';
      els.rSource.textContent = '—';
      els.rCache.textContent = '—';
      els.rowZones.style.display = 'none';
      return;
    }
    if (s.skipped) {
      els.pill.className = 'pill b-gray';
      els.pill.textContent = 'Не продукты';
      els.rSource.textContent =
        s.skipKind === 'material'
          ? 'состав материала — не продукт питания'
          : 'категория «' + (s.reason || '?') + '»';
      els.rCache.textContent = s.cached ? 'да' : 'нет';
      els.rowZones.style.display = 'none';
      return;
    }
    // Как и значок на странице: цвет показываем только когда вердикт получен
    // по настоящему блоку «Состав», иначе — серая плашка с той же подписью
    if (s.authoritative !== true) {
      els.pill.className = 'pill b-gray';
      els.pill.textContent =
        s.source === 'состав' ? 'Состав не подтверждён' : 'Состав не найден';
    } else {
      els.pill.className = 'pill b-' + (s.zone || 'gray');
      els.pill.textContent = ZONE_SHORT[s.zone] || s.zone;
    }
    els.rSource.textContent = SOURCE_LABEL[s.source] || s.source || '—';
    els.rCache.textContent = s.cached ? 'да' : 'нет';
    const words = (s.matches || [])
      .map((m) => {
        const name = m.name || m.keyword;
        // найденное слово из состава, если оно отличается от названия:
        // «Сорбит (E420)» найден по слову «сорбитол»
        const w =
          m.word && name.toLowerCase().indexOf(String(m.word).toLowerCase()) === -1
            ? ' (' + m.word + ')'
            : '';
        return name + ' ×' + m.count + w;
      })
      .join(', ');
    if (words) {
      els.rowZones.style.display = '';
      els.rZones.textContent = words;
    } else {
      els.rowZones.style.display = 'none';
    }
  }

  function refresh() {
    sendToTab({ type: 'asg-status' })
      .then(render)
      .catch(() => render(null));
  }

  refresh();
});
