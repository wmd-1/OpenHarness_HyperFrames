// 个人空间分页纯函数（demo spacePageSize=6，供单测）。

export const SPACE_PAGE_SIZE = 6;

export function pageCount(total: number, pageSize = SPACE_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** 取第 page 页（1 起始）切片；越界页返回空数组。 */
export function pageSlice<T>(items: readonly T[], page: number, pageSize = SPACE_PAGE_SIZE): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
