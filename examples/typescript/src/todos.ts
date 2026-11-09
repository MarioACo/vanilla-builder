import type { Todo } from './types';

export class TodoList {
  #todos: Todo[] = [];
  #nextId = 1;

  all(): readonly Todo[] {
    return this.#todos;
  }

  add(title: string): readonly Todo[] {
    this.#todos = [...this.#todos, { id: this.#nextId++, title, done: false }];
    return this.#todos;
  }

  toggle(id: number): readonly Todo[] {
    this.#todos = this.#todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
    return this.#todos;
  }
}
