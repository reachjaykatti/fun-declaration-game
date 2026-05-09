
// Back link + Theme toggle + Double confirm for declare + IST helper
(function () {
  function go(url) { window.location.href = url; }

  // ---- Back behavior ----
  function backAction() {
    var el = document.querySelector('.js-back');
    var prev = el ? el.getAttribute('data-prev') : '';
    if (prev && prev !== location.href) { go(prev); return; }
    try {
      if (document.referrer && document.referrer !== location.href && history.length > 1) {
        const before = location.href;
        history.back();
        setTimeout(function () {
          if (location.href === before) go(window.fdHomeUrl || '/dashboard');
        }, 350);
        return;
      }
    } catch(e) {}
    go(window.fdHomeUrl || '/dashboard');
  }

  // ---- Theme toggle ----
  function applyTheme(t){ document.body.setAttribute('data-theme', t); localStorage.setItem('fdTheme', t); }
  function toggleTheme(){ var cur=document.body.getAttribute('data-theme')||'dark'; applyTheme(cur==='dark'?'light':'dark'); }
  var saved=localStorage.getItem('fdTheme'); if(saved) applyTheme(saved);

  // ---- Double confirm on quick declare buttons ----
  function handleDeclareButton(t) {
    const teamName = t.getAttribute('data-teamname');
    const formId   = t.getAttribute('data-form');
    const form     = document.getElementById(formId);
    if (!form) return;
    if (!confirm('Confirm pick: ' + teamName + ' ?')) return;
    if (!confirm('Are you sure? This will lock your pick at this time.')) return;
    form.submit();
  }

  // ---- IST → UTC helper ----
  // Expects IST string 'YYYY-MM-DD HH:mm'
  function istToUtcIso(istStr) {
  if (!istStr) return '';

  // Accept both "YYYY-MM-DD HH:mm" and "YYYY-MM-DDTHH:mm"
  var clean = istStr.replace('T', ' ');

  var m = clean.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) return '';

  var y = +m[1], mo = +m[2] - 1, d = +m[3], hh = +m[4], mm = +m[5];

  var dateUtc = new Date(Date.UTC(y, mo, d, hh, mm));
  dateUtc.setMinutes(dateUtc.getMinutes() - 330); // IST → UTC
  return dateUtc.toISOString();
}

  // When submitting admin match forms, auto-convert IST if present
  function wireIstForms() {
    document.querySelectorAll('form[data-ist-form="1"]').forEach(function(form){
      form.addEventListener('submit', function(e){
        var istInput  = form.querySelector('input[name="start_time_ist"]');
        var utcInput  = form.querySelector('input[name="start_time_utc"]');
        if (istInput && istInput.value && utcInput && !utcInput.value) {
          var iso = istToUtcIso(istInput.value.trim());
          if (!iso) {
            alert('Invalid IST format. Use YYYY-MM-DD HH:mm (24-hour).');
            e.preventDefault();
            return;
          }
          utcInput.value = iso;
        }
      });
    });
  }

  // ---- Event delegation ----
  document.addEventListener('click', function (e) {
    const t = e.target;

    if (t && t.classList.contains('js-back')) { e.preventDefault(); backAction(); }
    if (t && t.classList.contains('js-theme-toggle')) { e.preventDefault(); toggleTheme(); }
    if (t && t.classList.contains('js-declare')) { e.preventDefault(); handleDeclareButton(t); }
  });

  // Init IST form wiring after DOM loads
  document.addEventListener('DOMContentLoaded', wireIstForms);
})();

// === Double confirmation for risky actions (links) ===
document.addEventListener('click', function (e) {
  var el = e.target;
  // Support clicking icons/spans inside <a>
  if (el && el.closest) {
    el = el.closest('.js-confirm-double');
  }
  if (!el) return;

  // Intercept only anchors
  if (el.tagName && el.tagName.toLowerCase() === 'a') {
    e.preventDefault();
    var href = el.getAttribute('href');
    var msg1 = el.getAttribute('data-confirm1') || 'Are you sure?';
    var msg2 = el.getAttribute('data-confirm2') || 'Final confirmation. Proceed?';
    if (window.confirm(msg1)) {
      if (window.confirm(msg2)) {
        window.location.href = href;
      }
    }
  }
});

// public/js/main.js (FULL FILE REPLACEMENT)

// Double confirmation for risky actions (anchors with class .js-confirm-double)
document.addEventListener('click', function (e) {
  var a = e.target;
  if (a && a.closest) a = a.closest('a.js-confirm-double');
  if (!a) return;

  e.preventDefault();
  var href = a.getAttribute('href');
  var msg1 = a.getAttribute('data-confirm1') || 'Are you sure?';
  var msg2 = a.getAttribute('data-confirm2') || 'Final confirmation. Proceed?';
  if (window.confirm(msg1)) {
    if (window.confirm(msg2)) {
      window.location.href = href;
    }
  }
});

// Double confirmation for forms with class .js-confirm-double
document.addEventListener('submit', function (e) {
  var form = e.target;
  if (!form || !form.classList || !form.classList.contains('js-confirm-double')) return;

  var msg1 = form.getAttribute('data-confirm1') || 'Are you sure?';
  var msg2 = form.getAttribute('data-confirm2') || 'Final confirmation. Proceed?';
  if (!window.confirm(msg1)) {
    e.preventDefault();
    return;
  }
  if (!window.confirm(msg2)) {
    e.preventDefault();
    return;
  }
});

