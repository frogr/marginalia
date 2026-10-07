// Reciprocal rank fusion (Cormack et al., 2009): score(d) = sum over lists of
// 1 / (k + rank), with rank starting at 1. It needs no score calibration
// between BM25 and cosine similarity, which is why it is used here.

export interface Ranked {
  id: string;
}

export interface Fused {
  id: string;
  score: number;
  /** 1-based rank of this id in each input list, or null if absent. */
  ranks: (number | null)[];
}

export function rrf(lists: Ranked[][], k = 60): Fused[] {
  const byId = new Map<string, Fused>();
  lists.forEach((list, li) => {
    list.forEach((item, i) => {
      let f = byId.get(item.id);
      if (!f) byId.set(item.id, (f = { id: item.id, score: 0, ranks: lists.map(() => null) }));
      if (f.ranks[li] !== null) return; // count only the first occurrence per list
      f.ranks[li] = i + 1;
      f.score += 1 / (k + i + 1);
    });
  });
  return [...byId.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
