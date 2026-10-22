/** Pure calendar row bounds/readability check shared with the regression suite. */
'use strict';
function readableListRow(row, view) {
  const time = row.timeBox?.rect, title = row.titleBox?.rect, bounds = row.row?.rect;
  const m = row.timeMetrics, t = row.titleMetrics;
  if (!time || !title || !bounds || !m || !t || !row.time) return false;
  const bounded = r => r.width > 1 && r.x >= Math.max(bounds.x,view.x)-1 && r.right <= Math.min(bounds.right,view.right)+1;
  return bounded(time) && bounded(title) && m.visibility !== 'hidden' && Number(m.opacity) > 0
    && time.width + 1 >= m.intrinsicTextWidth && time.width + 1 >= m.scrollWidth
    && m.clientWidth + 1 >= m.scrollWidth && m.clientHeight + 1 >= m.scrollHeight
    && time.height <= m.lineHeight * 1.5
    && t.clientWidth + 1 >= t.scrollWidth
    && (!row.allDayClass || m.whiteSpace === 'nowrap');
}
module.exports = { readableListRow };
