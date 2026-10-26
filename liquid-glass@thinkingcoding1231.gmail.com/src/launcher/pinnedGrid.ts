export interface PinnedGrid {
  columns: number;
  // Of every tile, which share the row's width evenly.
  tile: number;
}

/**
 * The columns of the pinned page for a row `width` wide. A tile is as wide as its icon plus the room the pin in
 * its corner needs at each side, and the tiles grow to use up what is left over.
 */
export function pinnedGrid(width: number, iconSize: number, gap: number, sideRoom: number): PinnedGrid {
  const least = iconSize + sideRoom * 2;
  const columns = Math.max(1, Math.floor((width + gap) / (least + gap)));
  return { columns, tile: Math.floor((width - gap * (columns - 1)) / columns) };
}
