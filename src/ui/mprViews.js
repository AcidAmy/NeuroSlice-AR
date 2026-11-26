import { AXIS_PLANES, PLANES, planeAspect, pointToVoxel, projectVoxel } from '../core/mpr.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function createMprViews(container, { onPoint, onWheel, onDetail }) {
  const entries = [];
  let layout;
  let active;
  let series;
  let cursor;
  for (const modality of ['ct', 'mri']) {
    for (const [key, plane] of Object.entries(PLANES)) {
      const card = element('figure', 'mpr-card');
      card.dataset.semantic = key;
      card.dataset.plane = key;
      card.dataset.modality = modality;
      const heading = element('figcaption', 'mpr-caption');
      const planeBadge = element('span', 'mpr-plane numeric', plane.short);
      const modalityName = element('span', 'mpr-modality', modality.toUpperCase());
      heading.append(planeBadge, modalityName);
      const zoom = element('button', 'mpr-detail', '⤢');
      zoom.type = 'button';
      zoom.setAttribute('aria-label', '放大' + plane.label + ' ' + modality.toUpperCase());
      zoom.addEventListener('click', () => onDetail(key));
      heading.append(zoom);
      const well = element('div', 'mpr-well');
      const image = element('div', 'mpr-image');
      const canvas = element('canvas', '');
      canvas.id = modality + (key === 'axial' ? '' : '-' + key) + '-slice';
      canvas.setAttribute('aria-label', modality.toUpperCase() + ' ' + plane.label);
      const horizontal = element('span', 'mpr-cross mpr-cross-h');
      horizontal.dataset.semantic = AXIS_PLANES[plane.axes[1]];
      const vertical = element('span', 'mpr-cross mpr-cross-v');
      vertical.dataset.semantic = AXIS_PLANES[plane.axes[0]];
      const overlay = element('div', 'anatomy-markers');
      overlay.id = modality + (key === 'axial' ? '' : '-' + key) + '-annotations';
      const empty = element('span', 'mpr-empty', '未导入 MRI');
      empty.hidden = true;
      image.append(canvas, horizontal, vertical, overlay, empty);
      const directions = ['top', 'bottom', 'left', 'right'].map((side, i) => {
        const node = element('span', 'mpr-direction numeric mpr-' + side, plane.tags[i]);
        image.append(node);
        return node;
      });
      well.append(image);
      card.append(heading, well);
      container.append(card);
      const entry = {
        card, canvas, image, key, modality, modalityName, planeBadge, directions, overlay, plane, empty,
      };
      entries.push(entry);
      let pointerId;
      function position(event) {
        if (!series || event.target.closest('button')) return;
        const bounds = image.getBoundingClientRect();
        const point = [(event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height];
        onPoint(key, pointToVoxel(plane, point, cursor, series.dimensions), point);
      }
      image.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target.closest('button')) return;
        pointerId = event.pointerId;
        image.setPointerCapture(pointerId);
        position(event);
      });
      image.addEventListener('pointermove', event => { if (pointerId === event.pointerId) position(event); });
      image.addEventListener('lostpointercapture', () => { pointerId = undefined; });
      well.addEventListener('wheel', event => {
        if (!series || event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
        event.preventDefault();
        onWheel(key, Math.sign(event.deltaY));
      }, { passive: false });
    }
  }
  function setLayout(value, key) {
    if (layout === value && active === key) return;
    layout = value;
    active = key;
    container.dataset.layout = layout;
    for (const entry of entries) {
      entry.card.hidden = layout !== 'mpr' && entry.key !== layout;
      entry.card.classList.toggle('is-active', entry.key === active);
    }
  }
  function render(next, obliqueFrames = null) {
    if (!series) return;
    cursor = next;
    for (const entry of entries) {
      if (entry.card.hidden) continue;
      const frame = obliqueFrames?.[entry.key] ?? null;
      const [x, y] = frame ? frame.cross : projectVoxel(entry.plane, cursor, series.dimensions);
      if (entry.crossX !== x) entry.image.style.setProperty('--cross-x', x * 100 + '%');
      if (entry.crossY !== y) entry.image.style.setProperty('--cross-y', y * 100 + '%');
      entry.crossX = x;
      entry.crossY = y;
      const badgeText = frame && frame.angleDeg > 0 ? `${entry.plane.short} ${frame.angleDeg}°` : entry.plane.short;
      if (entry.planeBadge.textContent !== badgeText) entry.planeBadge.textContent = badgeText;
      const tags = frame ? frame.tags : entry.plane.tags;
      for (let i = 0; i < 4; i++) {
        if (entry.directions[i].textContent !== tags[i]) entry.directions[i].textContent = tags[i];
      }
    }
  }
  return {
    entries, render, setLayout,
    setMriLabel(text) {
      for (const entry of entries) {
        if (entry.modality === 'mri' && entry.modalityName.textContent !== text) entry.modalityName.textContent = text;
      }
    },
    setSeries(value) {
      series = value;
      for (const entry of entries) {
        entry.crossX = entry.crossY = undefined;
        entry.image.style.setProperty('--image-ratio', planeAspect(entry.plane, series.dimensions, series.spacing));
        entry.empty.hidden = entry.modality !== 'mri' || Boolean(series.mri);
        entry.empty.textContent = series.mriPending ? '等待加载 MRI' : '未导入 MRI';
        entry.image.classList.toggle('is-empty', !entry.empty.hidden);
      }
    },
  };
}
