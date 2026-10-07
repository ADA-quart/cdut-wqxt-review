/* 清渠 · 移动端首页：课程/课次列表 + 导入内容包 */
(async function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var hint = $('importHint');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
    });
  }

  async function render() {
    var box = $('catalog');
    var cat = await window.QingquLocal.getCatalog();
    if (!cat || !cat.courses || !cat.courses.length) {
      box.innerHTML = '<p class="empty">还没有内容。<br>在电脑端「设置 → 导出」里导出「内容包」，把 zip 传到平板上，点右上角「＋ 导入内容包」。</p>';
      return;
    }
    box.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'courses';
    cat.courses.forEach(function (c) {
      var card = document.createElement('section');
      card.className = 'course';
      var lessons = (c.lessons || []).slice().sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name), 'zh', { numeric: true });
      });
      var date = cat.importedAt ? new Date(cat.importedAt).toLocaleDateString('zh-CN') : '';
      card.innerHTML = '<h2>' + esc(c.name) + '</h2>' +
        '<div class="meta">' + lessons.length + ' 节课' + (date ? ' · 导入于 ' + date : '') + '</div>';
      var list = document.createElement('div');
      list.className = 'lessons';
      lessons.forEach(function (l) {
        var a = document.createElement('a');
        a.className = 'lesson';
        a.href = 'review.html?dir=' + encodeURIComponent(c.name + '/' + l.name);
        a.innerHTML = '<span>' + esc(l.name) + '</span><span class="pages">' +
          (l.pages ? l.pages + ' 页' : '') + (l.note ? ' · 笔记' : '') + '</span>';
        list.appendChild(a);
      });
      card.appendChild(list);
      wrap.appendChild(card);
    });
    box.appendChild(wrap);
  }

  $('pkgInput').onchange = async function () {
    var f = $('pkgInput').files && $('pkgInput').files[0];
    if (!f) return;
    hint.textContent = '正在导入 ' + f.name + '（' + (f.size / 1048576).toFixed(1) + ' MB）…';
    try {
      var buf = await f.arrayBuffer();
      var r = await window.QingquLocal.importZip(buf, f.name);
      var courseCount = r.manifest && r.manifest.courses ? r.manifest.courses.length : 0;
      hint.textContent = '✓ 导入完成：' + r.count + ' 个文件' + (courseCount ? '，' + courseCount + ' 门课程' : '');
      await render();
    } catch (e) {
      hint.textContent = '导入失败：' + ((e && e.message) || e);
    }
    $('pkgInput').value = '';
  };

  render();
})();
