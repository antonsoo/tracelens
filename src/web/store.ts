// A tiny observable store — the whole app is small enough that a real
// state library would be more ceremony than the problem needs. `set`
// shallow-merges and notifies; components subscribe and re-render
// themselves (no vdom diffing — each component owns a DOM subtree it
// clears and rebuilds on change, which is fast enough at this data size).
export class Store<T extends object> {
  private state: T;
  private listeners = new Set<(state: T) => void>();

  constructor(initial: T) {
    this.state = initial;
  }

  get(): T {
    return this.state;
  }

  set(patch: Partial<T>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  subscribe(listener: (state: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
