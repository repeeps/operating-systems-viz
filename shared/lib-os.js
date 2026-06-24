/* ============================================================
   운영체제 엔진 (VZ.OS — operating systems)
   "운영체제, 눈으로 보기" 전용 렌더러. 순수 함수(상태→SVG 문자열),
   전부 방어적(빈 배열·0 division·음수·NaN 가드). 베이스 lib.js
   (VZ.AL 스텝 플레이어 + heatColor + VZ.LA.tween + linePlot) 재사용.
   - svg / chip / arrow / trap / interrupt : 기본·제어 흐름
   - proc(프로세스 박스: run/ready/wait/new/done) / queue(레디 큐)
   - gantt(CPU 타임라인: 누가 언제 CPU를) / pcb(프로세스 제어블록)
   - boundary(커널/유저 경계 벽) / addrSpace(주소공간 text·data·heap·stack)
   - pageTable(가상→물리 매핑) / frames(물리 프레임) / tlb(변환 캐시)
   - disk(느린 디스크) / inode(메타+블록포인터) / blocks(디스크 블록)
   - card(비교) / rng(결정적)
   색: running=초록(--good) ready=청록(--q) wait=앰버(--hot) new/done=슬레이트
       kernel=보라(--v) user=청록(--q) interrupt/fault=코랄(--dead) frame=heat
   ============================================================ */
