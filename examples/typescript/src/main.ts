import { TodoList } from './todos';
import { pluralize } from './utils/format.js'; // TypeScript convention: the file is format.ts
import type { Todo } from './types';

const list = new TodoList();
const form = document.querySelector<HTMLFormElement>('#add')!;
const ul = document.querySelector<HTMLUListElement>('#list')!;
const summary = document.querySelector<HTMLParagraphElement>('#summary')!;

function render(todos: readonly Todo[]): void {
  ul.replaceChildren(
    ...todos.map((todo) => {
      const li = document.createElement('li');
      li.textContent = todo.title;
      li.classList.toggle('done', todo.done);
      li.addEventListener('click', () => render(list.toggle(todo.id)));
      return li;
    }),
  );
  const pending = todos.filter((t) => !t.done).length;
  summary.textContent = `${pending} ${pluralize(pending, 'task')} left`;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  render(list.add(String(data.get('title'))));
  form.reset();
});

render(list.all());
