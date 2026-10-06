export function createScheduler(ids: string[]) {
  let idx = 0;
  const list = [...ids];

  return {
    next(): string | null {
      if (list.length === 0) return null;
      const id = list[idx % list.length]!;
      idx = (idx + 1) % list.length;
      return id;
    },
    add(id: string) {
      if (!list.includes(id)) list.push(id);
    },
    remove(id: string) {
      const i = list.indexOf(id);
      if (i !== -1) list.splice(i, 1);
    },
    get ids() {
      return [...list];
    },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