// === Smart Back Button handler =============================================
// Usage: <a href="<%= prevUrl || '/fallback' %>" class="btn btn-link js-back" data-fallback="/fallback">← Back</a>
// - If there is a same-origin referrer and history length > 1, it will history.back().
// - Otherwise, it will navigate to data-fallback (or href) safely.

(function () {
  function sameOrigin(url) {
    try {
      var u = new URL(url, window.location.origin);
      return u.origin === window.location.origin;
    } catch (e) {
      return false;
    }
  }

  document.addEventListener('click', function (e) {
    var a = e.target;
    if (a && a.closest) a = a.closest('a.js-back');
    if (!a) return;

    // Prevent default navigation; we decide where to go
    e.preventDefault();

    var fallback = a.getAttribute('data-fallback') || a.getAttribute('href') || '/';
    var ref = document.referrer;

    // If there is a valid same-origin previous page and we have some history, go back
    if (ref && sameOrigin(ref) && window.history.length > 1) {
      window.history.back();
      return;
    }

    // Otherwise, go to the explicit fallback
    window.location.href = fallback;
  });
})();
// --- Admin: Confirm before deleting a travel ---
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.delete-form').forEach(form => {
    form.addEventListener('submit', e => {
      const travelName = form.dataset.matchname || 'this travel';
      const confirmed = window.confirm(`⚠️ Are you sure you want to delete "${travelName}"?\nThis action cannot be undone.`);
      if (!confirmed) e.preventDefault();
    });
  });
});
// =====================================
// Player Performance Graph
// =====================================

window.addEventListener('load', () => {

  const graphEl = document.getElementById('graphData');

  if (!graphEl) return;

  const labels = JSON.parse(graphEl.dataset.labels || '[]');
  const data = JSON.parse(graphEl.dataset.values || '[]');

  const canvas = document.getElementById('trendChart');

  if (!canvas || !data.length) return;

  const ctx = canvas.getContext('2d');

  canvas.width = canvas.offsetWidth;
  canvas.height = 400;

  const padding = 50;

  const max = Math.max(...data);
  const min = Math.min(...data);

  const range = max - min || 1;

  // Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Axis
  ctx.strokeStyle = '#cccccc';
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(padding, padding);
  ctx.lineTo(padding, canvas.height - padding);
  ctx.lineTo(canvas.width - padding, canvas.height - padding);
  ctx.stroke();

  // =====================================
// Bar Graph
// =====================================

const barWidth =
  (canvas.width - padding * 2) / data.length;

data.forEach((value, index) => {

  const x =
    padding + index * barWidth;

  const y =
    canvas.height -
    padding -
    ((value - min) / range) *
    (canvas.height - padding * 2);

  const barHeight =
    canvas.height - padding - y;

  // Positive = green
  // Negative = red
  ctx.fillStyle =
    value >= 0
      ? '#0f9d58'
      : '#db4437';

  ctx.fillRect(
    x + 2,
    y,
    barWidth - 4,
    barHeight
  );

  // Show travel number every 5
  if (index % 5 === 0) {

    ctx.fillStyle = '#555';
    ctx.font = '11px Arial';

    ctx.fillText(
      index + 1,
      x,
      canvas.height - 10
    );
  }

});
// =====================================
// 🏁 Rank Race Graph
// =====================================

window.addEventListener('load', () => {

  const holder = document.getElementById('rankRaceData');

  if (!holder) return;

  const raw = holder.dataset.graph;

  if (!raw) return;

  const graph = JSON.parse(raw);

  const currentUserId = Number(holder.dataset.currentUser);

  const svg = document.getElementById('rankRaceGraph');

  if (!svg) return;

  const width = 1200;
  const height = 500;

  const padding = 50;

  const labels = graph.graphLabels || [];
  const datasets = graph.graphDatasets || [];

  const totalPlayers = datasets.length;

  svg.innerHTML = '';

  // Axis
  const axis = document.createElementNS('http://www.w3.org/2000/svg', 'line');

  axis.setAttribute('x1', padding);
  axis.setAttribute('y1', padding);
  axis.setAttribute('x2', padding);
  axis.setAttribute('y2', height - padding);
  axis.setAttribute('stroke', '#aaa');

  svg.appendChild(axis);

  datasets.forEach(ds => {

    if (!ds.ranks.length) return;

    let path = '';

    ds.ranks.forEach((rank, idx) => {

      const x =
        padding +
        (idx * (width - padding * 2)) /
        (labels.length - 1 || 1);

      const y =
        padding +
        ((rank - 1) * (height - padding * 2)) /
        (totalPlayers - 1 || 1);

      path += idx === 0
        ? `M ${x} ${y}`
        : ` L ${x} ${y}`;

    });

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');

    line.setAttribute('d', path);

    if (ds.user_id === currentUserId) {

      line.setAttribute('stroke', '#0057b8');
      line.setAttribute('stroke-width', '4');
      line.setAttribute('opacity', '1');

    } else {

      line.setAttribute('stroke', '#999');
});
});
