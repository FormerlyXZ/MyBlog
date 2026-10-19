/**
 * 导航页的前端筛选
 * ============================================================
 * 两种筛选叠加生效：
 *   · 分类 chips（data-link-filter="分类名"）
 *   · 关键词输入（data-link-search）
 *
 * 纯前端过滤，不请求任何接口；同时把结果数量写到提示行。
 */

import { onPageLoad } from './pageload';

function initNavFilter(): void {
  const root = document.querySelector<HTMLElement>('[data-link-page]');
  if (!root) return;

  const cards = [...root.querySelectorAll<HTMLElement>('[data-link-item]')];
  const groups = [...root.querySelectorAll<HTMLElement>('[data-link-group]')];
  const chips = [...root.querySelectorAll<HTMLElement>('[data-link-filter]')];
  const input = root.querySelector<HTMLInputElement>('[data-link-search]');
  const counter = root.querySelector<HTMLElement>('[data-link-count]');
  const empty = root.querySelector<HTMLElement>('[data-link-empty]');

  let activeCategory = '全部';

  /** 记录每张卡片的可搜索文本 */
  const haystack = new Map<HTMLElement, string>();
  for (const card of cards) {
    haystack.set(card, (card.textContent ?? '').toLowerCase());
  }

  const apply = () => {
    const keyword = (input?.value ?? '').trim().toLowerCase();
    let shown = 0;

    for (const card of cards) {
      const category = card.dataset.linkCategory ?? '';
      const matchCategory = activeCategory === '全部' || category === activeCategory;
      const matchKeyword = !keyword || (haystack.get(card) ?? '').includes(keyword);
      const visible = matchCategory && matchKeyword;
      card.hidden = !visible;
      if (visible) shown += 1;
    }

    // 分组里一个都不剩就把整组标题藏起来
    for (const group of groups) {
      const any = [...group.querySelectorAll<HTMLElement>('[data-link-item]')].some((el) => !el.hidden);
      group.hidden = !any;
    }

    if (counter) counter.textContent = String(shown);
    if (empty) empty.hidden = shown !== 0;
  };

  // 分类 chips
  for (const chip of chips) {
    if (chip.dataset.bound === '1') continue;
    chip.dataset.bound = '1';
    chip.addEventListener('click', () => {
      activeCategory = chip.dataset.linkFilter || '全部';
      for (const other of chips) {
        other.setAttribute('aria-pressed', String(other === chip));
      }
      apply();
    });
  }

  // 关键词输入
  if (input && input.dataset.bound !== '1') {
    input.dataset.bound = '1';
    input.addEventListener('input', apply);
  }

  // 初始状态：先把「全部」标为选中
  for (const chip of chips) {
    chip.setAttribute('aria-pressed', String((chip.dataset.linkFilter || '') === '全部'));
  }

  apply();
}

onPageLoad(initNavFilter);