(function (global) {
  'use strict';
  const VZ = global.VZ;
  const LA = VZ.LA, AL = VZ.AL, clamp = VZ.clamp;
  const heat = AL.heatColor;

  const C = {
    run: 'var(--good)', ready: 'var(--q)', wait: 'var(--hot)', idle: 'var(--slate)', done: 'var(--slate)',
    kernel: 'var(--v)', user: 'var(--q)', irq: 'var(--dead)', fault: 'var(--dead)', disk: 'var(--slate)',
    ink: 'var(--ink)', muted: 'var(--muted)', faint: 'var(--faint)', line: 'var(--line)',
    pink: 'var(--pink)', blue: 'var(--blue)', v: 'var(--v)', q: 'var(--q)', hot: 'var(--hot)', good: 'var(--good)',
  };
  const stateCol = s => ({ run: C.run, running: C.run, ready: C.ready, wait: C.wait, waiting: C.wait, blocked: C.wait, new: C.idle, done: C.done, term: C.done }[s] || C.idle);
  const num = (v, d = 0) => (isFinite(v) ? v : d);

  function svg(W, H, inner, aria) {
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${aria || '운영체제 그림'}" style="max-width:100%;display:block;background:var(--panel-2);border:1px solid var(--line);border-radius:12px">${inner}</svg>`;
  }
  function rng(seed) { let s = (seed >>> 0) || 1; return function () { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  function chip(cx, cy, text, opts = {}) {
    const col = opts.color || C.q, w = Math.max(opts.minW || 30, String(text).length * 7.2 + 12), h = opts.h || 18;
    return `<rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="4" fill="${opts.fill || 'var(--panel)'}" stroke="${col}" stroke-width="1.2"${opts.dim ? ' opacity="0.45"' : ''}/>` +
      `<text x="${cx}" y="${cy + 3.5}" text-anchor="middle" font-size="${opts.fs || 10}" font-family="JetBrains Mono" font-weight="700" fill="${col}">${text}</text>`;
  }
  function arrow(x1, y1, x2, y2, opts = {}) {
    const col = opts.color || C.line;
    if (opts.dash) return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="${opts.lw || 1.6}" stroke-dasharray="${opts.dash}"${opts.dim ? ' opacity="0.4"' : ''}/>`;
    return LA.arrowPx(x1, y1, x2, y2, col, { lw: opts.lw || 1.8 });
  }
  // 톱니(인터럽트) 신호선
  function interrupt(x1, y1, x2, y2, opts = {}) {
    const col = opts.color || C.irq, segs = 7; let d = `M${x1},${y1}`;
    for (let i = 1; i <= segs; i++) { const t = i / segs; const bx = x1 + (x2 - x1) * t, by = y1 + (y2 - y1) * t; const off = (i % 2 ? 1 : -1) * 4; const nx = -(y2 - y1), ny = (x2 - x1); const len = Math.hypot(nx, ny) || 1; d += ` L${(bx + nx / len * off).toFixed(1)},${(by + ny / len * off).toFixed(1)}`; }
    let s = `<path d="${d}" fill="none" stroke="${col}" stroke-width="${opts.lw || 2}"/>`;
    s += LA.arrowPx(x1 + (x2 - x1) * 0.86, y1 + (y2 - y1) * 0.86, x2, y2, col, { lw: opts.lw || 2 });
    if (opts.label) { const mx = (x1 + x2) / 2, my = (y1 + y2) / 2; s += `<text x="${mx}" y="${my - 6}" text-anchor="middle" font-size="9" font-family="JetBrains Mono" fill="${col}">${opts.label}</text>`; }
    return s;
  }

  // ---- 프로세스 박스 ----
  // proc(x,y,opts) opts:{label, state, w, h, sub, pid, dim}
  function proc(x, y, opts = {}) {
    const w = opts.w || 56, h = opts.h || 36, col = stateCol(opts.state), filled = opts.state === 'run' || opts.state === 'running';
    let g = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${filled ? col : 'var(--panel)'}" opacity="${opts.dim ? 0.4 : (filled ? 0.92 : 1)}" stroke="${col}" stroke-width="${filled ? 2.4 : 1.4}"/>`;
    g += `<text x="${(x + w / 2).toFixed(1)}" y="${(y + (opts.sub != null ? h / 2 - 1 : h / 2 + 4)).toFixed(1)}" text-anchor="middle" font-size="${opts.fs || 12}" font-family="'Pretendard'" font-weight="700" fill="${filled ? '#0b0e14' : 'var(--ink)'}">${opts.label != null ? opts.label : ''}</text>`;
    if (opts.sub != null) g += `<text x="${(x + w / 2).toFixed(1)}" y="${(y + h - 6).toFixed(1)}" text-anchor="middle" font-size="8" font-family="JetBrains Mono" fill="${filled ? '#0b0e14' : col}">${opts.sub}</text>`;
    return g;
  }
  // 레디 큐 (가로 줄)
  function queue(x, y, items, opts = {}) {
    const w = opts.w || 50, h = opts.h || 30, gap = opts.gap || 6; let g = '';
    if (opts.label != null) g += `<text x="${x}" y="${y - 7}" font-size="9.5" font-family="JetBrains Mono" font-weight="700" fill="${opts.labelColor || C.muted}">${opts.label}</text>`;
    (items || []).forEach((it, i) => { g += proc(x + i * (w + gap), y, { label: it.label != null ? it.label : it, state: it.state || 'ready', w, h, sub: it.sub }); });
    return g;
  }

  // ---- CPU 간트 (누가 언제 CPU를 쓰나) ----
  // gantt(opts) opts:{W,H, segs:[{label,dur,color}], tmax, title, now(px? no, t), nowLabel}
  function gantt(opts = {}) {
    const segs = opts.segs || [], W = opts.W || 500, H = opts.H || 90, padL = 12, padR = 12, padT = opts.title != null ? 30 : 16, barH = opts.barH || 34;
    const total = segs.reduce((a, s) => a + Math.max(0, num(s.dur)), 0) || 1;
    const tmax = opts.tmax || total;
    const px = t => padL + clamp(t, 0, tmax) / tmax * (W - padL - padR);
    let g = '', acc = 0;
    if (opts.title != null) g += `<text x="${W / 2}" y="16" text-anchor="middle" font-size="10.5" font-family="JetBrains Mono" fill="var(--muted)">${opts.title}</text>`;
    const y = padT;
    g += `<line x1="${padL}" y1="${y + barH + 4}" x2="${W - padR}" y2="${y + barH + 4}" stroke="var(--line)"/>`;
    segs.forEach((s, i) => {
      const x0 = px(acc), x1 = px(acc + Math.max(0, num(s.dur))); acc += Math.max(0, num(s.dur));
      const col = s.color || C.run, ww = Math.max(0, x1 - x0);
      g += `<rect x="${x0.toFixed(1)}" y="${y}" width="${ww.toFixed(1)}" height="${barH}" rx="3" fill="${col}" opacity="0.9" stroke="var(--bg)" stroke-width="1"/>`;
      if (ww > 16 && s.label != null) g += `<text x="${((x0 + x1) / 2).toFixed(1)}" y="${(y + barH / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="10.5" font-family="'Pretendard'" font-weight="700" fill="#0b0e14">${s.label}</text>`;
      g += `<text x="${x0.toFixed(1)}" y="${(y + barH + 16).toFixed(1)}" text-anchor="middle" font-size="8.5" font-family="JetBrains Mono" fill="var(--faint)">${(acc - Math.max(0, num(s.dur))).toFixed(0)}</text>`;
    });
    g += `<text x="${px(acc).toFixed(1)}" y="${(y + barH + 16).toFixed(1)}" text-anchor="middle" font-size="8.5" font-family="JetBrains Mono" fill="var(--faint)">${acc.toFixed(0)}</text>`;
    return svg(W, H, g, opts.aria || 'CPU 간트');
  }

  // ---- PCB ----
  function pcb(x, y, opts = {}) {
    const w = opts.w || 130, rows = opts.rows || [['상태', opts.state || 'ready'], ['레지스터', '저장됨'], ['페이지표', '0x…']];
    const h = 24 + rows.length * 16;
    let g = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="var(--panel)" stroke="${C.v}" stroke-width="1.5"/>`;
    g += `<text x="${x + 10}" y="${y + 16}" font-size="10.5" font-family="JetBrains Mono" font-weight="700" fill="${C.v}">PCB ${opts.pid != null ? '#' + opts.pid : ''}</text>`;
    rows.forEach((r, i) => { const ry = y + 34 + i * 16; g += `<text x="${x + 10}" y="${ry}" font-size="9" font-family="JetBrains Mono" fill="var(--muted)">${r[0]}</text><text x="${x + w - 10}" y="${ry}" text-anchor="end" font-size="9" font-family="JetBrains Mono" fill="var(--ink)">${r[1]}</text>`; });
    return g;
  }

  // ---- 커널/유저 경계 ----
  // boundary(opts) opts:{W,H, mode('user'|'kernel'), userInner, kernelInner, trapUp(bool), trapLabel}
  function boundary(opts = {}) {
    const W = opts.W || 460, H = opts.H || 200, midY = opts.midY || H / 2;
    let g = '';
    g += `<rect x="6" y="8" width="${W - 12}" height="${midY - 14}" rx="8" fill="rgba(55,189,248,0.05)" stroke="${C.user}" stroke-width="1.2"/>`;
    g += `<text x="16" y="24" font-size="10" font-family="JetBrains Mono" font-weight="700" fill="${C.user}">유저 모드 (앱)</text>`;
    g += `<rect x="6" y="${midY + 6}" width="${W - 12}" height="${H - midY - 14}" rx="8" fill="rgba(192,132,252,0.06)" stroke="${C.kernel}" stroke-width="1.2"/>`;
    g += `<text x="16" y="${midY + 22}" font-size="10" font-family="JetBrains Mono" font-weight="700" fill="${C.kernel}">커널 모드 (OS)</text>`;
    // the wall
    g += `<line x1="6" y1="${midY}" x2="${W - 6}" y2="${midY}" stroke="${C.line}" stroke-width="2.5" stroke-dasharray="2 3"/>`;
    g += `<text x="${W - 16}" y="${midY - 5}" text-anchor="end" font-size="8.5" font-family="JetBrains Mono" fill="var(--faint)">특권의 벽</text>`;
    if (opts.inner) g += opts.inner;
    return svg(W, H, g, opts.aria || '커널/유저 경계');
  }

  // ---- 주소공간 (세로: 위=stack, 아래=text) ----
  function addrSpace(x, y, opts = {}) {
    const w = opts.w || 90, H = opts.H || 200;
    const regions = opts.regions || [
      ['스택', 'var(--pink)', 0.18, '↓ 자람'], ['(빈 공간)', 'var(--faint)', 0.30, ''],
      ['힙', 'var(--good)', 0.18, '↑ 자람'], ['데이터', 'var(--q)', 0.14, ''], ['코드(text)', 'var(--v)', 0.20, ''],
    ];
    let g = `<text x="${x + w / 2}" y="${y - 6}" text-anchor="middle" font-size="9" font-family="JetBrains Mono" fill="var(--muted)">${opts.title || '주소공간'}</text>`;
    g += `<text x="${x - 6}" y="${y + 8}" text-anchor="end" font-size="8" font-family="JetBrains Mono" fill="var(--faint)">높은 주소</text>`;
    g += `<text x="${x - 6}" y="${y + H}" text-anchor="end" font-size="8" font-family="JetBrains Mono" fill="var(--faint)">0</text>`;
    let cy = y;
    regions.forEach((r, i) => { const rh = r[2] * H; const hot = opts.hl === i;
      g += `<rect x="${x}" y="${cy.toFixed(1)}" width="${w}" height="${(rh - 1.5).toFixed(1)}" fill="${hot ? r[1] : 'var(--panel)'}" opacity="${hot ? 0.85 : 1}" stroke="${r[1]}" stroke-width="1.2"/>`;
      g += `<text x="${x + w / 2}" y="${(cy + rh / 2 + 3).toFixed(1)}" text-anchor="middle" font-size="9.5" font-family="'Pretendard'" font-weight="700" fill="${hot ? '#0b0e14' : 'var(--ink)'}">${r[0]}</text>`;
      if (r[3]) g += `<text x="${x + w + 4}" y="${(cy + rh / 2 + 3).toFixed(1)}" font-size="8" font-family="JetBrains Mono" fill="${r[1]}">${r[3]}</text>`;
      cy += rh; });
    return g;
  }

  // ---- 페이지 테이블 (가상 페이지 → 물리 프레임/디스크) ----
  // pageTable(x,y,entries,opts) entries=[{v,f(or null=on disk)}], opts:{hl(v index), title}
  function pageTable(x, y, entries, opts = {}) {
    const e = entries || [], rh = 22, w = opts.w || 150;
    let g = `<text x="${x + w / 2}" y="${y - 6}" text-anchor="middle" font-size="9.5" font-family="JetBrains Mono" fill="${C.v}">${opts.title || '페이지 테이블'}</text>`;
    e.forEach((row, i) => { const ry = y + i * rh, hot = opts.hl === i;
      g += `<rect x="${x}" y="${ry}" width="${w}" height="${rh - 2}" rx="3" fill="${hot ? 'rgba(192,132,252,0.18)' : 'var(--panel)'}" stroke="${hot ? C.v : 'var(--line)'}" stroke-width="${hot ? 1.8 : 1}"/>`;
      g += `<text x="${x + 8}" y="${ry + 15}" font-size="10" font-family="JetBrains Mono" fill="var(--q)">가상 P${row.v}</text>`;
      const onDisk = row.f == null;
      g += `<text x="${x + w - 8}" y="${ry + 15}" text-anchor="end" font-size="10" font-family="JetBrains Mono" fill="${onDisk ? C.fault : C.good}">${onDisk ? '디스크' : '→ 프레임 ' + row.f}</text>`;
    });
    return g;
  }

  // ---- 물리 프레임 줄 ----
  // frames(x,y,cells,opts) cells=[{by(label)|null free, color}], opts:{cols, cw, title}
  function frames(x, y, cells, opts = {}) {
    const c = cells || [], cw = opts.cw || 40, ch = opts.ch || 30, cols = opts.cols || c.length;
    let g = opts.title != null ? `<text x="${x}" y="${y - 7}" font-size="9.5" font-family="JetBrains Mono" font-weight="700" fill="var(--muted)">${opts.title}</text>` : '';
    c.forEach((cell, i) => { const r = Math.floor(i / cols), col = i % cols; const cx = x + col * (cw + 4), cy = y + r * (ch + 4);
      const occ = cell && cell.by != null;
      g += `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="4" fill="${occ ? (cell.color || C.blue) : 'var(--panel)'}" opacity="${occ ? 0.85 : 1}" stroke="${occ ? (cell.color || C.blue) : 'var(--line)'}" stroke-width="1.2"/>`;
      g += `<text x="${(cx + cw / 2).toFixed(1)}" y="${(cy + ch / 2 + 3.5).toFixed(1)}" text-anchor="middle" font-size="9" font-family="JetBrains Mono" font-weight="700" fill="${occ ? '#0b0e14' : 'var(--faint)'}">${occ ? cell.by : '비어'}</text>`;
      g += `<text x="${cx + 2}" y="${cy + 9}" font-size="7" font-family="JetBrains Mono" fill="${occ ? '#0b0e14' : 'var(--faint)'}">F${i}</text>`;
    });
    return g;
  }

  // ---- TLB (변환 캐시) ----
  function tlb(x, y, entries, opts = {}) {
    const e = entries || [], rh = 20, w = opts.w || 120;
    let g = `<text x="${x + w / 2}" y="${y - 6}" text-anchor="middle" font-size="9.5" font-family="JetBrains Mono" fill="${C.hot}">${opts.title || 'TLB (캐시)'}</text>`;
    e.forEach((row, i) => { const ry = y + i * rh, hot = opts.hl === i;
      g += `<rect x="${x}" y="${ry}" width="${w}" height="${rh - 2}" rx="3" fill="${hot ? 'rgba(251,191,36,0.18)' : 'var(--panel)'}" stroke="${hot ? C.hot : 'var(--line)'}" stroke-width="${hot ? 1.8 : 1}"/>`;
      g += `<text x="${x + 8}" y="${ry + 14}" font-size="9.5" font-family="JetBrains Mono" fill="var(--q)">P${row.v}</text>`;
      g += `<text x="${x + w - 8}" y="${ry + 14}" text-anchor="end" font-size="9.5" font-family="JetBrains Mono" fill="var(--good)">F${row.f}</text>`;
    });
    return g;
  }

  // ---- 디스크 ----
  function disk(x, y, opts = {}) {
    const w = opts.w || 70, h = opts.h || 44;
    let g = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="var(--panel)" stroke="${C.disk}" stroke-width="1.5"/>`;
    g += `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2 - 10}" ry="${h / 2 - 10}" fill="none" stroke="${C.disk}" stroke-width="1"/><circle cx="${x + w / 2}" cy="${y + h / 2}" r="3" fill="${C.disk}"/>`;
    g += `<text x="${x + w / 2}" y="${y + h + 12}" text-anchor="middle" font-size="9" font-family="JetBrains Mono" fill="${C.disk}">${opts.label || '디스크(느림)'}</text>`;
    return g;
  }

  // ---- inode + 블록 포인터 ----
  function inode(x, y, opts = {}) {
    const w = opts.w || 110, meta = opts.meta || [['크기', '4KB'], ['권한', 'rw-'], ['소유', 'me']];
    const h = 26 + meta.length * 14;
    let g = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="var(--panel)" stroke="${C.q}" stroke-width="1.5"/>`;
    g += `<text x="${x + 10}" y="${y + 16}" font-size="10.5" font-family="JetBrains Mono" font-weight="700" fill="${C.q}">inode ${opts.label || ''}</text>`;
    meta.forEach((m, i) => { const ry = y + 32 + i * 14; g += `<text x="${x + 10}" y="${ry}" font-size="8.5" font-family="JetBrains Mono" fill="var(--muted)">${m[0]}</text><text x="${x + w - 10}" y="${ry}" text-anchor="end" font-size="8.5" font-family="JetBrains Mono" fill="var(--ink)">${m[1]}</text>`; });
    return g;
  }
  function blocks(x, y, n, opts = {}) {
    const cw = opts.cw || 30, ch = opts.ch || 24, on = opts.on || [];
    let g = opts.title != null ? `<text x="${x}" y="${y - 6}" font-size="9" font-family="JetBrains Mono" fill="var(--muted)">${opts.title}</text>` : '';
    for (let i = 0; i < n; i++) { const cx = x + i * (cw + 3); const used = on.includes(i);
      g += `<rect x="${cx}" y="${y}" width="${cw}" height="${ch}" rx="3" fill="${used ? C.q : 'var(--panel)'}" opacity="${used ? 0.85 : 1}" stroke="${used ? C.q : 'var(--line)'}" stroke-width="1.1"/>`;
      g += `<text x="${cx + cw / 2}" y="${y + ch / 2 + 3}" text-anchor="middle" font-size="8" font-family="JetBrains Mono" fill="${used ? '#0b0e14' : 'var(--faint)'}">${i}</text>`; }
    return g;
  }

  // ---- 비교 카드 ----
  function card(x, y, w, title, rows, opts = {}) {
    const h = opts.h || (28 + rows.length * 18), col = opts.color || C.q;
    let g = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="var(--panel)" stroke="${col}" stroke-width="1.6"/>`;
    g += `<text x="${x + 12}" y="${y + 19}" font-size="12" font-family="'Pretendard'" font-weight="700" fill="${col}">${title}</text>`;
    rows.forEach((r, i) => { const ry = y + 36 + i * 18; g += `<text x="${x + 12}" y="${ry}" font-size="9.5" font-family="JetBrains Mono" fill="var(--muted)">${r[0]}</text><text x="${x + w - 12}" y="${ry}" text-anchor="end" font-size="9.5" font-family="JetBrains Mono" fill="var(--ink)">${r[1]}</text>`; });
    return g;
  }

  VZ.OS = { C, svg, rng, num, stateCol, chip, arrow, interrupt, proc, queue, gantt, pcb, boundary, addrSpace, pageTable, frames, tlb, disk, inode, blocks, card, heat };
})(window);
